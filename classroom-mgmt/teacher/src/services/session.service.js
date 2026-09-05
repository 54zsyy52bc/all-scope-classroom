'use strict';
// 会话生命周期：开始上课、阶段流转（单向不可回退）、下课。含种子载入。
const cfg = require('../config');
const db = require('../db');
const sse = require('../sse');
const bridge = require('../mqtt/bridge');
const { fail, BusinessError } = require('../errors');
const { makeSessionId, nowMs } = require('../utils');

// 阶段机：checkin → task → return → closed（允许 checkin 直接跳 return）
const ALLOWED = {
  waiting: ['checkin'],
  checkin: ['task', 'return'],
  task: ['return', 'closed'],
  return: ['closed'],
  closed: [],
};

function toSession(row) {
  if (!row) return null;
  let equipment = null;
  if (row.equipment_json) {
    try { equipment = JSON.parse(row.equipment_json); } catch (_e) { /* 忽略坏 JSON */ }
  }
  return {
    sessionId: row.session_id,
    teacher: row.teacher,
    className: row.class_name || null,
    startTime: row.start_time || null,
    endTime: row.end_time || null,
    phase: row.phase,
    totalSeats: row.total_seats,
    exportFlag: !!row.export_flag,
    classPresetId: row.class_preset_id || null,
    activityPresetId: row.activity_preset_id || null,
    activityName: row.activity_name || null,
    equipment: equipment || [],
    policyMode: row.policy_mode || 'open',
  };
}

function loadEquipmentSeeds() {
  try {
    const data = require('fs').readFileSync(cfg.EQUIP_FILE, 'utf8');
    const list = JSON.parse(data);
    if (Array.isArray(list) && list.length) db.upsertEquipment(list);
  } catch (e) {
    // 种子缺失不阻断启动，仅告警
    // eslint-disable-next-line no-console
    console.warn('[seed] 器材种子载入失败:', e.message);
  }
}

// 活动预设的器材清单 → t_equipment 行（供借还台账 eqName 映射）+ 学生端下发结构
function safeParseJSON(s) {
  try { return JSON.parse(s); } catch (_e) { return null; }
}
function activityEquipment(activityPreset) {
  if (!activityPreset) return [];
  return safeParseJSON(activityPreset.equipment_json) || [];
}
function activityTemplates(activityPreset) {
  if (!activityPreset) return [];
  return safeParseJSON(activityPreset.task_templates_json) || [];
}
// 班级预设的"上课器材"（v4.2：与器材字典互通，随开课与活动器材合并下发）
function classEquipment(classPreset) {
  if (!classPreset) return [];
  return safeParseJSON(classPreset.equipment_json) || [];
}
// 班级预设的分组配置（v4.2）：[{ groupId, size }...]；未配置返回 []
function classGroups(classPreset) {
  if (!classPreset) return [];
  const g = safeParseJSON(classPreset.groups_json);
  return Array.isArray(g) && g.length ? g : [];
}

function equipmentRows(activityPreset, classEquip) {
  const byEq = {};
  // 班级"上课器材"先注册；同一 eqId 以活动器材覆盖（活动专属配置优先）
  const merge = (list) => {
    for (const e of list || []) {
      if (e && e.eqId) byEq[e.eqId] = { eq_id: e.eqId, eq_name: e.eqName, category: e.category || '其他', total: 0 };
    }
  };
  merge(classEquip);
  merge(activityEquipment(activityPreset));
  return Object.keys(byEq).map((k) => byEq[k]);
}

function equipmentForStudents(activityPreset, classEquip) {
  const byEq = {};
  const put = (list) => {
    for (const e of list || []) {
      if (e && e.eqId) byEq[e.eqId] = {
        eqId: e.eqId, eqName: e.eqName, category: e.category || '其他',
        preset: Number.isInteger(Number(e.preset)) && Number(e.preset) > 0 ? Number(e.preset) : 1,
      };
    }
  };
  // 班级"上课器材" + 活动器材合并去重（同 eqId 以活动器材为准）；两者都空 → 种子器材
  put(classEquip);
  put(activityEquipment(activityPreset));
  const merged = Object.keys(byEq).map((k) => byEq[k]);
  if (merged.length) return merged;
  return db.queryEquipment().map((e) => ({
    eqId: e.eq_id, eqName: e.eq_name, category: e.category || '其他', preset: 1,
  }));
}

