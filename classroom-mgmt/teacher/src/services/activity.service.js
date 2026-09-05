'use strict';
// =============================================================================
// 活动服务：发布活动（预设/自定义 + 可选计时）、计时控制（暂停/继续/调时长/重计时）、
// 截止检测（教师端权威定时器 → SSE + MQTT 双方提醒 → 锁定策略重算）。
//
// 领域模型：活动 = 任务（t_task）+ 计时元数据。发布活动即发布任务（兼容 task.status
// 上报协议与报表）。计时器状态机：
//   idle → running → paused → running → … → expired → closed（stop/下课）
// 剩余时间由教师端权威计算（running 动态、paused/expired 固化），学生端仅显示。
// =============================================================================
const db = require('../db');
const sse = require('../sse');
const bridge = require('../mqtt/bridge');
const taskSvc = require('./task.service');
const { fail } = require('../errors');
const { makeTaskId, nowMs, makeLogger } = require('../utils');

const log = makeLogger(process.env.LOG_LEVEL || 'info');

// 截止定时器登记表（进程内；教师端服务重启后由 sync 兜底恢复显示，截止检测重新开始）
const timers = new Map();

function sessionOrFail(sessionId) {
  const s = db.getSession(sessionId);
  if (!s) fail('E-NOTFOUND', '会话不存在');
  return s;
}

function taskOrFail(taskId) {
  const t = db.getTask(taskId);
  if (!t) fail('E-NOTFOUND', '活动不存在');
  return t;
}

// ---------- 截止定时器 ----------
function clearTimer(taskId) {
  const t = timers.get(taskId);
  if (t) { clearTimeout(t); timers.delete(taskId); }
}

function armTimer(taskId, delayMs) {
  clearTimer(taskId);
  if (delayMs <= 0) { expireTask(taskId); return; }
  timers.set(taskId, setTimeout(() => {
    timers.delete(taskId);
    expireTask(taskId);
  }, delayMs));
  if (timers.get(taskId) && timers.get(taskId).unref) timers.get(taskId).unref();
}

// 截止：状态落地 → SSE（教师端提醒）→ MQTT（学生端提醒）→ 锁定策略重算
function expireTask(taskId) {
  try {
    const t = db.getTask(taskId);
    if (!t || !t.timed || t.timer_state !== 'running') return; // 已暂停/已截止/已关闭则忽略
    db.updateTaskTimer(taskId, { timer_state: 'expired', timer_remaining_ms: 0, timer_paused_at: null });
    const task = taskSvc.toTask(db.getTask(taskId));
    sse.publish('activity.timer', { taskId, state: 'expired', remainingMs: 0 });
    bridge.publishCommand('task_timer', { taskId, timerAction: 'expired' });
    log.info(`活动 ${taskId} 计时截止`);
    // 截止后重算锁定策略（activity 模式：无 running 活动 → 锁定学生机）
    try { require('./policy.service').applyPolicy(t.session_id); } catch (_e) { /* 策略重算失败不阻断 */ }
  } catch (e) {
    log.warn('expireTask 异常:', e.message);
  }
}

// ---------- 发布活动 ----------
function publishActivity({ sessionId, title, desc, source, activityPresetId, timed, durationSec }) {
  if (!title || !String(title).trim()) fail('E-VAL-01', 'title 为必填项');
  const session = sessionOrFail(sessionId);
  if (session.phase === 'closed') fail('E-PHASE-01', '会话已关闭，不能发布活动');

  const useTimer = !!timed;
  if (useTimer) {
    const d = Number(durationSec);
    if (!Number.isInteger(d) || d <= 0 || d > 7200) {
      fail('E-VAL-01', '启用计时时 durationSec 须为 1-7200 的整数');
    }
  }

  const taskId = makeTaskId();
  const now = nowMs();
  db.createTask({
    sessionId, taskId,
    title: String(title).trim(),
    desc: desc ? String(desc) : null,
    publishTime: now,
    source: source === 'preset' ? 'preset' : 'custom',
    activityPresetId: activityPresetId || null,
    timed: useTimer ? 1 : 0,
    durationSec: useTimer ? Number(durationSec) : null,
    timerState: useTimer ? 'running' : 'idle',
    timerStartedAt: useTimer ? now : null,
    timerPausedAt: null,
    timerRemainingMs: null,
  });

  // 阶段推进：checkin → task
  if (session.phase === 'checkin') {
    db.updateSession(sessionId, { phase: 'task' });
    sse.publish('phase.changed', { from: 'checkin', to: 'task' });
  }

  const task = taskSvc.toTask(db.getTask(taskId));
  const broadcast = bridge.publishCommand('task', {
    task: {
      taskId, title: task.title, desc: task.desc || '',
      source: task.source, timed: task.timed, durationSec: task.durationSec,
      timerState: task.timerState, remainingMs: task.remainingMs,
    },
  });
  sse.publish('task.published', task);

  // 启用计时 → 注册截止定时器
  if (useTimer) armTimer(taskId, task.remainingMs);

  // 发布后重算锁定策略（activity 模式：有 running 活动 → 解锁）
  try { require('./policy.service').applyPolicy(sessionId); } catch (_e) { /* 忽略 */ }

  return { task, broadcast };
}

