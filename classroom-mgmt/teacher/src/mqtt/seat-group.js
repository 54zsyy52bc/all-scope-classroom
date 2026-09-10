'use strict';
// =============================================================================
// 座位 / 小组推导（从 mqtt/handlers.js 抽出，控文件行数）
//   seatInRange  座位范围守卫：1-99 且不超过本会话总座位数
//   deriveGroup  v5 组机：座位 → 小组（真值优先取播种行，其次按组容量反算）
//   pickGroup    显式组号（排除 '*' 占位）优先，否则按 seat 推导
// 依赖 db + config，保持单一职责，便于单测。
// =============================================================================
const db = require('../db');
const cfg = require('../config');

function seatInRange(seat, totalSeats) {
  const s = String(seat == null ? '' : seat);
  if (!/^\d{1,2}$/.test(s)) return false;
  const n = parseInt(s, 10);
  if (n < 1 || n > 99) return false;
  const total = Number(totalSeats);
  if (Number.isInteger(total) && total >= 1 && n > total) return false;
  return true;
}

// v5 组机：开课时按「组名 / 每组人数」播种过 t_student（每座一行带 group_id）。
// 学生留空小组号时优先取该播种行——比按 GROUP_SIZE 反算可靠：group_members
// 缺失（旧会话 / 列未落库）时用 5 人去切 6 人组会把 06 号错分到 G2。
function deriveGroup(seat) {
  const cur = db.getCurrentSession();
  const padded = String(seat == null ? '' : seat).padStart(2, '0');
  if (cur) {
    const seeded = db.getStudent(cur.session_id, padded);
    if (seeded && seeded.group_id) return seeded.group_id;
  }
  const n = parseInt(seat, 10);
  if (!Number.isFinite(n) || n < 1) return 'G1';
  const k = (cur && cur.group_members) || cfg.GROUP_SIZE || 5;
  return `G${Math.floor((n - 1) / k) + 1}`;
}

function pickGroup(env, seat) { // 显式组号(排除 '*' 占位)优先，否则按 seat 推导
  const raw = (env && env.group) || (env && env.payload && env.payload.group);
  return raw && raw !== '*' ? raw : deriveGroup(seat);
}

module.exports = { seatInRange, deriveGroup, pickGroup };