function startSession({ teacher, className, totalSeats, groupSize, classPresetId, activityPresetId }) {
  if (!teacher || !String(teacher).trim()) {
    fail('E-VAL-01', 'teacher 为必填项');
  }
  const active = db.getCurrentSession();
  if (active && active.phase !== 'closed') {
    fail('E-SESSION-02', '已有进行中的课堂会话，请先下课或关闭');
  }

  // 班级预设：未显式提供班级名/座位数/分组时，从预设加载
  let classPreset = null;
  if (classPresetId) {
    classPreset = db.getClassPreset(classPresetId);
    if (!classPreset) fail('E-NOTFOUND', '班级预设不存在');
  }
  if (!className && classPreset) className = classPreset.name;
  if (totalSeats == null && classPreset) totalSeats = classPreset.total_seats;
  if (groupSize == null && classPreset) groupSize = classPreset.group_size;

  // 活动预设：器材清单 + 任务模板 + 活动名
  let activityPreset = null;
  if (activityPresetId) {
    activityPreset = db.getActivityPreset(activityPresetId);
    if (!activityPreset) fail('E-NOTFOUND', '活动预设不存在');
  }
  const activityName = activityPreset ? activityPreset.name : null;
  // v4.2：上课器材 = 班级预设"上课器材" + 活动器材 合并去重；都无 → 种子
  const clsEquip = classEquipment(classPreset);
  const equipment = equipmentForStudents(activityPreset, clsEquip);

  // v4.2：班级预设自定义分组（组名/每组人数）→ 座位种子按分组生成
  const groups = classGroups(classPreset);
  const sessionId = makeSessionId();
  const now = nowMs();
  // 服务端兜底范围校验（前端已有，防 API 直调造出超大/非法会话）
  const seatsRaw = totalSeats != null ? Number(totalSeats) : cfg.SEAT_COUNT;
  if (!Number.isInteger(seatsRaw) || seatsRaw < 1 || seatsRaw > 99) {
    fail('E-VAL-01', '座位数须为 1-99 的整数');
  }
  const gsRaw = groupSize != null ? Number(groupSize) : cfg.GROUP_SIZE;
  if (!Number.isInteger(gsRaw) || gsRaw < 1 || gsRaw > 20) {
    fail('E-VAL-01', '分组大小须为 1-20 的整数');
  }
  let seats = seatsRaw;
  let groupSeed = null;
  if (groups.length) {
    const sum = groups.reduce((acc, g) => acc + Math.max(1, Math.floor(Number(g.size) || 1)), 0);
    if (sum < 1 || sum > 99) fail('E-VAL-01', '自定义分组座位合计须在 1-99 之间');
    seats = sum; // 自定义分组时座位数以各组之和为准
    groupSeed = groups;
  }
  // 新课堂开课即清零历史冲突（t_conflict 以 seat 为主键跨会话累积，
  // 不清除会把上一节课的换机/换座误报为本次冲突）
  try { db.clearConflicts(); } catch (_e) { /* 冲突清理失败不阻断开课 */ }
  db.createSession({
    session_id: sessionId,
    teacher: String(teacher).trim(),
    class_name: className ? String(className) : null,
    start_time: now,
    end_time: null,
    phase: 'checkin',
    total_seats: seats,
    export_flag: 0,
    topic_plan: cfg.TOPIC_PLAN,
    class_preset_id: classPreset ? classPreset.preset_id : null,
    activity_preset_id: activityPreset ? activityPreset.preset_id : null,
    activity_name: activityName,
    equipment_json: JSON.stringify(equipment),
  });
  if (groupSeed) db.seedSeatsByGroups(sessionId, groupSeed);
  else db.seedSeats(sessionId, seats, groupSize || cfg.GROUP_SIZE);
  // 器材注册进 t_equipment（班级上课器材 + 活动器材），保证借还台账 eqName 映射正确
  const eqRows = equipmentRows(activityPreset, clsEquip);
  if (eqRows.length) db.upsertEquipment(eqRows);

  const broadcast = bridge.publishCommand('start', {});
  // 器材清单随上课下发（学生端据此渲染登记页器材列表）
  const equipBroadcast = bridge.publishCommand('equipment', { equipment, activityName });
  const session = toSession(db.getSession(sessionId));

  sse.publish('session.started', session);
  sse.publish('phase.changed', { from: 'waiting', to: 'checkin' });
  // 上课即下发锁定策略（activity 模式下 checkin 阶段不锁）
  try { require('./policy.service').applyPolicy(sessionId); } catch (_e) { /* 策略失败不阻断上课 */ }
  return {
    session, broadcast, equipBroadcast, equipment,
    taskTemplates: activityTemplates(activityPreset),
    activityName,
  };
}

function transitionPhase(sessionId, toPhase) {
  const row = db.getSession(sessionId);
  if (!row) fail('E-NOTFOUND', '会话不存在');
  const from = row.phase;
  if (!ALLOWED[from] || !ALLOWED[from].includes(toPhase)) {
    fail('E-PHASE-01', `不能从 ${from} 流转到 ${toPhase}`);
  }
  const patch = { phase: toPhase };
  if (toPhase === 'closed') patch.end_time = nowMs();
  db.updateSession(sessionId, patch);

  let broadcast = { delivered: true, topic: bridge.CMD_BROADCAST, msgId: null };
  if (toPhase === 'return') {
    broadcast = bridge.publishCommand('end', {});
  }
  const session = toSession(db.getSession(sessionId));
  sse.publish('phase.changed', { from, to: toPhase });
  // 阶段变更 → 重算锁定策略（activity 模式：return 阶段解锁归还，closed 解除）
  try { require('./policy.service').applyPolicy(sessionId); } catch (_e) { /* 忽略 */ }
  return { session, broadcast };
}

function endSession(sessionId) {
  return transitionPhase(sessionId, 'return');
}

function listSessions({ phase, page, limit } = {}) {
  const r = db.listSessions({ phase, page, limit });
  return { items: r.items.map(toSession), total: r.total, page: r.page, limit: r.limit, hasMore: r.hasMore };
}

function getCurrentSession() {
  return toSession(db.getCurrentSession());
}

function getSession(sessionId) {
  return toSession(db.getSession(sessionId));
}

module.exports = {
  ALLOWED,
  toSession,
  startSession,
  transitionPhase,
  endSession,
  listSessions,
  getCurrentSession,
  getSession,
};
