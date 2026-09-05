'use strict';
const express = require('express');
const dashboardSvc = require('../services/dashboard.service');
const sse = require('../sse');
const { ok, asyncHandler } = require('../response');

const router = express.Router();

// 全量快照（F5 恢复用）
router.get('/dashboard/snapshot', asyncHandler(async (req, res) => {
  ok(res, dashboardSvc.getSnapshot());
}));

// 座位冲突清单
router.get('/dashboard/conflicts', asyncHandler(async (req, res) => {
  ok(res, dashboardSvc.getConflicts());
}));

// 实时事件流 SSE
router.get('/dashboard/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const lastId = req.headers['last-event-id'];
  sse.addClient(res, lastId);
  req.on('close', () => {
    sse.removeClient(res);
  });
});

module.exports = router;
