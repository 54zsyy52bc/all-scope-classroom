'use strict';
// MQTT 消息处理：按 envelope.type 分发到业务处理，写 DB（msg_id 幂等），并发 SSE 事件。
// 仅解析与分发，不含复杂业务判断；具体写库/状态均在 services / db 层。
//
// 可靠性约定：
//   1) 事件标记（msg_id 幂等）与业务写入放进同一个事务。业务写入失败时整段回滚，
//      否则 msg_id 被"毒丸"占用，MQTT 重投后消息会被幂等逻辑永久丢弃。
//   2) SSE 广播一律在事务提交之后，避免回滚了还通知大屏。
//   3) 任何单条坏消息都不得打断整条消息流（dispatch 统一兜底，同步/异步都覆盖）。
const db = require('../db');
const sse = require('../sse');
const bridge = require('../mqtt/bridge');
const commandSvc = require('../services/command.service');
const taskSvc = require('../services/task.service');
const { seatNum, makeLogger } = require('../utils');
// 主题常量取单一真源：classroom-mgmt/shared/topics.js（教师端/学生端共用，禁止各端复制）
// 路径：teacher/src/mqtt/ → ../../../ = classroom-mgmt/ → shared/topics
const topics = require('../../../shared/topics');

const log = makeLogger(process.env.LOG_LEVEL || 'info');

const TASK_STATUS_VALUES = ['doing', 'done', 'help'];

// 座位范围守卫：seat 必须为 1-99 的两位数字；若已知本会话总座位数（正整数），
// 还须不超过该上限。越界报文一律忽略（不落库、不占 msg_id），
// 防止越界座位造出幻影学生/负 pending 统计。totalSeats 未知（如无头测试桩）时退化为 1-99 校验。
function seatInRange(seat, totalSeats) {
  const s = String(seat == null ? '' : seat);
  if (!/^\d{1,2}$/.test(s)) return false;
  const n = parseInt(s, 10);
  if (n < 1 || n > 99) return false;
  const total = Number(totalSeats);
  if (Number.isInteger(total) && total >= 1 && n > total) return false;
  return true;
}

function guardSeat(session, env, label) {
  if (!session) return false;
  if (!seatInRange(env.seat, session.total_seats)) {
    log.warn(`${label} 忽略：座位 ${String(env.seat)} 超出本会话范围 1-${session.total_seats} (E-VAL-01)`);
    return false;
  }
  return true;
}

function deriveGroup(seat) {
  const n = parseInt(seat, 10);
  const gs = require('../config').GROUP_SIZE || 5;
  return `G${Math.floor((n - 1) / gs) + 1}`;
}

function seatStateOf(sessionId, seat) {
  const s = db.getStudent(sessionId, seat);
  if (!s) return null;
  // 同 dashboard.service：冲突 = 同一座位出现 >1 个 machineId，而非存在冲突记录行
  const conflicts = db.queryConflicts();
  const conflict = conflicts.some((c) => c.seat === seat && (c.machineIds || []).length > 1);
  const tasks = db.listTasks(sessionId);
  let taskStatus = null;
  if (tasks.length) {
    const st = db.listTaskStatuses({ sessionId, taskId: tasks[tasks.length - 1].task_id })
      .filter((x) => x.seat === seat);
    if (st.length) taskStatus = st[0].status;
  }
  const online = s.last_seen_at != null && (Date.now() - s.last_seen_at) <= require('../config').OFFLINE_THRESHOLD_MS;
  return {
    seat: s.seat, groupId: s.group_id, name: s.name || null,
    checkinStatus: s.checkin_status, taskStatus, returnStatus: s.return_status,
    online, lastSeenAt: s.last_seen_at || null, conflict,
  };
}

function checkinStats(sessionId) {
  const students = db.queryStudents(sessionId).items;
  const total = students.length;
  const checkedIn = students.filter((s) => s.checkinStatus === 'done').length;
  return { checkedIn, pending: total - checkedIn, rate: total > 0 ? Number((checkedIn / total).toFixed(4)) : 0 };
}