// ---------- 计时控制 ----------
function timerControl({ taskId, action, durationSec }) {
  const t = taskOrFail(taskId);
  if (!t.timed) fail('E-VAL-01', '该活动未启用计时');
  const now = nowMs();
  const allowed = ['start', 'pause', 'resume', 'adjust', 'restart', 'stop'];
  if (!allowed.includes(action)) fail('E-VAL-01', `action 须为 ${allowed.join('/')}`);

  let patch = { timer_paused_at: null };
  let remaining = null;

  switch (action) {
    case 'pause':
      if (t.timer_state !== 'running') fail('E-TIMER-01', '仅运行中的计时可暂停');
      patch.timer_state = 'paused';
      patch.timer_remaining_ms = taskSvc.remainingMs(t, now);
      patch.timer_paused_at = now;
      remaining = patch.timer_remaining_ms;
      break;
    case 'resume':
      if (t.timer_state !== 'paused') fail('E-TIMER-01', '仅暂停中的计时可继续');
      patch.timer_state = 'running';
      patch.timer_started_at = now - (t.duration_sec * 1000 - (t.timer_remaining_ms != null ? t.timer_remaining_ms : t.duration_sec * 1000));
      patch.timer_remaining_ms = null;
      remaining = taskSvc.remainingMs(Object.assign({}, t, patch), now);
      break;
    case 'adjust': {
      const d = Number(durationSec);
      if (!Number.isInteger(d) || d <= 0 || d > 7200) fail('E-VAL-01', 'durationSec 须为 1-7200 的整数');
      patch.duration_sec = d;
      patch.timer_state = 'running';
      patch.timer_started_at = now;
      patch.timer_remaining_ms = null;
      remaining = d * 1000;
      break;
    }
    case 'restart':
      if (!t.duration_sec) fail('E-VAL-01', '缺少时长，无法重新计时');
      patch.timer_state = 'running';
      patch.timer_started_at = now;
      patch.timer_remaining_ms = null;
      remaining = t.duration_sec * 1000;
      break;
    case 'start': {
      const d = Number(durationSec) || t.duration_sec;
      if (!Number.isInteger(d) || d <= 0) fail('E-VAL-01', 'durationSec 须为正整数');
      patch.timer_state = 'running';
      patch.duration_sec = d;
      patch.timer_started_at = now;
      patch.timer_remaining_ms = null;
      remaining = d * 1000;
      break;
    }
    case 'stop':
      patch.timer_state = 'closed';
      patch.timer_remaining_ms = 0;
      remaining = 0;
      break;
    default: break;
  }

  db.updateTaskTimer(taskId, patch);
  const task = taskSvc.toTask(db.getTask(taskId));

  // 定时器管理：任何状态迁移都必须让「截止定时器」与真实剩余一致，否则会出现
  // 提前截止（adjust/restart 后旧定时器仍在走）或永不截止（resume 越过旧截止点后无定时器）。
  // 规则：pause/stop → 摘除；resume/adjust/restart/start → 以新剩余重挂。
  if (action === 'pause' || action === 'stop') {
    clearTimer(taskId);
  } else if (task.timerState === 'running' && task.remainingMs != null) {
    armTimer(taskId, task.remainingMs);
  }

  // 广播 + SSE。stop 也广播 task_timer{stop}：学生端需据此移除/收拢倒计时，
  // 否则教师在 open 策略下提前结束活动，学生机仍显示一个永不截止的计时器。
  bridge.publishCommand('task_timer', {
    taskId,
    timerAction: action,
    remainingMs: remaining != null ? remaining : (task.remainingMs != null ? task.remainingMs : 0),
    durationSec: task.durationSec,
  });
  sse.publish('activity.timer', { taskId, state: task.timerState, remainingMs: remaining });

  // 计时状态变化 → 重算锁定策略
  try { require('./policy.service').applyPolicy(task.sessionId); } catch (_e) { /* 忽略 */ }

  return { task, broadcast: { delivered: true, action } };
}

// ---------- 查询 ----------
function listActivities(sessionId) {
  return db.listTasks(sessionId).map((t) => {
    const dto = taskSvc.toTask(t);
    const statuses = db.listTaskStatuses({ sessionId, taskId: t.task_id });
    const stats = { doing: 0, done: 0, help: 0 };
    for (const s of statuses) {
      if (s.status === 'doing') stats.doing += 1;
      else if (s.status === 'done') stats.done += 1;
      else if (s.status === 'help') stats.help += 1;
    }
    return Object.assign(dto, { stats });
  });
}

module.exports = { publishActivity, timerControl, listActivities, expireTask };
