'use strict';
// 行 → DTO 映射、分页与聚合。纯函数：无 IO、无业务判断、无存储依赖。
// 从 db/index.js 抽离，使仓储层只负责存取，映射规则集中可测。
const cfg = require('../config');
const { seatNum } = require('../utils');

// 在线判定：last_seen_at 距今不超过阈值
function computeOnline(row, threshold) {
  if (!row || row.last_seen_at == null) return false;
  const t = threshold != null ? threshold : cfg.OFFLINE_THRESHOLD_MS;
  return Date.now() - row.last_seen_at <= t;
}

// 通用内存分页（列表接口一律分页，不返回全量）
function paginate(rows, page = 1, limit = 50) {
  const total = rows.length;
  const p = Number(page) > 0 ? Number(page) : 1;
  const l = Number(limit) > 0 ? Number(limit) : 50;
  const startIdx = (p - 1) * l;
  return { slice: rows.slice(startIdx, startIdx + l), total, page: p, limit: l, hasMore: startIdx + l < total };
}

function toStudentDTO(row) {
  return {
    stuId: row.stu_id,
    sessionId: row.session_id,
    seat: row.seat,
    groupId: row.group_id,
    name: row.name || null,
    studentNo: row.student_no || null,
    checkinTime: row.checkin_time || null,
    checkinStatus: row.checkin_status,
    machineId: row.machine_id || null,
    returnStatus: row.return_status,
    online: computeOnline(row),
    lastSeenAt: row.last_seen_at || null,
  };
}

function toEventDTO(row) {
  let detail = null;
  if (row.detail) {
    try { detail = JSON.parse(row.detail); } catch (_e) { detail = null; }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    ts: row.ts,
    type: row.type,
    seat: row.seat || null,
    msgId: row.msg_id || null,
    detail,
  };
}

function toConflictDTO(row) {
  let machineIds = [];
  try { machineIds = JSON.parse(row.machine_ids) || []; } catch (_e) { machineIds = []; }
  return {
    seat: row.seat,
    machineIds,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    messageCount: row.message_count,
  };
}

function toBorrowDTO(row, eq) {
  const e = eq || {};
  return {
    borrowId: row.borrow_id,
    sessionId: row.session_id,
    seat: row.seat,
    groupId: row.group_id,
    eqId: row.eq_id,
    eqName: e.eq_name || row.eq_id,
    qty: row.qty,
    borrowTime: row.borrow_time || null,
    returnTime: row.return_time || null,
    status: row.status,
  };
}

// 按器材汇总借出/归还/未还数量。eqOf: (eqId) => equipment row
function summarizeBorrows(rows, eqOf) {
  const map = {};
  for (const r of rows) {
    const eq = eqOf(r.eq_id) || {};
    if (!map[r.eq_id]) {
      map[r.eq_id] = {
        eqId: r.eq_id,
        eqName: eq.eq_name || r.eq_id,
        total: eq.total || 0,
        borrowed: 0,
        returned: 0,
        outstanding: 0,
      };
    }
    map[r.eq_id].borrowed += r.qty || 0;
    if (r.status === 'returned') map[r.eq_id].returned += r.qty || 0;
  }
  return Object.values(map).map((s) => {
    s.outstanding = s.borrowed - s.returned;
    return s;
  });
}

function bySeat(a, b) {
  return seatNum(a.seat).localeCompare(seatNum(b.seat));
}

module.exports = {
  computeOnline,
  paginate,
  toStudentDTO,
  toEventDTO,
  toConflictDTO,
  toBorrowDTO,
  summarizeBorrows,
  bySeat,
};
