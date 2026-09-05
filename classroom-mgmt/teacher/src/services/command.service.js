'use strict';
// 指令服务：关机（三重校验：阶段闸门 / 归还闸门 / HMAC 令牌）、复位。
const db = require('../db');
const sse = require('../sse');
const bridge = require('../mqtt/bridge');
const { fail } = require('../errors');
const { signToken, nowMs, seatNum, makeLogger } = require('../utils');

const log = makeLogger(process.env.LOG_LEVEL || 'info');

function currentOrFail() {
  const s = db.getCurrentSession();
  if (!s) fail('E-SESSION-01', '当前没有进行中的课堂会话');
  return s;
}

async function sendShutdown({ force = false, reason = '' } = {}) {
  const session = currentOrFail();
  const sessionId = session.session_id || session.sessionId;

  // 1) 阶段闸门
  if (session.phase !== 'return' && session.phase !== 'closed') {
    fail('E-OFF-01', `仅在课后归还阶段可下发关机指令，当前阶段 ${session.phase}`);
  }

  // 2) 归还闸门
  const students = db.queryStudents(sessionId).items;
  const pendingSeats = students.filter((s) => s.returnStatus !== 'done').map((s) => s.seat);
  if (!force && pendingSeats.length > 0) {
    fail('E-RETURN-01', `尚有 ${pendingSeats.length} 个座位未确认归还，如需强制关机请设 force=true`, { pendingSeats });
  }

  // 3) HMAC 令牌（60s 时间窗）
  const ts = nowMs();
  const token = signToken(cfg_secret(), sessionId, ts);
  const broadcast = await bridge.publishCommand('shutdown',
    { sessionId, ts, token },
    { sessionId, ts, token });

  if (broadcast.delivered === false) {
    fail('E-CONN-01', 'SIoT2 连接不可用，关机指令未送达');
  }

  // 离线机兜底
  const onlineSeats = students.filter((s) => s.online);
  const offlineSeats = students.filter((s) => !s.online).map((s) => s.seat);

  db.insertEvent({
    session_id: sessionId, ts, type: 'shutdown',
    seat: null, detail: JSON.stringify({ force: !!force, reason: reason || '', token }),
    msg_id: `shutdown-${sessionId}-${ts}`,
  });

  sse.publish('command.sent', { action: 'shutdown', msgId: broadcast.msgId, delivered: true, seat: null });

  return {
    broadcast,
    shutdownDelaySec: cfg_shutdownDelay(),
    targetOnline: onlineSeats.length,
    offlineSeats,
    pendingSeats: force ? pendingSeats : [],
  };
}

async function sendReset({ seat }) {
  if (!/^\d{1,2}$/.test(String(seat))) {
    fail('E-VAL-01', 'seat 必须为两位数字字符串，如 "07"');
  }
  const normSeat = seatNum(seat);
  const session = currentOrFail();
  const sessionId = session.session_id || session.sessionId;
  if (parseInt(normSeat, 10) > Number(session.total_seats || 0)) {
    fail('E-VAL-01', `座位 ${normSeat} 超出本会话范围 1-${session.total_seats}`);
  }
  const existing = db.getStudent(sessionId, normSeat);
  const groupId = existing ? existing.group_id : null;

  db.upsertStudent({
    sessionId, seat: normSeat, groupId,
    patch: {
      name: null, student_no: null, checkin_status: 'pending',
      checkin_time: null, machine_id: null, return_status: 'pending',
    },
  });
  db.removeBorrows(sessionId, normSeat);
  // 复位同时解除该座冲突标记（该座只剩一台合法机器，不再红色告警）
  db.removeConflict(normSeat);

  const broadcast = await bridge.publishCommand('reset', { seat: normSeat });
  sse.publish('command.sent', { action: 'reset', seat: normSeat, msgId: broadcast.msgId, delivered: broadcast.delivered, topic: bridge.CMD_BROADCAST });
  return { seat: normSeat, broadcast };
}

// 全部归还后自动关机（由 return handler 触发）
async function autoShutdown() {
  try {
    const session = db.getCurrentSession();
    if (!session) return;
    const students = db.queryStudents(session.session_id || session.sessionId).items;
    const allReturned = students.length > 0 && students.every((x) => x.returnStatus === 'done');
    if (!allReturned) return;
    await sendShutdown({ force: false, reason: 'auto' });
    log.info('全部归还确认，已自动下发关机指令');
  } catch (e) {
    log.warn('autoShutdown 跳过:', e.message);
  }
}

function cfg_secret() { return require('../config').HMAC_SECRET; }
function cfg_shutdownDelay() { return require('../config').SHUTDOWN_DELAY_SEC; }

module.exports = { sendShutdown, sendReset, autoShutdown };
