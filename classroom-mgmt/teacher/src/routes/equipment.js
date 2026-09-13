'use strict';
const express = require('express');
const db = require('../db');
const { ok, asyncHandler } = require('../response');
const { fail } = require('../errors');

const router = express.Router();

// 座位号 → 0 补位并校验 1..99
function normSeat(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1 || n > 99) return null;
  return String(n).padStart(2, '0');
}

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

// 教师补录借用（L1 修复）：
//   学生端在归还阶段空态会提示"联系老师补登"，教师端原先无补登入口；
//   该接口允许教师把"已发放但系统未登记"的器材手动建一条借出记录。
//   与正常 checkin 的 insertBorrow 共用存储；同一座位多条记录视为多次借用。
router.post('/sessions/:sessionId/borrows', asyncHandler(async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!db.getSession(sessionId)) fail('E-NOTFOUND', '会话不存在');
  const body = req.body || {};
  const seat = normSeat(body.seat);
  if (!seat) fail('E-VAL-01', '座位号必须是 1..99 的整数');
  const eqId = body.eqId == null ? '' : String(body.eqId).trim();
  if (!eqId) fail('E-VAL-01', '缺少器材标识 eqId');
  const equip = db.queryEquipment().find((e) => e.eq_id === eqId);
  if (!equip) fail('E-VAL-01', '未知器材：' + eqId);
  const qty = parseInt(body.qty, 10);
  if (!Number.isFinite(qty) || qty < 1 || qty > 99) fail('E-VAL-01', '数量必须是 1..99');
  // 座位所属小组：由当前会话快照推导（避免前端传不一致的 groupId）
  const snap = db.queryStudents(sessionId, { limit: 100 }).items.find((s) => s.seat === seat);
  const groupId = (snap && snap.groupId) || body.groupId || 'G?';
  const inserted = db.insertBorrow({
    sessionId,
    seat,
    groupId,
    eqId,
    qty,
    borrowTime: Date.now(),
    status: 'borrowed',
  });
  ok(res, { borrowed: inserted, message: '已补登 ' + seat + ' 号 ' + equip.eq_name + ' ×' + qty });
}));

module.exports = router;
