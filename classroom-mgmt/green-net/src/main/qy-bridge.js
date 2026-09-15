'use strict';
// =============================================================================
// 全域（ICTClass 课堂管理系统）对接桥
//
// 对接依据（附带的项目文档）：
//   · 04_接口设计文档.md    —— 信封结构 / 主题规划 / QoS / 错误码 E-CONN-01
//   · 02_系统架构设计文档.md —— 通信机制、断线重连指数退避 1s→30s
//   · 07_功能联动与状态流转设计.md —— cmd policy（锁定策略）/ cmd task / cmd task_timer
//   · 10_全域学生桌面v5_设计方案.md —— 绿网作为「课程应用」被全域桌面拉起
//
// 角色定位：绿网是同一台机器上的**第二个学生侧 MQTT 客户端**（第一个是全域学生端壳）。
//   只订阅（读）教师广播指令，把课堂状态映射为浏览器行为：
//     cmd policy{locked:true}  →  全屏锁定，禁止上网（回首页 + 禁用地址栏）
//     cmd policy{locked:false} →  解锁
//     cmd task{...}            →  顶部活动条（标题 + 倒计时）
//     cmd task_timer{...}      →  暂停/恢复/调整/截止
//     cmd end                  →  解锁（可选：自动关闭浏览器）
//     cmd reset                →  解锁并回首页
//   只有一处上行：ict_hb 心跳（type=status，QoS0），用于让教师端知道本机浏览器仍在线。
//
// 主题常量复用 classroom-mgmt/shared/topics.js（单一真源，禁止各端自行硬编码）。
// =============================================================================
const U = require('./util');

const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];

function loadTopics() {
  const candidates = ['../shared/topics', '../shared/topics.js'];
  for (const c of candidates) {
    try { return require(c); } catch (_e) { /* try next */ }
  }
  // 兜底：契约文件缺失时用与 topics.js 一致的物理常量，保证功能不中断
  return {
    CMD_BROADCAST: 'siot/ict_cmd',
    STU_UP: 'siot/ict_up',
    STU_HB: 'siot/ict_hb',
    SYNC: 'siot/ict_sync',
    genId: () => 'rnet-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
  };
}

// ---------------------------------------------------------------------------
// 纯函数：把教师端下行信封翻译成"浏览器要做的事"
// 单独抽出来是为了能脱离 MQTT 连接做单元测试（协议映射最容易写错，也最该被覆盖）。
// 返回 null 表示不是指令信封。
// ---------------------------------------------------------------------------
function interpretCommand(env) {
  if (!env || env.type !== 'cmd') return null;
  const p = env.payload || {};
  const action = String(p.action || '');
  switch (action) {
    case 'policy':
      return {
        kind: 'policy',
        locked: !!p.locked,
        mode: p.mode || 'open',
        reason: p.reason || '',
        phase: p.phase || null,
      };
    case 'task':
      return {
        kind: 'task',
        task: {
          taskId: p.taskId || null,
          title: U.str(p.title, 80),
          desc: U.str(p.desc, 200),
          source: p.source || '',
          timed: !!p.timed,
          durationSec: p.durationSec != null ? Number(p.durationSec) : null,
          timerState: p.timerState || 'idle',
          remainingMs: p.remainingMs != null ? Number(p.remainingMs) : null,
        },
      };
    case 'task_timer':
      // ★ 字段名是 timerAction，不是 action —— payload.action 已被 makeCommand 占为 'task_timer'。
      //   教师端 activity.service.js: bridge.publishCommand('task_timer', {taskId, timerAction, remainingMs, durationSec})
      //   学生端 control.js:      const action = p.timerAction || 'sync'
      return {
        kind: 'timer',
        action: String(p.timerAction || (p.action && p.action !== 'task_timer' ? p.action : '') || ''),
        taskId: p.taskId || null,
        remainingMs: p.remainingMs != null ? Number(p.remainingMs) : null,
        durationSec: p.durationSec != null ? Number(p.durationSec) : null,
      };
    case 'start': return { kind: 'phase', phase: 'checkin' };
    case 'end': return { kind: 'end', phase: 'return' };
    case 'reset': return { kind: 'reset' };
    case 'shutdown': return { kind: 'shutdown', delaySec: Number(p.delaySec) || 10 };
    default: return { kind: 'ignore', action };
  }
}

