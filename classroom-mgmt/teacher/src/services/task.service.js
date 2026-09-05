'use strict';
// 任务服务：发布任务（广播 + 自动推进阶段）、关闭任务、状态查询、计时字段映射。
const db = require('../db');
const sse = require('../sse');
const bridge = require('../mqtt/bridge');
const { fail } = require('../errors');
const { makeTaskId, nowMs } = require('../utils');

// 活动剩余毫秒（running 动态计算，paused/expired 用固化值）。t 为 t_task 行。
function remainingMs(t, now) {
  if (!t || !t.timed) return null;
  const n = now != null ? now : nowMs();
  if (t.timer_state === 'running' && t.timer_started_at) {
    const dur = (t.duration_sec || 0) * 1000;
    const left = dur - (n - t.timer_started_at);
    return left > 0 ? left : 0;
  }
  return t.timer_remaining_ms != null ? t.timer_remaining_ms : (t.duration_sec || 0) * 1000;
}

function toTask(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    sessionId: row.session_id,
    title: row.title,
    desc: row.desc || null,
    publishTime: row.publish_time || null,
    closeTime: row.close_time || null,
    source: row.source || 'custom',
    activityPresetId: row.activity_preset_id || null,
    timed: !!row.timed,
    durationSec: row.duration_sec != null ? row.duration_sec : null,
    timerState: row.timer_state || 'idle',
    remainingMs: remainingMs(row),
  };
}

function publishTask({ sessionId, title, desc }) {
  if (!title || !String(title).trim()) {
    fail('E-VAL-01', 'title 为必填项');
  }
  const session = db.getSession(sessionId);
  if (!session) fail('E-NOTFOUND', '会话不存在');
  if (session.phase === 'closed') {
    fail('E-PHASE-01', '会话已关闭，不能发布任务');
  }
  const taskId = makeTaskId();
  const now = nowMs();
  // 注意：db.createTask 的入参是 camelCase（sessionId / taskId / publishTime）。
  // 曾因误传 snake_case 导致 task_id、session_id 落库为 NULL，任务整体不可见且 HTTP 仍返回 201。
  db.createTask({ sessionId, taskId, title: String(title).trim(), desc: desc ? String(desc) : null, publishTime: now });

  let broadcast = { delivered: true, topic: bridge.CMD_BROADCAST, msgId: null };
  if (session.phase === 'checkin') {
    db.updateSession(sessionId, { phase: 'task' });
    sse.publish('phase.changed', { from: 'checkin', to: 'task' });
  }
  broadcast = bridge.publishCommand('task', { task: { taskId, title: String(title).trim(), desc: desc || '' } });
  const task = toTask(db.getTask(taskId));
  sse.publish('task.published', task);
  return { task, broadcast };
}

function closeTask(taskId) {
  const row = db.getTask(taskId);
  if (!row) fail('E-NOTFOUND', '任务不存在');
  const updated = db.closeTask(taskId, nowMs());
  return { task: toTask(updated) };
}

function listTasksWithStats(sessionId) {
  const tasks = db.listTasks(sessionId);
  return tasks.map((t) => {
    const statuses = db.listTaskStatuses({ sessionId, taskId: t.task_id });
    const stats = { doing: 0, done: 0, help: 0 };
    for (const s of statuses) {
      if (s.status === 'doing') stats.doing += 1;
      else if (s.status === 'done') stats.done += 1;
      else if (s.status === 'help') stats.help += 1;
    }
    return Object.assign(toTask(t), { stats });
  });
}

function listTaskStatuses(sessionId, taskId, status) {
  return db.listTaskStatuses({ sessionId, taskId, status }).map((r) => ({
    taskId: r.task_id, seat: r.seat, groupId: r.group_id || null, status: r.status, ts: r.ts,
  }));
}

module.exports = { toTask, remainingMs, publishTask, closeTask, listTasksWithStats, listTaskStatuses };
