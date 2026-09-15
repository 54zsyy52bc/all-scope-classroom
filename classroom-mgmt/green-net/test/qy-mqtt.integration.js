'use strict';
// =============================================================================
// 全域链路「真机联调」集成测试
//
// 与 test/*.test.js 的区别（为什么必须有这一层）：
//   单元测试只覆盖 qy-bridge 的纯函数（interpretCommand / applyTimerAction），
//   它证明不了"接线是对的"——比如 subscribe 的话题名写错、clientId 冲突、
//   心跳条件判断反了、seat 过滤漏了，这些在纯函数里全绿，在现场全废。
//   所以这里连**真的 MQTT broker**（本机 SIoT 1883），
//   用一个"教师端模拟器"真收真发，逐条校验协议行为。
//
// 依赖：本机 SIoT 正在运行（SIoT_V2_Win_2618/main.exe）。
//       若探测不到 broker → 打印 SKIPPED 并以 0 退出（不阻塞 CI）。
//
// 运行：node test/qy-mqtt.integration.js
// =============================================================================
const net = require('node:net');
const path = require('node:path');

const BROKER = { host: '127.0.0.1', port: 1883, username: 'siot', password: 'dfrobot' };
const SEAT = '01';
// 固定的测试身份（合法的 M-xxxxxxxx 形态），避免与真机 machineId 撞车
const MACHINE_ID = 'M-aaaa0001';
const MACHINE_ID_2 = 'M-aaaa0002';

const { createQyBridge, loadTopics } = require('../src/main/qy-bridge');
const topics = loadTopics();

