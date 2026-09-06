'use strict';
// 数据库工厂 + 仓储函数：优先 better-sqlite3，失败降级 JSON（同一接口）。
// 本文件只做存取与外键前置校验，不做业务决策；行→DTO 映射在 mappers.js，外键守卫在 refguard.js。
const cfg = require('../config');
const { seatNum, genId } = require('../utils');
const {
  computeOnline, paginate, toStudentDTO, toEventDTO, toConflictDTO, toBorrowDTO, summarizeBorrows, bySeat,
} = require('./mappers');
const { ensureSession, ensureTask } = require('./refguard');

let storage = null;
let mode = 'none';

function initSqlite() {
  const Database = require('better-sqlite3');
  const db = new Database(cfg.DB_PATH);
  const { SqlStorage } = require('./storage-sql');
  return new SqlStorage(db);
}

function initJson() {
  const { JsonStorage } = require('./storage-json');
  const file = cfg.DB_PATH.replace(/\.db$/, '.json');
  return new JsonStorage(file);
}

function init() {
  try {
    storage = initSqlite();
    mode = 'sqlite';
    return { mode };
  } catch (e) {
    storage = initJson();
    mode = 'json';
    return { mode, reason: e.message };
  }
}

function S() {
  if (!storage) throw new Error('storage not initialized; call db.init() first');
  return storage;
}

function getMode() { return mode; }

function stuId(sessionId, seat) { return `${sessionId}::${seat}`; }

// 原子执行一段写逻辑：事件标记（msg_id 幂等）与业务写入同生共死。
// 业务写入失败时整段回滚，避免 msg_id 被毒丸占用导致 MQTT 重投后消息永久丢失。
function transaction(fn) {
  return S().transaction(fn);
}

// ---------------- Session ----------------
function createSession(row) {
  return S().insert('t_session', row);
}
function getSession(sessionId) {
  return S().get('t_session', { session_id: sessionId });
}
function getCurrentSession() {
  const rows = S().find('t_session', {}).filter((r) => r.phase !== 'closed');
  if (rows.length === 0) return null;
  rows.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
  return rows[0];
}
function listSessions({ phase, page = 1, limit = 20 } = {}) {
  let rows = S().all('t_session');
  if (phase) rows = rows.filter((r) => r.phase === phase);
  rows.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
  const pg = paginate(rows, page, limit);
  return { items: pg.slice, total: pg.total, page: pg.page, limit: pg.limit, hasMore: pg.hasMore };
}
function updateSession(sessionId, patch) {
  S().update('t_session', { session_id: sessionId }, patch);
  return getSession(sessionId);
}

// ---------------- Student / Seat ----------------
// 座位播种（均分 / 自定义分组 / 扩容补种）抽到 ./seats.js，本文件只保留仓储主逻辑
const { seedSeats, seedSeatsByGroups, admitSeatsTo } = require('./seats')({ S, cfg, seatNum, upsertStudent });
function upsertStudent({ sessionId, seat, groupId, patch = {} }) {
  ensureSession(S(), sessionId);
  const sid = stuId(sessionId, seat);
  const row = Object.assign({ stu_id: sid, session_id: sessionId, seat, group_id: groupId }, patch);
  return S().upsert('t_student', row);
}
function getStudent(sessionId, seat) {
  return S().get('t_student', { session_id: sessionId, seat });
}
function touchSeat(sessionId, seat, ts) {
  return S().update('t_student', { session_id: sessionId, seat }, { last_seen_at: ts });
}
function recordCheckin({ sessionId, seat, groupId, name, studentNo, machineId, checkinTime, equipments }) {
  const student = upsertStudent({
    sessionId, seat, groupId,
    patch: {
      name: name || null, student_no: studentNo || null, machine_id: machineId || null,
      checkin_status: 'done', checkin_time: checkinTime, return_status: 'pending',
    },
  });
  if (Array.isArray(equipments)) {
    for (const eq of equipments) {
      insertBorrow({ sessionId, seat, groupId, eqId: eq.eqId, qty: eq.qty, borrowTime: checkinTime, status: 'borrowed' });
    }
  }
  return student;
}
function queryStudents(sessionId, { status, group, page = 1, limit = 50 } = {}) {
  let rows = S().find('t_student', { session_id: sessionId });
  if (status) rows = rows.filter((r) => r.checkin_status === status);
  if (group) rows = rows.filter((r) => r.group_id === group);
  rows.sort(bySeat);
  const pg = paginate(rows, page, limit);
  return {
    items: pg.slice.map(toStudentDTO),
    total: pg.total, page: pg.page, limit: pg.limit, hasMore: pg.hasMore,
  };
}

