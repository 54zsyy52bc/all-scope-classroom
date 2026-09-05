'use strict';
// 活动路由：发布活动（预设/自定义 + 可选计时）、活动列表、计时控制、锁定策略。
const express = require('express');
const activitySvc = require('../services/activity.service');
const policySvc = require('../services/policy.service');
const db = require('../db');
const { ok, asyncHandler } = require('../response');
const { fail } = require('../errors');

const router = express.Router();

// 发布活动（source=preset|custom；activityPresetId；timed；durationSec）
router.post('/sessions/:sessionId/activities', asyncHandler(async (req, res) => {
  if (!db.getSession(req.params.sessionId)) fail('E-NOTFOUND', '会话不存在');
  const r = activitySvc.publishActivity(Object.assign({ sessionId: req.params.sessionId }, req.body || {}));
  ok(res, { task: r.task, broadcast: r.broadcast }, 201);
}));

// 活动列表（含计时状态与各状态计数）
router.get('/sessions/:sessionId/activities', asyncHandler(async (req, res) => {
  if (!db.getSession(req.params.sessionId)) fail('E-NOTFOUND', '会话不存在');
  ok(res, activitySvc.listActivities(req.params.sessionId));
}));

// 计时控制：start|pause|resume|adjust|restart|stop
router.post('/sessions/:sessionId/activities/:taskId/timer', asyncHandler(async (req, res) => {
  const r = activitySvc.timerControl(Object.assign({ taskId: req.params.taskId }, req.body || {}));
  ok(res, r);
}));

// 锁定策略：设置（open | activity）
router.post('/sessions/:sessionId/policy', asyncHandler(async (req, res) => {
  ok(res, policySvc.setPolicy(req.params.sessionId, (req.body || {}).mode));
}));

// 锁定策略：查询
router.get('/sessions/:sessionId/policy', asyncHandler(async (req, res) => {
  ok(res, policySvc.getPolicy(req.params.sessionId));
}));

module.exports = router;
