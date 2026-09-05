'use strict';
// =============================================================================
// 锁定策略服务：学生端电脑使用策略（open 全课可用 / activity 非活动时间锁定）。
//
// 策略引擎（activity 模式）在以下时机重算并下发 cmd policy + SSE policy.changed：
//   1) 上课开始（waiting→checkin）
//   2) 阶段变更（checkin/task/return/closed）
//   3) 活动发布（task 阶段出现 running 活动 → 解锁）
//   4) 活动截止 / 计时关闭（无 running 活动 → 锁定）
//
// 判定表（activity 模式）：
//   checkin → 不锁（登记必备）；task 且有 running 活动 → 不锁；
//   task 且无 running 活动 → 锁（非活动时间）；return → 不锁（归还必备）；
//   waiting/closed → 不锁。
//
// 诚实边界：锁定为学生端「软锁」（全屏遮罩 + 输入拦截），非系统级硬锁。
// =============================================================================
const db = require('../db');
const sse = require('../sse');
const bridge = require('../mqtt/bridge');
const { fail } = require('../errors');
const { makeLogger } = require('../utils');

const log = makeLogger(process.env.LOG_LEVEL || 'info');

const lastSent = new Map(); // sessionId -> {mode, locked}

function getPolicy(sessionId) {
  const s = db.getSession(sessionId);
  if (!s) fail('E-NOTFOUND', '会话不存在');
  return { mode: s.policy_mode || 'open', phase: s.phase };
}

function setPolicy(sessionId, mode) {
  if (!['open', 'activity'].includes(mode)) fail('E-VAL-01', 'mode 须为 open 或 activity');
  const s = db.getSession(sessionId);
  if (!s) fail('E-NOTFOUND', '会话不存在');
  db.updateSession(sessionId, { policy_mode: mode });
  const policy = applyPolicy(sessionId, true);
  return { mode: policy.mode, locked: policy.locked, phase: policy.phase, reason: policy.reason };
}

// 计算当前应锁定与否（activity 模式按阶段 + running 活动判定）
function computePolicy(session, now) {
  const mode = session.policy_mode || 'open';
  if (mode === 'open') {
    return { mode, locked: false, phase: session.phase, reason: 'open' };
  }
  // activity 模式
  if (session.phase === 'task') {
    const tasks = db.listTasks(session.session_id || session.sessionId);
    const running = tasks.some((t) => t.timed && t.timer_state === 'running');
    if (running) return { mode, locked: false, phase: 'task', reason: 'activity-running' };
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
