'use strict';
// 预设路由：班级 / 活动预设 CRUD（preset.service）与预设包导入/导出（preset-pkg.service）。
const express = require('express');
const presetSvc = require('../services/preset.service');
const presetPkgSvc = require('../services/preset-pkg.service');
const { ok, asyncHandler } = require('../response');

const router = express.Router();

// ---------------- 预设包 导出 / 导入（v4，办公端 Studio ↔ 大屏）----------------
router.get('/presets/export', asyncHandler(async (req, res) => {
  ok(res, presetPkgSvc.exportPackage());
}));
router.post('/presets/import', asyncHandler(async (req, res) => {
  // 默认只预演（preview）；?commit=true 才真正落库
  const commit = req.query.commit === 'true' || req.query.commit === '1';
  ok(res, commit ? presetPkgSvc.commitImport(req.body || {}) : presetPkgSvc.previewImport(req.body || {}));
}));

// ---------------- 班级预设 ----------------
router.get('/presets/classes', asyncHandler(async (req, res) => {
  ok(res, presetSvc.listClasses());
}));
router.get('/presets/classes/:presetId', asyncHandler(async (req, res) => {
  ok(res, presetSvc.getClass(req.params.presetId));
}));
router.post('/presets/classes', asyncHandler(async (req, res) => {
  ok(res, presetSvc.createClass(req.body || {}), 201);
}));
router.put('/presets/classes/:presetId', asyncHandler(async (req, res) => {
  ok(res, presetSvc.updateClass(req.params.presetId, req.body || {}));
}));
router.delete('/presets/classes/:presetId', asyncHandler(async (req, res) => {
  ok(res, presetSvc.removeClass(req.params.presetId));
}));

// ---------------- 活动预设 ----------------
router.get('/presets/activities', asyncHandler(async (req, res) => {
  ok(res, presetSvc.listActivities());
}));
router.get('/presets/activities/:presetId', asyncHandler(async (req, res) => {
  ok(res, presetSvc.getActivity(req.params.presetId));
}));
router.post('/presets/activities', asyncHandler(async (req, res) => {
  ok(res, presetSvc.createActivity(req.body || {}), 201);
}));
router.put('/presets/activities/:presetId', asyncHandler(async (req, res) => {
  ok(res, presetSvc.updateActivity(req.params.presetId, req.body || {}));
}));
router.delete('/presets/activities/:presetId', asyncHandler(async (req, res) => {
  ok(res, presetSvc.removeActivity(req.params.presetId));
}));

module.exports = router;