// ---------------- Task（活动）----------------
function createTask({ sessionId, taskId, title, desc, publishTime, source, activityPresetId,
  timed, durationSec, timerState, timerStartedAt, timerPausedAt, timerRemainingMs }) {
  // 必填校验：键名写错会静默写入 NULL 主键（曾导致任务不可见）
  if (!sessionId) throw new Error('E-VAL-01: createTask 缺少 sessionId');
  if (!taskId) throw new Error('E-VAL-01: createTask 缺少 taskId');
  ensureSession(S(), sessionId);
  return S().insert('t_task', {
    task_id: taskId, session_id: sessionId, title,
    desc: desc || null,
    publish_time: publishTime != null ? publishTime : Date.now(),
    close_time: null,
    source: source || 'custom',
    activity_preset_id: activityPresetId || null,
    timed: timed ? 1 : 0,
    duration_sec: durationSec != null ? durationSec : null,
    timer_state: timerState || 'idle',
    timer_started_at: timerStartedAt || null,
    timer_paused_at: timerPausedAt || null,
    timer_remaining_ms: timerRemainingMs != null ? timerRemainingMs : null,
  });
}
function updateTaskTimer(taskId, patch) {
  return S().update('t_task', { task_id: taskId }, patch);
}
function getTask(taskId) {
  return S().get('t_task', { task_id: taskId });
}
function listTasks(sessionId) {
  return S().find('t_task', { session_id: sessionId }).sort((a, b) => (a.publish_time || 0) - (b.publish_time || 0));
}
function closeTask(taskId, closeTime) {
  S().update('t_task', { task_id: taskId }, { close_time: closeTime });
  return getTask(taskId);
}
function upsertTaskStatus({ taskId, seat, groupId, status, ts }) {
  ensureTask(S(), taskId);
  return S().insert('t_task_status', { task_id: taskId, seat, group_id: groupId, status, ts });
}
function listTaskStatuses({ sessionId, taskId, status }) {
  let rows = S().all('t_task_status');
  if (taskId) rows = rows.filter((r) => r.task_id === taskId);
  if (status) rows = rows.filter((r) => r.status === status);
  if (sessionId) {
    const taskIds = S().find('t_task', { session_id: sessionId }).map((t) => t.task_id);
    rows = rows.filter((r) => taskIds.includes(r.task_id));
  }
  return rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

// ---------------- Equipment ----------------
function upsertEquipment(rows) {
  for (const r of rows) S().upsert('t_equipment', r);
}
function queryEquipment() {
  return S().all('t_equipment');
}
function insertBorrow({ sessionId, seat, groupId, eqId, qty, borrowTime, status }) {
  ensureSession(S(), sessionId);
  return S().insert('t_equipment_borrow', {
    borrow_id: genId(), session_id: sessionId, seat, group_id: groupId, eq_id: eqId,
    qty: qty || 1, borrow_time: borrowTime || Date.now(), return_time: null, status: status || 'borrowed',
  });
}
function updateBorrowReturn({ sessionId, seat, returnTime }) {
  return S().update('t_equipment_borrow', { session_id: sessionId, seat, status: 'borrowed' },
    { status: 'returned', return_time: returnTime });
}
function removeBorrows(sessionId, seat) {
  return S().remove('t_equipment_borrow', { session_id: sessionId, seat });
}
function recordReturn({ sessionId, seat, groupId, returnTime }) {
  upsertStudent({ sessionId, seat, groupId, patch: { return_status: 'done' } });
  updateBorrowReturn({ sessionId, seat, returnTime });
  return getStudent(sessionId, seat);
}
function queryBorrows(sessionId, { status, page = 1, limit = 100 } = {}) {
  const all = S().find('t_equipment_borrow', { session_id: sessionId });
  let rows = all;
  if (status) rows = rows.filter((r) => r.status === status);
  rows.sort(bySeat);
  const pg = paginate(rows, page, limit);
  const eqOf = (eqId) => S().get('t_equipment', { eq_id: eqId });
  return {
    items: pg.slice.map((r) => toBorrowDTO(r, eqOf(r.eq_id))),
    summary: summarizeBorrows(all, eqOf),
    total: pg.total, page: pg.page, limit: pg.limit, hasMore: pg.hasMore,
  };
}

// ---------------- Event ----------------
function insertEvent(row) {
  return S().insertEvent(row);
}
function queryEvents(sessionId, { type, seat, since, page = 1, limit = 50 } = {}) {
  let rows = S().find('t_event_log', { session_id: sessionId });
  if (type) rows = rows.filter((r) => r.type === type);
  if (seat) rows = rows.filter((r) => r.seat === seat);
  if (since != null) rows = rows.filter((r) => (r.ts || 0) >= since);
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const pg = paginate(rows, page, limit);
  return {
    items: pg.slice.map(toEventDTO),
    total: pg.total, page: pg.page, limit: pg.limit, hasMore: pg.hasMore,
  };
}

// ---------------- Conflict ----------------
function upsertConflict({ seat, machineId, ts }) {
  const existing = S().get('t_conflict', { seat });
  let machineIds = [];
  let firstSeenAt = ts;
  let messageCount = 0;
  if (existing) {
    machineIds = safeParseJSON(existing.machine_ids) || [];
    firstSeenAt = existing.first_seen_at;
    messageCount = existing.message_count || 0;
  }
  if (!machineIds.includes(machineId)) machineIds.push(machineId);
  messageCount += 1;
  S().upsert('t_conflict', {
    seat, machine_ids: JSON.stringify(machineIds),
    first_seen_at: firstSeenAt, last_seen_at: ts, message_count: messageCount,
  });
  return { seat, machineIds, isConflict: machineIds.length > 1, firstSeenAt, lastSeenAt: ts, messageCount };
}
function queryConflicts() {
  return S().all('t_conflict').map(toConflictDTO);
}
// 新课堂开始前清空历史冲突（冲突表以 seat 为主键、跨会话累积；
// 不清会误报"上一节课的同座换机/换座"为当前冲突）。
function clearConflicts() {
  return S().remove('t_conflict', {});
}
// 复位某座位时删除其冲突记录：该座当前只剩一台合法机器，解除红色冲突标记。
function removeConflict(seat) {
  return S().remove('t_conflict', { seat });
}

// ---------------- Presets（班级 / 活动）----------------
function presetList(table) {
  return S().all(table).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}
function listClassPresets() { return presetList('t_class_preset'); }
function getClassPreset(id) { return S().get('t_class_preset', { preset_id: id }); }
function upsertClassPreset(row) { return S().upsert('t_class_preset', row); }
function removeClassPreset(id) { return S().remove('t_class_preset', { preset_id: id }); }

function listActivityPresets() { return presetList('t_activity_preset'); }
function getActivityPreset(id) { return S().get('t_activity_preset', { preset_id: id }); }
function upsertActivityPreset(row) { return S().upsert('t_activity_preset', row); }
function removeActivityPreset(id) { return S().remove('t_activity_preset', { preset_id: id }); }

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch (_e) { return null; }
}

function close() {
  if (storage) storage.close();
}

module.exports = {
  init, S, getMode, stuId, computeOnline, transaction,
  // session
  createSession, getSession, getCurrentSession, listSessions, updateSession, seedSeats, seedSeatsByGroups, admitSeatsTo,
  // student
  upsertStudent, getStudent, recordCheckin, touchSeat, queryStudents,
  // task
  createTask, getTask, listTasks, closeTask, upsertTaskStatus, listTaskStatuses, updateTaskTimer,
  // equipment
  upsertEquipment, queryEquipment, insertBorrow, recordReturn, queryBorrows, updateBorrowReturn, removeBorrows,
  // event
  insertEvent, queryEvents,
  // conflict
  upsertConflict, queryConflicts, clearConflicts, removeConflict,
  // presets
  listClassPresets, getClassPreset, upsertClassPreset, removeClassPreset,
  listActivityPresets, getActivityPreset, upsertActivityPreset, removeActivityPreset,
  close,
};