// ---- 极简异步断言 ---------------------------------------------------------
let pass = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass += 1; process.stdout.write('.'); return true; }
  fails.push(msg);
  process.stdout.write('F');
  return false;
}
function eq(a, b, msg) {
  return ok(a === b, `${msg}\n    实际: ${JSON.stringify(a)}\n    期望: ${JSON.stringify(b)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probeBroker() {
  return new Promise((resolve) => {
    const s = net.connect({ host: BROKER.host, port: BROKER.port });
    const done = (v) => { try { s.destroy(); } catch (_e) { /* noop */ } resolve(v); };
    s.setTimeout(1500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function main() {
  console.log('绿网 · 全域链路集成测试（真 broker）');
  console.log(`broker = mqtt://${BROKER.host}:${BROKER.port}  seat=${SEAT}  machineId=${MACHINE_ID}`);

  if (!(await probeBroker())) {
    console.log(`\nSKIPPED：${BROKER.host}:${BROKER.port} 上没有 MQTT broker。`);
    console.log('  要跑这条集成测试，请先启动 SIoT：');
    console.log('    cd SIoT_V2_Win_2618/SIoT_V2_Win_2618 && ./main.exe -c conf/config.json');
    process.exit(0);
  }

  // eslint-disable-next-line global-require
  const mqtt = require('mqtt');
  // eslint-disable-next-line global-require
  const harnessTopics = require(path.join(__dirname, '..', 'src', 'shared', 'topics.js'));

  // ---- 教师端模拟器：先连上并订阅上行，再启动浏览器侧桥接 ----
  const teacher = mqtt.connect(`mqtt://${BROKER.host}:${BROKER.port}`, {
    clientId: 'TEST_TEACHER_' + Math.random().toString(36).slice(2, 8),
    username: BROKER.username, password: BROKER.password,
    clean: true, reconnectPeriod: 0, connectTimeout: 8000, protocolVersion: 4,
  });

  const teacherHeard = { hb: [], up: [] };
  teacher.on('message', (topic, buf) => {
    let env = null;
    try { env = JSON.parse(buf.toString()); } catch (_e) { return; }
    if (topic === harnessTopics.STU_HB) teacherHeard.hb.push(env);
    else if (topic === harnessTopics.STU_UP) teacherHeard.up.push(env);
  });

  const teacherReady = await new Promise((resolve) => {
    teacher.once('connect', () => {
      teacher.subscribe([harnessTopics.STU_HB, harnessTopics.STU_UP], { qos: 1 }, () => resolve(true));
    });
    teacher.once('error', (e) => { console.log('  教师端模拟器连接失败：' + e.message); resolve(false); });
    setTimeout(() => resolve(false), 8000);
  });
  ok(teacherReady, '教师端模拟器应能连上 broker 并订阅上行话题');
  if (!teacherReady) { finish(teacher, null); return; }

  // ---- 浏览器侧桥接（用假配置，绝不动 app-config.json）----
  const events = [];
  const fakeCfg = {
    machineId: MACHINE_ID,
    seat: SEAT,
    qy: {
      enabled: true, host: BROKER.host, port: BROKER.port,
      username: BROKER.username, password: BROKER.password,
      reportHeartbeat: true, heartbeatSec: 5,
      lockOnPolicy: true, closeOnEnd: false,
    },
  };
  const bridge = createQyBridge({
    getConfig: () => JSON.parse(JSON.stringify(fakeCfg)),
    logger: null,
    onEvent: (ev) => events.push(ev),
  });
  bridge.start();

  // 等链路在线（真实握手，最多 8s）
  let online = false;
  for (let i = 0; i < 40; i += 1) {
    if (bridge.isOnline()) { online = true; break; }
    await sleep(200);
  }
  ok(online, `桥接应能连上 broker（当前 state=${bridge.snapshot().state}）`);
  if (!online) { finish(teacher, bridge); return; }

  const pub = (topic, env) => teacher.publish(topic, JSON.stringify(env), { qos: 1 });
  const lastEvent = (type) => [...events].reverse().find((e) => e.type === type);

  // === 场景 1：教师下发 policy → 锁定 =====================================
  pub(topics.CMD_BROADCAST, harnessTopics.makeCommand({
    action: 'policy',
    payload: { mode: 'locked', locked: true, reason: '课堂进行中', phase: 'task' },
  }));
  await sleep(600);
  {
    const ev = lastEvent('policy');
    ok(ev, '收到 policy 指令应触发 policy 事件');
    if (ev) {
      eq(ev.locked, true, 'policy.locked 应为 true');
      eq(ev.mode, 'locked', 'policy.mode 应原样透传');
      eq(ev.reason, '课堂进行中', 'policy.reason 应原样透传');
      eq(ev.phase, 'task', 'policy.phase 应原样透传');
    }
    const s = bridge.snapshot();
    eq(s.policy.locked, true, '快照里 policy.locked 应为 true（供 gnet://qy 页显示）');
  }

  // === 场景 2：教师下发 task（带计时）=====================================
  pub(topics.CMD_BROADCAST, harnessTopics.makeCommand({
    action: 'task',
    payload: {
      taskId: 'T-DEMO', title: '搭建智能小车', desc: '用行空板采集温度并上传',
      source: 'activity', timed: true, durationSec: 300,
      timerState: 'running', remainingMs: 300000,
    },
  }));
  await sleep(600);
  {
    const s = bridge.snapshot();
    ok(s.task, '收到 task 后快照里应有当前活动');
    if (s.task) {
      eq(s.task.taskId, 'T-DEMO', 'task.taskId 应一致');
      eq(s.task.title, '搭建智能小车', 'task.title 应一致');
      eq(s.task.timed, true, 'task.timed 应为 true');
      eq(s.task.durationSec, 300, 'task.durationSec 应为 300');
      eq(s.task.remainingMs, 300000, 'task.remainingMs 应为 300000');
    }
    eq(s.phase, 'task', '收到 task 后 phase 应切到 task');
  }

  // === 场景 3：task_timer 暂停（★ 字段名陷阱回归测试）====================
  // 教师端 activity.service.js 发的是 { taskId, timerAction, remainingMs }，
  // 子动作在 **payload.timerAction** 而不是 payload.action
  //（payload.action 已被 makeCommand 固定成 'task_timer'）。
  // 早期版本读错字段 → 暂停/恢复全部静默失效，这里专门钉住它。
  pub(topics.CMD_BROADCAST, harnessTopics.makeCommand({
    action: 'task_timer',
    payload: { taskId: 'T-DEMO', timerAction: 'pause', remainingMs: 245000 },
  }));
  await sleep(600);
  {
    const ev = lastEvent('timer');
    ok(ev, '收到 task_timer 应触发 timer 事件');
    if (ev) {
      eq(ev.action, 'pause', '子动作应取自 payload.timerAction');
      eq(ev.remainingMs, 245000, 'task_timer.remainingMs 应一致');
    }
    const s = bridge.snapshot();
    eq(s.task && s.task.timerState, 'paused', '暂停后 timerState 应为 paused');
    eq(s.task && s.task.remainingMs, 245000, '暂停后 remainingMs 应更新');
  }

  // === 场景 4：task_timer 恢复 ============================================
  pub(topics.CMD_BROADCAST, harnessTopics.makeCommand({
    action: 'task_timer',
    payload: { taskId: 'T-DEMO', timerAction: 'resume' },
  }));
  await sleep(600);
  eq(bridge.snapshot().task && bridge.snapshot().task.timerState, 'running', '恢复后 timerState 应为 running');

  // === 场景 5：task_timer 到期 ============================================
  pub(topics.CMD_BROADCAST, harnessTopics.makeCommand({
    action: 'task_timer',
    payload: { taskId: 'T-DEMO', timerAction: 'expired' },
  }));
  await sleep(600);
  {
    const s = bridge.snapshot();
    eq(s.task && s.task.timerState, 'expired', '到期后 timerState 应为 expired');
    eq(s.task && s.task.remainingMs, 0, '到期后 remainingMs 应归零');
  }

  // === 场景 6：上游 sync 应答（座位匹配 → 生效）==========================
  pub(topics.SYNC, harnessTopics.makeSync({
    seat: SEAT, sessionId: 'S-IT-1', phase: 'return',
    currentTask: null,
    policy: { mode: 'open', locked: false, reason: '下课', phase: 'return' },
  }));
  await sleep(600);
  {
    const s = bridge.snapshot();
    eq(s.policy.locked, false, 'sync 应能解锁');
    eq(s.phase, 'return', 'sync 应能把 phase 切到 return');
    eq(s.task, null, 'sync 里 currentTask=null 应清空当前活动');
  }

  // === 场景 7：座位不匹配的 sync 必须被忽略（负向）=======================
  {
    const before = events.length;
    pub(topics.SYNC, harnessTopics.makeSync({
      seat: '99', sessionId: 'S-IT-1', phase: 'checkin',
      policy: { mode: 'locked', locked: true, reason: '别的座位' },
    }));
    await sleep(600);
    // 注意：handleSync 在座位不匹配时直接 return，不产生任何事件
    eq(events.length, before, `发给别座位的 sync 不应产生任何事件（本座 seat=${SEAT}）`);
    eq(bridge.snapshot().policy.locked, false, '别座位的 sync 不应把本机锁上');
  }

  // === 场景 8：坏消息不能打断消息流（负向）===============================
  teacher.publish(topics.CMD_BROADCAST, '这不是 JSON{{{', { qos: 1 });
  await sleep(400);
  pub(topics.CMD_BROADCAST, harnessTopics.makeCommand({
    action: 'policy', payload: { mode: 'locked', locked: true, reason: '坏消息之后仍要能工作' },
  }));
  await sleep(600);
  eq(bridge.snapshot().policy.locked, true, '收到坏消息后，后续指令仍应正常生效');
  ok(bridge.isOnline(), '收到坏消息后链路应保持在线');

  // === 场景 9：未知 action 应被安全忽略 ==================================
  {
    const before = events.length;
    pub(topics.CMD_BROADCAST, harnessTopics.makeCommand({ action: 'no_such_action', payload: { x: 1 } }));
    await sleep(500);
    eq(events.length, before, '未知 action 不应产生事件');
    ok(bridge.isOnline(), '未知 action 不应影响链路');
  }

  // === 场景 10：心跳上行（教师端能看到浏览器在线）========================
  {
    // startHeartbeat: reportHeartbeat=true 且 seat 非空 → 连上后立即发一次
    let hb = teacherHeard.hb.find((e) => e.machineId === MACHINE_ID);
    for (let i = 0; i < 15 && !hb; i += 1) { await sleep(200); hb = teacherHeard.hb.find((e) => e.machineId === MACHINE_ID); }
    ok(hb, 'reportHeartbeat=true 时教师端应收到 ict_hb 心跳');
    if (hb) {
      eq(hb.type, 'status', '心跳信封 type 应为 status');
      eq(String(hb.seat), SEAT, '心跳应携带本机座位号');
      eq(hb.machineId, MACHINE_ID, '心跳应携带本机 machineId');
      eq(hb.payload && hb.payload.app, 'green-net', '心跳 payload.app 应标识为 green-net');
      eq(hb.payload && hb.payload.role, 'browser', '心跳 payload.role 应为 browser');
    }
  }

  // === 场景 11：reportHeartbeat=false 时必须安静（负向，保护考勤）=======
  {
    // 老师明确要求：默认不上报心跳，避免绿网把"浏览器在线"混进考勤心跳流。
    const quietCfg = JSON.parse(JSON.stringify(fakeCfg));
    quietCfg.qy.reportHeartbeat = false;
    quietCfg.machineId = MACHINE_ID_2;
    const quietEvents = [];
    const quietBridge = createQyBridge({
      getConfig: () => JSON.parse(JSON.stringify(quietCfg)),
      logger: null,
      onEvent: (ev) => quietEvents.push(ev),
    });
    const hbBefore = teacherHeard.hb.length;
    quietBridge.start();
    for (let i = 0; i < 25 && !quietBridge.isOnline(); i += 1) await sleep(200);
    ok(quietBridge.isOnline(), '第二实例（心跳关闭）应能连上 broker');
    await sleep(1500);
    const quietHb = teacherHeard.hb.slice(hbBefore).filter((e) => e.machineId === MACHINE_ID_2);
    eq(quietHb.length, 0, 'reportHeartbeat=false 时不应发出任何心跳（否则会污染考勤）');
    quietBridge.stop();
  }

  finish(teacher, bridge);
}

function finish(teacher, bridge) {
  try { if (bridge) bridge.stop(); } catch (_e) { /* noop */ }
  setTimeout(() => {
    try { if (teacher) teacher.end(true); } catch (_e) { /* noop */ }
    process.stdout.write('\n');
    if (fails.length) {
      console.error(`✗ 集成测试失败：${fails.length} 项`);
      fails.forEach((m) => console.error('  - ' + m));
      process.exit(1);
    }
    console.log(`✅ 集成测试通过：${pass} 项断言（真实 MQTT 收发，含 4 项负向用例）`);
    process.exit(0);
  }, 300);
}

main().catch((e) => {
  console.error('集成测试异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