function handleCheckin(env, rawTopic) {
  const session = db.getCurrentSession();
  if (!session) { log.warn('checkin 忽略：无进行中会话 (E-OFF-01)'); return; }
  const sessionId = session.session_id;
  if (!guardSeat(session, env, 'checkin')) return;
  const seat = seatNum(env.seat);
  const groupId = env.group || deriveGroup(seat);
  const p = env.payload || {};
  const machineId = env.machineId || p.machineId;

  let conflict = null;
  let dup = false;
  db.transaction(() => {
    const ev = db.insertEvent({
      session_id: sessionId, ts: env.ts, type: 'checkin', seat,
      detail: JSON.stringify(p), msg_id: env.msgId, raw_topic: rawTopic, qos: 1,
    });
    if (!ev.inserted) { dup = true; return; }
    db.recordCheckin({
      sessionId, seat, groupId, name: p.name, studentNo: p.studentNo,
      machineId, checkinTime: env.ts, equipments: p.equipments,
    });
    if (machineId) conflict = db.upsertConflict({ seat, machineId, ts: env.ts });
  });
  if (dup) { log.info('checkin 重复 msgId 忽略:', env.msgId); return; }

  // 事务提交后才广播
  if (conflict && conflict.isConflict) sse.publish('conflict.detected', conflict);

  const state = seatStateOf(sessionId, seat);
  sse.publish('student.checkin', Object.assign({}, state, { stats: checkinStats(sessionId) }));

  const eqMap = {};
  for (const e of db.queryEquipment()) eqMap[e.eq_id] = e.eq_name;
  for (const eq of (p.equipments || [])) {
    sse.publish('equipment.changed', {
      seat, groupId, eqId: eq.eqId, eqName: eqMap[eq.eqId] || eq.eqId, qty: eq.qty, action: 'borrow',
    });
  }
  log.info(`checkin 座位 ${seat} 姓名 ${p.name || ''}`);
}

function handleTaskStatus(env, rawTopic) {
  const session = db.getCurrentSession();
  if (!session) { log.warn('task 忽略：无进行中会话'); return; }
  const sessionId = session.session_id;
  if (!guardSeat(session, env, 'task')) return;
  const p = env.payload || {};
  const taskId = p.taskId;
  const status = p.status;
  const seat = seatNum(env.seat);
  if (!taskId || !TASK_STATUS_VALUES.includes(status)) {
    log.warn('task 校验失败 (E-VAL-01)');
    return;
  }

  // 前置校验必须早于事件落库：非法报文不应占用 msg_id，否则同 msgId 的合法重投会被幂等丢弃。
  // 同时防止孤儿 task_id 触发 t_task_status 外键违规。
  const task = db.getTask(taskId);
  if (!task) { log.warn('task 忽略：任务不存在 (E-REF-01)', taskId); return; }
  if (task.session_id !== sessionId) {
    log.warn('task 忽略：任务不属于当前会话 (E-REF-01)', taskId);
    return;
  }

  const groupId = env.group || deriveGroup(seat);
  let dup = false;
  db.transaction(() => {
    const ev = db.insertEvent({
      session_id: sessionId, ts: env.ts, type: 'task', seat,
      detail: JSON.stringify(p), msg_id: env.msgId, raw_topic: rawTopic, qos: 1,
    });
    if (!ev.inserted) { dup = true; return; }
    db.upsertTaskStatus({ taskId, seat, groupId, status, ts: env.ts });
  });
  if (dup) { log.info('task 重复 msgId 忽略:', env.msgId); return; }

  sse.publish('task.status', { seat, groupId, taskId, status });
}

function handleReturn(env, rawTopic) {
  const session = db.getCurrentSession();
  if (!session) { log.warn('return 忽略：无进行中会话'); return; }
  const sessionId = session.session_id;
  if (!guardSeat(session, env, 'return')) return;
  const seat = seatNum(env.seat);
  const p = env.payload || {};
  const groupId = env.group || deriveGroup(seat);

  let dup = false;
  db.transaction(() => {
    const ev = db.insertEvent({
      session_id: sessionId, ts: env.ts, type: 'return', seat,
      detail: JSON.stringify(p), msg_id: env.msgId, raw_topic: rawTopic, qos: 1,
    });
    if (!ev.inserted) { dup = true; return; }
    db.recordReturn({ sessionId, seat, groupId, returnTime: env.ts });
  });
  if (dup) { log.info('return 重复 msgId 忽略:', env.msgId); return; }

  sse.publish('student.return', { seat, groupId, allReturned: !!p.allReturned, note: p.note || null });

  // 全部归还则自动关机（内部已兜底，不因异常打断消息流）
  commandSvc.autoShutdown().catch((e) => log.warn('autoShutdown 异常:', e.message));
}

