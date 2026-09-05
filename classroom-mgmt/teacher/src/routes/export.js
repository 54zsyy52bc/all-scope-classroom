'use strict';
const express = require('express');
const exportSvc = require('../services/export.service');
const db = require('../db');
const { ok, asyncHandler } = require('../response');
const { fail } = require('../errors');

const router = express.Router();

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// 生成报表
router.post('/sessions/:sessionId/exports', asyncHandler(async (req, res) => {
  if (!db.getSession(req.params.sessionId)) fail('E-NOTFOUND', '会话不存在');
  const body = req.body || {};
  const manifest = exportSvc.createExport({
    sessionIds: [req.params.sessionId],
    formats: body.formats,
    reports: body.reports,
  });
  ok(res, manifest, 201);
}));

// 导出批次详情
router.get('/exports/:exportId', asyncHandler(async (req, res) => {
  ok(res, exportSvc.getExport(req.params.exportId));
}));

// 下载文件（不走统一信封，直接返回字节流；白名单防穿越）
router.get('/exports/:exportId/files/:fileName', asyncHandler(async (req, res) => {
  const { filePath, file } = exportSvc.resolveFile(req.params.exportId, req.params.fileName);
  const ext = (file.format === 'xlsx') ? 'xlsx' : 'csv';
  res.setHeader('Content-Type', CONTENT_TYPES[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  res.sendFile(filePath);
}));

module.exports = router;
