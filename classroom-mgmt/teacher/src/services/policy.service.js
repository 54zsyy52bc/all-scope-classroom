'use strict';
// =============================================================================
// 锁定策略服务：学生端电脑使用策略（open 全课可用 / activity 非活动时间锁定）。
//
// 策略引擎（activity 模式）在以下时机重算并下发 cmd policy + SSE policy.changed：
//   1) 上课开始（waiting→checkin）
//   2) 阶段变更（checkin/task/return/closed）
//   3) 活动发布（task 阶段出现进行中活动 → 解锁）
//   4) 活动截止 / 结束（无进行中活动 → 锁定）
//
// 判定表（activity 模式）：
//   checkin → 不锁（登记必备）；task 且"当前活动"进行中 → 不锁；
//   "当前活动" = 最近发布且未结束的活动（与 sync.currentTask / 大屏活动条同源），
//   进行中 = 非计时开放中，或计时 running/paused
//   （曾只认 timed+running —— 发布非计时活动后学生被锁死，现场事故）；
//   task 且当前活动已截止/已结束 → 锁（非活动时间）；return → 不锁（归还必备）；
//   waiting/closed → 不锁。
//
// 诚实边界：锁定为学生端「软锁」（全屏遮罩 + 输入拦截），非系统级硬锁。
// =============================================================================
const db = require('../db');
const sse = require('../sse');
const bridge = require('../mqtt/bridge');
const { fail } = require('../errors');
const { makeLogger } = require('../utils');
const { MAX_SEAT } = require('../config');

const log = makeLogger(process.env.LOG_LEVEL || 'info');

const lastSent = new Map(); // sessionId -> {mode, locked}

function getPolicy(sessionId) {
  const s = db.getSession(sessionId);
  if (!s) fail('E-NOTFOUND', '会话不存在');
  return { mode: s.policy_mode || 'open', phase: s.phase };
}

function setPolicy(sessionId, mode) {
  if (!['open', 'activity'].includes(mode)) fail('E-VAL-01', 'mode 须为 open 或 activity');
  if (!db.getSession(sessionId)) fail('E-NOTFOUND', '会话不存在');
  db.updateSession(sessionId, { policy_mode: mode });
  const policy = applyPolicy(sessionId, true);
  // 双保险：cmd policy 单条广播偶有丢包 → 逐生广播**完整** sync（buildSyncPayload 唯一真源）
  // 强制校正。⛔ 绝不能只发 { policy } 残缺包：学生端把 sync 当完整权威状态
  // （setPhase(p.phase||'idle')/清活动卡/回滚登记），残缺包会把全班打回待课页（现场事故）。
  try {
    const fresh = db.getSession(sessionId);
    const { buildSyncPayload } = require('./sync.service');
    const students = (db.queryStudents(sessionId, { limit: MAX_SEAT }) || {}).items || [];
    for (const st of students) {
      if (st.seat) bridge.publishSync(st.seat, buildSyncPayload(fresh, st.seat));
    }
  } catch (_e) { /* 不阻断策略下发 */ }
  return { mode: policy.mode, locked: policy.locked, phase: policy.phase, reason: policy.reason };
}

// 计算当前应锁定与否（activity 模式按阶段 + 进行中活动判定）
function computePolicy(session, now) {
  const mode = session.policy_mode || 'open';
  if (mode === 'open') {
    return { mode, locked: false, phase: session.phase, reason: 'open' };
  }
  // activity 模式
  if (session.phase === 'task') {
    const tasks = db.listTasks(session.session_id || session.sessionId);
    const open = tasks.filter((t) => !t.close_time);
    // "当前活动" = 最近发布且未结束的活动（与 sync.currentTask / 大屏活动条同源）。
    // 进行中 = 非计时开放中，或计时 running/paused。
    // ⛔ 不能遍历全部 open 任务取"任一进行中"：早前遗留的开放任务会让"无活动要锁定"
    // 的场景永远解不了锁（smoke 7.6 语义）。
    const cur = open.length ? open[open.length - 1] : null;
    const inActivity = !!cur && (!cur.timed
      || cur.timer_state === 'running' || cur.timer_state === 'paused');
    if (inActivity) return { mode, locked: false, phase: 'task', reason: 'activity-running' };
    return { mode, locked: true, phase: 'task', reason: 'no-activity' };
  }
  return { mode, locked: false, phase: session.phase, reason: 'phase-' + (session.phase || 'none') };
}

// 重算并下发（force 强制下发；否则仅变化时下发，避免刷屏）
function applyPolicy(sessionId, force) {
  try {
    const session = db.getSession(sessionId);
    if (!session) return null;
    const policy = computePolicy(session);
    const prev = lastSent.get(sessionId);
    if (!force && prev && prev.mode === policy.mode && prev.locked === policy.locked) {
      return policy; // 无变化不重复广播
    }
    lastSent.set(sessionId, { mode: policy.mode, locked: policy.locked });
    bridge.publishCommand('policy', policy);
    sse.publish('policy.changed', policy);
    log.info(`策略下发 mode=${policy.mode} locked=${policy.locked} phase=${policy.phase} (${policy.reason})`);
    return policy;
  } catch (e) {
    log.warn('applyPolicy 异常:', e.message);
    return null;
  }
}

module.exports = { getPolicy, setPolicy, computePolicy, applyPolicy };
