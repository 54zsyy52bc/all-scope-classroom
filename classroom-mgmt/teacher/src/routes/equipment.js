'use strict';
const express = require('express');
const db = require('../db');
const { ok, asyncHandler } = require('../response');
const { fail } = require('../errors');

const router = express.Router();

// 器材台账
router.get('/equipment', asyncHandler(async (req, res) => {
  ok(res, db.queryEquipment());
}));

// 器材借还记录（含汇总）
router.get('/sessions/:sessionId/borrows', asyncHandler(async (req, res) => {
  if (!db.getSession(req.params.sessionId)) fail('E-NOTFOUND', '会话不存在');
  const { status, page, limit } = req.query;
  ok(res, db.queryBorrows(req.params.sessionId, {
    status: status || undefined,
    page: page ? parseInt(page, 10) : 1,
    limit: limit ? parseInt(limit, 10) : 100,
  }));
}));

module.exports = router;
