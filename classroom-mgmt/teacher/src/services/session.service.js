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
  // 坏 JSON 一律安全回落 null（safeParseJSON 函数声明提升，此处可前置使用）
  let equipment = row.equipment_json ? safeParseJSON(row.equipment_json) : null;
  let lesson = row.lesson_json ? safeParseJSON(row.lesson_json) : null;
  let appSet = row.appset_json ? safeParseJSON(row.appset_json) : null; // v5.6 应用包快照
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
    // v5.2 课时快照：{ lessonId, name, activityIds }（开课时快照，之后编辑预设不影响本节课）
    lesson: lesson || null,
    // v5.6 应用包快照（应用名列表随 sync 下发，学生端按名过滤本机磁贴）
    appSet: appSet || null,
    equipment: equipment || [],
    policyMode: row.policy_mode || 'open',
    // v5 组机：terminalCount=机房台数 / groupMembers=每组人数（totalSeats = T×K）
    terminalCount: row.terminal_count || null,
    groupMembers: row.group_members || null,
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
function safeParseJSON(s) { try { return JSON.parse(s); } catch (_e) { return null; } }
function activityEquipment(activityPreset) {
  return activityPreset ? (safeParseJSON(activityPreset.equipment_json) || []) : [];
}
function activityTemplates(activityPreset) {
  return activityPreset ? (safeParseJSON(activityPreset.task_templates_json) || []) : [];
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
// 班级预设的课时包（v5.2）：[{ lessonId, name, activityIds, equipment }...]；未配置返回 []
function classLessons(classPreset) {
  if (!classPreset) return [];
  const l = safeParseJSON(classPreset.lessons_json);
  return Array.isArray(l) ? l : [];
}
function equipmentRows(activityPreset, classEquip, lessonEquip) {
  const byEq = {};
  // 合并顺序：班级"上课器材" → 课时器材 → 活动器材（越具体越优先，同 eqId 后者覆盖）
  const merge = (list) => {
    for (const e of list || []) {
      if (e && e.eqId) byEq[e.eqId] = { eq_id: e.eqId, eq_name: e.eqName, category: e.category || '其他', total: 0 };
    }
  };
  merge(classEquip);
  merge(lessonEquip);
  merge(activityEquipment(activityPreset));
  return Object.keys(byEq).map((k) => byEq[k]);
}
function equipmentForStudents(activityPreset, classEquip, lessonEquip) {
  const byEq = {};
  const put = (list) => {
    for (const e of list || []) {
      if (e && e.eqId) byEq[e.eqId] = {
        eqId: e.eqId, eqName: e.eqName, category: e.category || '其他',
        preset: Number.isInteger(Number(e.preset)) && Number(e.preset) > 0 ? Number(e.preset) : 1,
      };
    }
  };
  // 班级"上课器材" + 课时器材 + 活动器材合并去重（同 eqId 以更具体者为准）；全空 → 种子器材
  put(classEquip);
  put(lessonEquip);
  put(activityEquipment(activityPreset));
  const merged = Object.keys(byEq).map((k) => byEq[k]);
  if (merged.length) return merged;
  return db.queryEquipment().map((e) => ({
    eqId: e.eq_id, eqName: e.eq_name, category: e.category || '其他', preset: 1,
  }));
}
function startSession({ teacher, className, totalSeats, groupSize, classPresetId, activityPresetId, lessonId, appSetId, terminalCount, groupMembers }) {
  if (!teacher || !String(teacher).trim()) {
    fail('E-VAL-01', 'teacher 为必填项');
  }
  const active = db.getCurrentSession();
  if (active && active.phase !== 'closed') {
    // v5.1：开新课即自动归档上一节遗留会话（含服务重启残留的 waiting），避免"一进来就是上节课"
    try {
      db.updateSession(active.session_id, { phase: 'closed', end_time: nowMs() });
      sse.publish('phase.changed', { from: active.phase, to: 'closed' });
      require('./policy.service').applyPolicy(active.session_id);
      // eslint-disable-next-line no-console
      console.log(`[session] 开新课前自动归档上节课 ${active.session_id}（${active.phase}→closed）`);
    } catch (_e) { /* 归档失败不阻断开新 */ }
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
  // v5.2 课时预设：随班级预设一起加载；课时器材并入开课快照，课时活动作任务模板来源
  let lesson = null;
  let lessonEquip = [];
  if (lessonId) {
    if (!classPreset) fail('E-VAL-01', '选择课时须先选择班级预设');
    lesson = classLessons(classPreset).find((l) => l && l.lessonId === lessonId) || null;
    if (!lesson) fail('E-NOTFOUND', '该班级预设下不存在所选课时');
    lessonEquip = Array.isArray(lesson.equipment) ? lesson.equipment : [];
  }
  // v5.6 应用包（与班级/课时互不绑定，开课时选用）；未知 appSetId 拒绝开课
  let appSet = null;
  if (appSetId) {
    appSet = require('./appset.service').getAppSet(appSetId);
  }
  // v4.2：上课器材 = 班级"上课器材" + 课时器材 + 活动器材 合并去重；全无 → 种子
  const clsEquip = classEquipment(classPreset);
  const equipment = equipmentForStudents(activityPreset, clsEquip, lessonEquip);
  // v4.2：班级预设自定义分组（组名/每组人数）→ 座位种子按分组生成
  const groups = classGroups(classPreset);
  const sessionId = makeSessionId(), now = nowMs();
  // 服务端兜底范围校验（前端已有，防 API 直调造出超大/非法会话）
  const seatsRaw = totalSeats != null ? Number(totalSeats) : cfg.SEAT_COUNT;
  if (!Number.isInteger(seatsRaw) || seatsRaw < 1 || seatsRaw > 99) {
    fail('E-VAL-01', '座位数须为 1-99 的整数');
  }
  const gsRaw = groupSize != null ? Number(groupSize) : cfg.GROUP_SIZE;
  if (!Number.isInteger(gsRaw) || gsRaw < 1 || gsRaw > 20) {
    fail('E-VAL-01', '分组大小须为 1-20 的整数');
  }
  let seats = seatsRaw, groupSeed = null;
  // v5 组机（全域学生桌面）：无班级预设但给了终端台数×每组人数 → 每台=一组（终端），座位=组内序号
  const termRaw = terminalCount != null ? Number(terminalCount) : null;
  const memRaw = groupMembers != null ? Number(groupMembers) : null;
  const termMode = termRaw != null && memRaw != null && !groups.length;
  if (termMode) {
    if (!Number.isInteger(termRaw) || termRaw < 1 || termRaw > 50) fail('E-VAL-01', '终端台数须为 1-50');
    if (!Number.isInteger(memRaw) || memRaw < 1 || memRaw > 20) fail('E-VAL-01', '每组人数须为 1-20');
    seats = termRaw * memRaw;
    groupSeed = Array.from({ length: termRaw }, (_, i) => ({ groupId: 'G' + (i + 1), size: memRaw }));
  }
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
    lesson_json: lesson ? JSON.stringify({ lessonId: lesson.lessonId, name: lesson.name, activityIds: lesson.activityIds || [] }) : null,
    appset_json: appSet ? JSON.stringify({ appSetId: appSet.appSetId, name: appSet.name, apps: appSet.apps }) : null,
    terminal_count: termMode ? termRaw : null,
    group_members: termMode ? memRaw : null,
  });
  if (groupSeed) db.seedSeatsByGroups(sessionId, groupSeed);
  else db.seedSeats(sessionId, seats, groupSize || cfg.GROUP_SIZE);
  // 器材注册进 t_equipment（班级上课器材 + 课时器材 + 活动器材），保证借还台账 eqName 映射正确
  const eqRows = equipmentRows(activityPreset, clsEquip, lessonEquip);
  if (eqRows.length) db.upsertEquipment(eqRows);
  const broadcast = bridge.publishCommand('start', {});
  // 器材清单随课堂下发（学生端据此渲染登记页器材列表；lessonName 为 v5.2 加性字段，老学生端忽略）
  const equipBroadcast = bridge.publishCommand('equipment', { equipment, activityName, lessonName: lesson ? lesson.name : null });
  const session = toSession(db.getSession(sessionId));
  sse.publish('session.started', session);
  sse.publish('phase.changed', { from: 'waiting', to: 'checkin' });
  // 上课即下发锁定策略（activity 模式下 checkin 阶段不锁）
  try { require('./policy.service').applyPolicy(sessionId); } catch (_e) { /* 策略失败不阻断上课 */ }
  return {
    session, broadcast, equipBroadcast, equipment,
    // 课时所选时：任务模板 = 课时挂的全部活动预设模板合集（按 id 找不到的活动跳过）
    taskTemplates: lesson ? lessonTemplates(lesson) : activityTemplates(activityPreset),
    activityName,
    lessonName: lesson ? lesson.name : null,
    appSetName: appSet ? appSet.name : null,
  };
}
// v5.2：课时挂的活动 → 任务模板合集（去重按标题；无模板的活动用活动名占位，保证课时内容可见）
function lessonTemplates(lesson) {
  const out = [];
  const seen = new Set();
  for (const actId of (lesson && lesson.activityIds) || []) {
    const a = actId ? db.getActivityPreset(String(actId)) : null;
    if (!a) continue;
    const tpls = safeParseJSON(a.task_templates_json) || [];
    if (tpls.length) {
      for (const t of tpls) {
        const key = String(t && t.title || '').trim();
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        out.push({ title: String(t.title || '未命名任务').trim(), desc: t && t.desc ? String(t.desc).trim() : '' });
      }
    } else {
      const name = String(a.name || '').trim();
      if (name && !seen.has(name)) { seen.add(name); out.push({ title: name, desc: '来自课时活动预设' }); }
    }
  }
  return out;
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
