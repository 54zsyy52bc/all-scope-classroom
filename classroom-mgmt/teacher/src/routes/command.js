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

// 激活座位：学生登记的座位号超出课堂范围时，教师一键扩容接纳（座位超范围提示的闭环操作）
router.post('/commands/admit-seat', asyncHandler(async (req, res) => {
  const { seat } = req.body || {};
  const result = await commandSvc.sendAdmit({ seat });
  ok(res, result);
}));

// 撤销关机：学生归还后仍需继续使用时，教师一键中止已下发的关机（学生端执行 shutdown /a）
router.post('/commands/shutdown-cancel', asyncHandler(async (req, res) => {
  const result = await commandSvc.cancelShutdown();
  ok(res, result);
}));

module.exports = router;