// 计时器状态推进（纯函数，独立可测）
function applyTimerAction(task, action, remainingMs) {
  if (!task) return null;
  const next = Object.assign({}, task);
  if (remainingMs != null && Number.isFinite(Number(remainingMs))) next.remainingMs = Number(remainingMs);
  if (action === 'pause') next.timerState = 'paused';
  else if (action === 'resume' || action === 'adjust' || action === 'restart') next.timerState = 'running';
  else if (action === 'expired') { next.timerState = 'expired'; next.remainingMs = 0; }
  else if (action === 'stop' || action === 'close') next.timerState = 'closed';
  return next;
}

function createQyBridge(deps) {
  const { getConfig, logger, onEvent } = deps;
  const topics = loadTopics();

  let mqtt = null;
  let mqttErr = '';
  try {
    // eslint-disable-next-line global-require
    mqtt = require('mqtt');
  } catch (e) {
    mqttErr = String(e.message || e);
  }

  let client = null;
  let state = 'off';        // off | connecting | online | backoff | error | no-mqtt
  let detail = '';
  let backoffIdx = 0;
  let retryTimer = null;
  let hbTimer = null;
  let started = false;

  // 课堂态快照（供 gnet://qy 页面与工具栏显示）
  let phase = null;
  let policy = { mode: 'open', locked: false, reason: '', phase: null };
  let task = null;      // {taskId,title,desc,timed,durationSec,timerState,remainingMs}
  let lastMsgAt = 0;
  let msgCount = 0;

  function emit(type, payload) {
    if (onEvent) { try { onEvent(Object.assign({ type, at: Date.now() }, payload || {})); } catch (_e) { /* noop */ } }
  }

  function setState(next, why) {
    const changed = state !== next || detail !== (why || '');
    state = next;
    detail = why || '';
    if (changed) {
      if (logger) logger.info(`全域链路状态：${next}${detail ? '（' + detail + '）' : ''}`);
      emit('state', { state, detail, brokerUrl: brokerUrl() });
    }
  }

  function brokerUrl() {
    const q = getConfig().qy;
    return `mqtt://${q.host}:${q.port}`;
  }

  function clientId() {
    const cfg = getConfig();
    const mid = cfg.machineId || 'nomachine';
    return `RNET_${mid}`.slice(0, 60);
  }

  // ---- 下行指令处理（解析走纯函数，这里只做状态落地与事件派发）----
  function handleCommand(env) {
    const cmd = interpretCommand(env);
    if (!cmd || cmd.kind === 'ignore') return;
    lastMsgAt = Date.now();
    msgCount += 1;
    switch (cmd.kind) {
      case 'policy': {
        policy = { mode: cmd.mode, locked: cmd.locked, reason: cmd.reason, phase: cmd.phase || phase };
        if (logger) logger.info(`收到 policy：locked=${policy.locked} mode=${policy.mode} reason=${policy.reason}`);
        emit('policy', policy);
        break;
      }
      case 'task': {
        task = cmd.task;
        phase = 'task';
        emit('task', { task, phase });
        break;
      }
      case 'timer': {
        const before = task;
        task = applyTimerAction(task, cmd.action, cmd.remainingMs);
        if (task && cmd.durationSec != null) { task.durationSec = cmd.durationSec; task.timed = true; }
        if (logger) logger.info(`收到 task_timer：${cmd.action}${cmd.remainingMs != null ? ' remaining=' + cmd.remainingMs : ''}`);
        emit('timer', { taskId: cmd.taskId, action: cmd.action, remainingMs: cmd.remainingMs, task, changed: before !== task });
        break;
      }
      case 'phase': {
        phase = cmd.phase;
        policy = Object.assign({}, policy, { locked: false, phase });
        emit('phase', { phase, policy });
        break;
      }
      case 'end': {
        phase = 'return';
        policy = Object.assign({}, policy, { locked: false, phase: 'return' });
        task = null;
        emit('phase', { phase, policy });
        emit('end', { phase });
        break;
      }
      case 'reset': {
        phase = null;
        task = null;
        policy = Object.assign({}, policy, { locked: false, phase: null });
        emit('phase', { phase: null, policy });
        emit('reset', {});
        break;
      }
      case 'shutdown': {
        // 关机由全域学生端负责执行；绿网只做"即将关机"提示，避免两处同时下发关机命令
        if (logger) logger.warn('收到 shutdown（绿网不执行关机，仅提示）');
        emit('shutdown', { delaySec: cmd.delaySec });
        break;
      }
      default:
        break;
    }
  }

  function handleSync(env) {
    if (!env || env.type !== 'sync') return;
    const p = env.payload || {};
    const cfg = getConfig();

    // ★ 座位过滤：seat 在**信封顶层**，不在 payload 里。
    //   依据：教师端 bridge.js publishSync() → topics.makeSync({ seat, ... })
    //        而 makeSync 把 seat 写进 env.seat；payload 只有
    //        {sessionId, phase, currentTask, checkinDone, returnDone, equipment, policy}。
    //   核心学生端 downlink.js 的写法是 `if (String(env.seat) !== state.seat) return;`。
    //
    //   踩坑记录：早期这里读的是 p.seat（payload.seat），而它恒为 undefined，
    //   于是过滤条件 `p.seat && …` 恒为假 —— **过滤从未生效**。
    //   后果：教师端逐个学生回 sync 时，A 座位的 phase/policy 会被 B 座位的绿网也应用，
    //   整间机房的状态互相覆盖；由于是"能跑但不对"，非常难在现场定位。
    //   集成测试 test/qy-mqtt.integration.js 场景 7 专门钉住这一条（负向用例）。
    const mySeat = String(cfg.seat == null ? '' : cfg.seat).trim();
    const envSeat = String(env.seat == null ? '' : env.seat).trim();
    const isBroadcast = envSeat === '*';
    if (!isBroadcast && envSeat !== mySeat) {
      if (!mySeat && logger) {
        // 只提示一次级别的问题：没配座位号就收不到逐生 sync
        logger.warn('收到座位为 "' + envSeat + '" 的 sync，但本机未配置座位号 → 已忽略；'
          + '如需逐生状态同步，请在管理页设置座位号。');
      }
      return;
    }

    msgCount += 1;
    lastMsgAt = Date.now();
    if (p.policy) {
      policy = {
        mode: p.policy.mode || 'open', locked: !!p.policy.locked,
        reason: p.policy.reason || '', phase: p.policy.phase || null,
      };
      emit('policy', policy);
    }
    if (p.phase !== undefined) { phase = p.phase; emit('phase', { phase, policy }); }
    if (p.currentTask) {
      task = Object.assign({}, p.currentTask);
      emit('task', { task, phase });
    } else if (p.currentTask === null) {
      task = null;
      emit('task', { task: null, phase });
    }
  }

  // ---- 连接生命周期 --------------------------------------------------------
  function scheduleReconnect() {
    if (retryTimer) return;
    const base = BACKOFF[Math.min(backoffIdx, BACKOFF.length - 1)];
    const delay = base + Math.floor(Math.random() * 300);
    backoffIdx += 1;
    setState('backoff', `${Math.round(delay / 1000)}s 后重试`);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
    if (retryTimer.unref) retryTimer.unref();
  }

  function stopHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  }

  function startHeartbeat() {
    stopHeartbeat();
    const cfg = getConfig();
    if (!cfg.qy.reportHeartbeat) return;
    if (!cfg.seat) return; // 没有座位号就不上报，避免教师端把它算成未知座位
    const period = Math.max(5, cfg.qy.heartbeatSec) * 1000;
    const beat = () => {
      if (!client || state !== 'online') return;
      const env = {
        msgId: topics.genId(), ts: Date.now(), type: 'status',
        seat: String(getConfig().seat), group: '*',
        machineId: getConfig().machineId,
        payload: { online: true, app: 'green-net', role: 'browser' },
      };
      try { client.publish(topics.STU_HB, JSON.stringify(env), { qos: 0 }); } catch (_e) { /* noop */ }
    };
    beat();
    hbTimer = setInterval(beat, period);
    if (hbTimer.unref) hbTimer.unref();
  }

  function connect() {
    if (!started) return;
    const cfg = getConfig();
    if (!cfg.qy.enabled) { setState('off', '配置中未启用全域联动'); return; }
    if (!mqtt) { setState('no-mqtt', `未安装 mqtt 依赖：${mqttErr}`); return; }

    if (client) { try { client.end(true); } catch (_e) { /* noop */ } client = null; }

    setState('connecting', brokerUrl());
    const opts = {
      clientId: clientId(),
      username: cfg.qy.username,
      password: cfg.qy.password,
      keepalive: 30,
      clean: true,
      reconnectPeriod: 0,   // 自管退避（与教师端一致）
      connectTimeout: 8000,
      protocolVersion: 4,
    };
    try {
      client = mqtt.connect(brokerUrl(), opts);
    } catch (e) {
      setState('error', String(e.message || e));
      scheduleReconnect();
      return;
    }

    client.on('connect', () => {
      backoffIdx = 0;
      setState('online', '');
      client.subscribe([topics.CMD_BROADCAST, topics.SYNC], { qos: 1 }, (err) => {
        if (err && logger) logger.warn('订阅失败：' + err.message);
        if (logger) logger.info(`已订阅 ${topics.CMD_BROADCAST} / ${topics.SYNC}`);
      });
      startHeartbeat();
      emit('connected', { brokerUrl: brokerUrl(), clientId: clientId() });
    });

    client.on('message', (topic, buf) => {
      let env = null;
      try { env = JSON.parse(buf.toString()); } catch (_e) { return; } // 坏消息不打断消息流
      if (topic === topics.CMD_BROADCAST) { handleCommand(env); return; }
      if (topic === topics.SYNC) { handleSync(env); }
    });

    client.on('error', (err) => {
      if (logger) logger.warn('全域 MQTT error：' + (err && err.message));
      if (state === 'online') setState('backoff', '连接中断');
    });

    client.on('close', () => {
      if (!started) return;
      stopHeartbeat();
      if (state === 'online' || state === 'connecting') setState('backoff', '连接已断开');
      scheduleReconnect();
    });
  }

  function start() {
    started = true;
    connect();
  }

  function stop() {
    started = false;
    stopHeartbeat();
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (client) { try { client.end(true); } catch (_e) { /* noop */ } client = null; }
    setState('off', '已停止');
  }

  // 配置变更后重启链路（教师改 broker 地址不用重启整个浏览器）
  function restart() {
    stop();
    backoffIdx = 0;
    setTimeout(start, 200);
  }

  function snapshot() {
    const cfg = getConfig();
    return {
      state, detail, brokerUrl: brokerUrl(), clientId: clientId(),
      enabled: cfg.qy.enabled, topics: { cmd: topics.CMD_BROADCAST, hb: topics.STU_HB, sync: topics.SYNC },
      phase, policy, task, msgCount, lastMsgAt,
      reportHeartbeat: cfg.qy.reportHeartbeat, seat: cfg.seat,
    };
  }

  return { start, stop, restart, snapshot, TOPICS: topics, isOnline: () => state === 'online' };
}

module.exports = { createQyBridge, interpretCommand, applyTimerAction, BACKOFF, loadTopics };
