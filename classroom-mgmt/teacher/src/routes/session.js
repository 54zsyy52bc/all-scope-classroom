'use strict';
const express = require('express');
const sessionSvc = require('../services/session.service');
const db = require('../db');
const { ok, asyncHandler } = require('../response');
const { fail } = require('../errors');

const router = express.Router();

// 开始上课（可携带班级/活动预设；返回器材清单与任务模板供大屏/编辑器展示）
router.post('/sessions', asyncHandler(async (req, res) => {
  const r = sessionSvc.startSession(req.body || {});
  ok(res, {
    session: r.session,
    broadcast: r.broadcast,
    equipBroadcast: r.equipBroadcast,
    equipment: r.equipment,
    taskTemplates: r.taskTemplates,
    activityName: r.activityName,
  }, 201);
}));

// 当前进行中会话
router.get('/sessions/current', asyncHandler(async (req, res) => {
  const s = sessionSvc.getCurrentSession();
  if (!s) fail('E-SESSION-01', '当前没有进行中的课堂会话');
  ok(res, s);
}));

// 历史会话列表
router.get('/sessions', asyncHandler(async (req, res) => {
  const { phase, page, limit } = req.query;
  ok(res, sessionSvc.listSessions({
    phase: phase || undefined,
    page: page ? parseInt(page, 10) : 1,
    limit: limit ? parseInt(limit, 10) : 20,
  }));
}));

// 会话详情
router.get('/sessions/:sessionId', asyncHandler(async (req, res) => {
  const s = sessionSvc.getSession(req.params.sessionId);
  if (!s) fail('E-NOTFOUND', '会话不存在');
  ok(res, s);
}));

// 阶段流转
router.post('/sessions/:sessionId/phase', asyncHandler(async (req, res) => {
  const { session, broadcast } = sessionSvc.transitionPhase(req.params.sessionId, (req.body || {}).phase);
  ok(res, { session, broadcast });
}));

// 登记名单
router.get('/sessions/:sessionId/students', asyncHandler(async (req, res) => {
  const { status, group, page, limit } = req.query;
  ok(res, db.queryStudents(req.params.sessionId, {
    status: status || undefined,
    group: group || undefined,
    page: page ? parseInt(page, 10) : 1,
    limit: limit ? parseInt(limit, 10) : 50,
  }));
}));

module.exports = router;
