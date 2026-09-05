'use strict';
const express = require('express');
const taskSvc = require('../services/task.service');
const db = require('../db');
const { ok, asyncHandler } = require('../response');
const { fail } = require('../errors');

const router = express.Router();

// 发布任务
router.post('/sessions/:sessionId/tasks', asyncHandler(async (req, res) => {
  const { task, broadcast } = taskSvc.publishTask(Object.assign({ sessionId: req.params.sessionId }, req.body || {}));
  ok(res, { task, broadcast }, 201);
}));

// 任务列表（含各状态计数）
router.get('/sessions/:sessionId/tasks', asyncHandler(async (req, res) => {
  if (!db.getSession(req.params.sessionId)) fail('E-NOTFOUND', '会话不存在');
  ok(res, taskSvc.listTasksWithStats(req.params.sessionId));
}));

// 关闭任务
router.post('/tasks/:taskId/close', asyncHandler(async (req, res) => {
  const { task } = taskSvc.closeTask(req.params.taskId);
  ok(res, { task });
}));

// 某任务全班状态
router.get('/sessions/:sessionId/tasks/:taskId/statuses', asyncHandler(async (req, res) => {
  if (!db.getSession(req.params.sessionId)) fail('E-NOTFOUND', '会话不存在');
  ok(res, taskSvc.listTaskStatuses(req.params.sessionId, req.params.taskId, req.query.status || undefined));
}));

module.exports = router;