function handleStatus(env) {
  const session = db.getCurrentSession();
  if (!session) return;
  if (!guardSeat(session, env, 'status')) return;
  const seat = seatNum(env.seat);
  const p = env.payload || {};
  if (p.online === false) return; // 显式离线由 monitor 处理
  db.touchSeat(session.session_id, seat, env.ts || Date.now());
}

async function handleHello(env) {
  try {
    const session = db.getCurrentSession();
    // 无进行中会话：照常应答（告知无课）；有会话则必须校验座位在范围内，
    // 否则越界 hello 会污染 t_conflict（跨会话按 seat 累积的根因之一）。
    if (session && !seatInRange(env.seat, session.total_seats)) {
      log.warn(`hello 忽略：座位 ${String(env.seat)} 超出本会话范围 1-${session.total_seats} (E-VAL-01)`);
      return;
    }
    const seat = seatNum(env.seat);
    const machineId = env.machineId || (env.payload && env.payload.machineId);
    if (machineId) {
      const cf = db.upsertConflict({ seat, machineId, ts: env.ts || Date.now() });
      if (cf.isConflict) sse.publish('conflict.detected', cf);
    }
    if (session) db.touchSeat(session.session_id, seat, env.ts || Date.now());

    const sessionId = session ? session.session_id : null;
    const phase = session ? session.phase : null;
    let currentTask = null;
    let checkinDone = false;
    let returnDone = false;
    let equipment = null;
    let policy = null;
    if (session) {
      const tasks = db.listTasks(sessionId);
      if (tasks.length) {
        const t = tasks[tasks.length - 1];
        // 最近活动：带计时字段（迟到/重连学生据此恢复计时显示）
        currentTask = {
          taskId: t.task_id, title: t.title,
          timed: !!t.timed, durationSec: t.duration_sec != null ? t.duration_sec : null,
          timerState: t.timer_state || 'idle',
          remainingMs: taskSvc.remainingMs(t),
        };
      }
      const st = db.getStudent(sessionId, seat);
      if (st) { checkinDone = st.checkin_status === 'done'; returnDone = st.return_status === 'done'; }
      // 器材清单随 sync 下发：迟到/重连学生据此恢复登记页器材列表
      if (session.equipment_json) {
        try { equipment = JSON.parse(session.equipment_json); } catch (_e) { equipment = null; }
      }
      // 锁定策略随 sync 下发：迟到/重连学生恢复锁定状态
      try { policy = require('../services/policy.service').computePolicy(session); } catch (_e) { policy = null; }
    }
    await bridge.publishSync(seat, { sessionId, phase, currentTask, checkinDone, returnDone, equipment, policy });
  } catch (e) {
    // hello 是异步处理，异常必须就地兜住，否则会变成 unhandledRejection 拖垮进程
    log.error('hello 处理失败:', e.message);
  }
}

// 单条坏消息不得打断整条消息流：同步异常直接捕获，异步 Promise 挂 .catch。
function safeRun(label, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.catch((e) => log.error(`${label} 处理异常(异步):`, e.message));
    }
    return r;
  } catch (e) {
    log.error(`${label} 处理异常:`, e.message);
    return undefined;
  }
}

function dispatch(topic, buf) {
  let env;
  try {
    env = JSON.parse(buf.toString());
  } catch (e) {
    log.warn('信封解析失败 (E-VAL-01):', e.message);
    return undefined;
  }
  if (!env || !env.type) { log.warn('信封缺少 type'); return undefined; }
  switch (env.type) {
    case 'checkin': return safeRun('checkin', () => handleCheckin(env, topic));
    case 'task': return safeRun('task', () => handleTaskStatus(env, topic));
    case 'return': return safeRun('return', () => handleReturn(env, topic));
    case 'status': return safeRun('status', () => handleStatus(env));
    case 'hello': return safeRun('hello', () => handleHello(env));
    case 'sync': return undefined; // 教师发出的 sync，学生不回
    case 'cmd': return undefined; // 教师发出
    default:
      log.warn('未知 envelope.type:', env.type);
      return undefined;
  }
}

module.exports = { dispatch, topics };
