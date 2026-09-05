'use strict';
// 团队负责人指定的扁平路径别名（与 openapi.yaml 的嵌套路径并存）。
// 这些端点复用同一套 services，不重复业务逻辑。
// 注意：/equipment、/dashboard/stream 已由 openapi 路由覆盖，此处不再重复注册。
const express = require('express');
const sessionSvc = require('../services/session.service');
const commandSvc = require('../services/command.service');
const taskSvc = require('../services/task.service');
const exportSvc = require('../services/export.service');
const db = require('../db');
const { ok, asyncHandler } = require('../response');
const { fail } = require('../errors');

const router = express.Router();

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function currentId() {
  const s = db.getCurrentSession();
  if (!s) fail('E-SESSION-01', '当前没有进行中的课堂会话');
  return s.session_id;
}

// 开始上课（可携带班级/活动预设；返回器材清单与任务模板）
router.post('/session/start', asyncHandler(async (req, res) => {
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

// 下课（phase -> return）
router.post('/session/end', asyncHandler(async (req, res) => {
  const { session, broadcast } = sessionSvc.endSession(currentId());
  ok(res, { session, broadcast });
}));

// 结束课堂归档（return -> closed，之后可重新开始上课）
router.post('/session/finish', asyncHandler(async (req, res) => {
  const { session, broadcast } = sessionSvc.transitionPhase(currentId(), 'closed');
  ok(res, { session, broadcast });
}));

// 发布活动（含计时）；兼容旧 /task 语义（任务即未启用计时的活动）
router.post('/task', asyncHandler(async (req, res) => {
  const { task, broadcast } = require('../services/activity.service')
    .publishActivity(Object.assign({ sessionId: currentId() }, req.body || {}));
  ok(res, { task, broadcast }, 201);
}));

// 计时控制（扁平别名）
router.post('/activity/:taskId/timer', asyncHandler(async (req, res) => {
  ok(res, require('../services/activity.service').timerControl(Object.assign({ taskId: req.params.taskId }, req.body || {})));
}));

// 锁定策略：设置 / 查询（扁平别名）
router.post('/policy', asyncHandler(async (req, res) => {
  ok(res, require('../services/policy.service').setPolicy(currentId(), (req.body || {}).mode));
}));
router.get('/policy', asyncHandler(async (req, res) => {
  ok(res, require('../services/policy.service').getPolicy(currentId()));
}));

// 强制关机
router.post('/command/shutdown', asyncHandler(async (req, res) => {
  const result = await commandSvc.sendShutdown({
    force: !!(req.body && req.body.force),
    reason: (req.body && req.body.reason) || '',
  });
  ok(res, result);
}));

// 当前会话
router.get('/session', asyncHandler(async (req, res) => {
  const s = sessionSvc.getCurrentSession();
  if (!s) fail('E-SESSION-01', '当前没有进行中的课堂会话');
  ok(res, s);
}));

// 登记名单
router.get('/students', asyncHandler(async (req, res) => {
  const { status, group } = req.query;
  ok(res, db.queryStudents(currentId(), { status: status || undefined, group: group || undefined }));
}));

// 任务列表
router.get('/tasks', asyncHandler(async (req, res) => {
  ok(res, taskSvc.listTasksWithStats(currentId()));
}));

// 导出（单文件下载）。format=xlsx|csv，scope=current|history，report 可选。
router.get('/export', asyncHandler(async (req, res) => {
  const scope = req.query.scope || 'current';
  const format = (req.query.format || 'csv').toLowerCase();
  const report = req.query.report;
  const manifest = exportSvc.createExport({
    scope, formats: [format], reports: report ? [report] : undefined,
  });
  const file = manifest.files.find((f) => f.format === format && (!report || f.report === report))
    || manifest.files.find((f) => f.format === format);
  if (!file) fail('E-NOTFOUND', '未生成导出文件');
  const { filePath } = exportSvc.resolveFile(manifest.exportId, file.fileName);
  res.setHeader('Content-Type', CONTENT_TYPES[format] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  res.sendFile(filePath);
}));

module.exports = router;
