'use strict';
// 看板聚合：从 DB + 内存状态计算快照（revision 与 SSE 同源）。纯查询，无写操作。
const db = require('../db');
const sse = require('../sse');
const bridge = require('../mqtt/bridge');
const sessionSvc = require('./session.service');
const taskSvc = require('./task.service');
const { nowMs, seatNum } = require('../utils');

function emptyStats() {
  return {
    checkedIn: 0, pending: 0, checkinRate: 0,
    online: 0, offline: 0, taskDoing: 0, taskDone: 0, taskHelp: 0,
    returned: 0, borrowRate: 0,
  };
}

function computeBorrowRate(sessionId) {
  const borrows = db.queryBorrows(sessionId, {}).items;
  if (!borrows.length) return 0;
  const borrowedSeats = new Set();
  const returnedSeats = new Set();
  for (const b of borrows) {
    borrowedSeats.add(b.seat);
    if (b.status === 'returned') returnedSeats.add(b.seat);
  }
  if (borrowedSeats.size === 0) return 0;
  return Number((returnedSeats.size / borrowedSeats.size).toFixed(4));
}

function getSnapshot() {
  const revision = sse.getState().revision;
  const sessionRow = db.getCurrentSession();

  if (!sessionRow) {
    return {
      revision, serverTs: nowMs(),
      session: null, stats: emptyStats(),
      currentTask: null, groups: [], seats: [], conflicts: [], mqtt: bridge.getState(),
    };
  }

  const sessionId = sessionRow.session_id;
  const students = db.queryStudents(sessionId).items;
  const totalSeats = sessionRow.total_seats;
  const checkedIn = students.filter((s) => s.checkinStatus === 'done').length;
  const online = students.filter((s) => s.online).length;
  const pending = Math.max(0, totalSeats - checkedIn);
  const returned = students.filter((s) => s.returnStatus === 'done').length;
  const checkinRate = totalSeats > 0 ? Number((checkedIn / totalSeats).toFixed(4)) : 0;

  // 当前任务与任务状态
  const tasks = db.listTasks(sessionId);
  const currentTaskRow = tasks.length ? tasks[tasks.length - 1] : null;
  let currentTask = null;
  let taskDoing = 0; let taskDone = 0; let taskHelp = 0;
  const seatTaskStatus = {};
  if (currentTaskRow) {
    currentTask = taskSvc.toTask(currentTaskRow);
    const statuses = db.listTaskStatuses({ sessionId, taskId: currentTaskRow.task_id });
    // 每座只取最新状态：listTaskStatuses 为 ts 降序（索引 0=最新）。
    // 正序遍历且仅首次出现写入 → 每座取到的是最新状态，旧状态不再覆盖。
    for (const s of statuses) {
      if (seatTaskStatus[s.seat] == null) seatTaskStatus[s.seat] = s.status;
    }
    for (const st of Object.values(seatTaskStatus)) { // 按每座最新状态计数
      if (st === 'doing') taskDoing += 1;
      else if (st === 'done') taskDone += 1;
      else if (st === 'help') taskHelp += 1;
    }
  }

  const stats = {
    checkedIn, pending, checkinRate,
    online, offline: Math.max(0, totalSeats - online),
    taskDoing, taskDone, taskHelp, returned,
    borrowRate: computeBorrowRate(sessionId),
  };

  // 座位冲突的判定是"同一座位出现 >1 个 machineId"，而不是"存在冲突记录行"。
  // upsertConflict 会为每个上报过 machineId 的座位建行（hello / checkin 都会建），
  // 若按行存在判定，全班每个座位都会被误标为冲突。
  const conflicts = db.queryConflicts();
  const conflictSeats = new Set(
    conflicts.filter((c) => (c.machineIds || []).length > 1).map((c) => c.seat),
  );

  const seats = students
    .sort((a, b) => seatNum(a.seat).localeCompare(seatNum(b.seat)))
    .map((s) => ({
      seat: s.seat, groupId: s.groupId, name: s.name, checkinStatus: s.checkinStatus,
      taskStatus: seatTaskStatus[s.seat] || null, returnStatus: s.returnStatus,
      online: s.online, lastSeenAt: s.lastSeenAt, conflict: conflictSeats.has(s.seat),
      role: s.role || null, // v5 组机：组长 leader / 成员 member
    }));

  const groups = buildGroups(students, seatTaskStatus, conflictSeats, sessionId);

  return {
    revision, serverTs: nowMs(),
    session: sessionSvc.toSession(sessionRow),
    stats, currentTask, groups, seats, conflicts, mqtt: bridge.getState(),
  };
}

// v5 组机登记完成：显式（学生上报 group_done / 组长点完成）+ 隐式（组满自动）。
// key: sessionId -> Set(groupId)；sessionId 唯一且不重用，无需清理。
const doneGroups = new Map();
function registerDone(sessionId, groupId) {
  if (!doneGroups.has(sessionId)) doneGroups.set(sessionId, new Set());
  doneGroups.get(sessionId).add(groupId);
}
function isDone(sessionId, groupId) {
  const s = doneGroups.get(sessionId);
  return !!(s && s.has(groupId));
}

function buildGroups(students, seatTaskStatus, conflictSeats, sessionId) {
  const byGroup = {};
  for (const s of students) {
    const g = s.groupId || 'G?';
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(s);
  }
  return Object.keys(byGroup).sort().map((g) => {
    const members = byGroup[g];
    let helpCount = 0; let doneCount = 0;
    const seats = members.map((m) => m.seat).sort((a, b) => seatNum(a).localeCompare(seatNum(b)));
    for (const m of members) {
      if (seatTaskStatus[m.seat] === 'help') helpCount += 1;
      if (m.returnStatus === 'done') doneCount += 1;
    }
    const returned = members.length > 0 && members.every((m) => m.returnStatus === 'done');
    const checkedIn = members.filter((m) => m.checkinStatus === 'done').length;
    const complete = isDone(sessionId, g) || (seats.length > 0 && checkedIn >= seats.length);
    return {
      groupId: g, seats, checkedIn,
      helpCount, doneCount, returned, hasHelp: helpCount > 0, complete,
    };
  });
}

function getConflicts() {
  return db.queryConflicts();
}

module.exports = { getSnapshot, getConflicts, registerDone, isDone };
