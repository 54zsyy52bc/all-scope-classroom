'use strict';
const express = require('express');
const commandSvc = require('../services/command.service');
const { ok, asyncHandler } = require('../response');

const router = express.Router();

// 下发关机指令（三重校验：阶段 / 归还 / HMAC）
router.post('/commands/shutdown', asyncHandler(async (req, res) => {
  const result = await commandSvc.sendShutdown({
    force: !!(req.body && req.body.force),
    reason: (req.body && req.body.reason) || '',
  });
  ok(res, result);
}));

// 复位指定座位登记
router.post('/commands/reset', asyncHandler(async (req, res) => {
  const { seat } = req.body || {};
  const result = await commandSvc.sendReset({ seat });
  ok(res, result);
}));

module.exports = router;
