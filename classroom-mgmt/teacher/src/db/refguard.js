'use strict';
// 参照完整性守卫：写库前显式校验外键目标存在，快速失败并给出可判定的业务错误码，
// 不让原生 SQLite 异常穿透到 service / 路由层。
//
// 外键约束本身保留在 DDL 中，作为数据完整性的最后一道防线（better-sqlite3 默认
// 开启 PRAGMA foreign_keys=ON）。本模块是它的前置补充：提供带上下文的错误信息，
// 并避免在"事件已入库但业务写入失败"的时序里产生毒丸。
//
// 设计约束：不 require ./index（避免与仓储层循环依赖），storage 由调用方传入。
const { fail } = require('../errors');

function ensureSession(storage, sessionId) {
  if (!storage) fail('E-INTERNAL', '存储未初始化');
  if (!sessionId) fail('E-VAL-01', 'sessionId 为必填项');
  if (!storage.get('t_session', { session_id: sessionId })) {
    fail('E-REF-01', `会话不存在：${sessionId}`);
  }
  return true;
}

function ensureTask(storage, taskId) {
  if (!taskId) fail('E-VAL-01', 'taskId 为必填项');
  if (!storage.get('t_task', { task_id: taskId })) {
    fail('E-REF-01', `任务不存在：${taskId}`);
  }
  return true;
}

// 任务必须属于当前会话，防止跨会话串写（学生机残留上一节课的 taskId）
function ensureTaskInSession(storage, taskId, sessionId) {
  const task = storage.get('t_task', { task_id: taskId });
  if (!task) fail('E-REF-01', `任务不存在：${taskId}`);
  if (task.session_id !== sessionId) {
    fail('E-REF-01', `任务 ${taskId} 不属于当前会话`);
  }
  return task;
}

module.exports = { ensureSession, ensureTask, ensureTaskInSession };
