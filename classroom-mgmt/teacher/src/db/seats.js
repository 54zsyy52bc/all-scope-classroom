'use strict';
// =============================================================================
// 座位播种模块（从 db/index.js 抽出，避免仓储主文件超 300 行）
//   seedSeats            开课时按"人数÷分组大小"均分播种
//   seedSeatsByGroups    v4.2：按班级预设自定义分组播种（组名自定义生效）
//   admitSeatsTo         课堂进行中把座位上限扩容到 newTotal（只补种新增座位，
//                        绝不重跑 seedSeats 以免清空已登记学生）
// 依赖由 db/index 注入（S / cfg / seatNum / upsertStudent），保持单一职责。
// =============================================================================
module.exports = ({ S, cfg, seatNum, upsertStudent }) => {
  function seedOne(sessionId, seat, groupId) {
    upsertStudent({ sessionId, seat, groupId, patch: { checkin_status: 'pending', return_status: 'pending', name: null, student_no: null } });
  }

  function seedSeats(sessionId, totalSeats, groupSize) {
    const gs = groupSize || cfg.GROUP_SIZE;
    for (let i = 1; i <= totalSeats; i += 1) seedOne(sessionId, seatNum(i), 'G' + Math.floor((i - 1) / gs) + 1);
  }

  function seedSeatsByGroups(sessionId, groups) {
    let n = 0;
    for (const g of groups || []) {
      const size = Math.max(1, Math.floor(Number(g && g.size) || cfg.GROUP_SIZE));
      const gid = (g && g.groupId && String(g.groupId).trim()) || ('G' + Math.floor(n / size + 1));
      for (let k = 0; k < size; k += 1) { n += 1; seedOne(sessionId, seatNum(n), gid); }
    }
    return n; // 实际生成座位数 = Σ groups.size
  }

  function admitSeatsTo(sessionId, newTotal, groupSize) {
    const row = S().get('t_session', { session_id: sessionId });
    if (!row) return null;
    const cur = row.total_seats || 0;
    const target = Number(newTotal);
    if (!Number.isInteger(target) || target > 99 || target < cur) {
      return { expanded: false, totalSeats: cur, reason: target < cur ? 'no-shrink' : 'over-limit' };
    }
    if (target === cur) return { expanded: false, totalSeats: cur };
    const gs = groupSize || cfg.GROUP_SIZE;
    S().update('t_session', { session_id: sessionId }, { total_seats: target });
    for (let i = cur + 1; i <= target; i += 1) seedOne(sessionId, seatNum(i), 'G' + Math.floor((i - 1) / gs) + 1);
    S().insertEvent({
      session_id: sessionId, ts: Date.now(), type: 'admit', seat: null,
      detail: JSON.stringify({ from: cur, to: target }),
      msg_id: 'admit-' + sessionId + '-' + target + '-' + Date.now(),
    });
    return { expanded: true, totalSeats: target, from: cur };
  }

  return { seedSeats, seedSeatsByGroups, admitSeatsTo };
};
