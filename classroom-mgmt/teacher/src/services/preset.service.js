'use strict';
// 预设服务：班级预设（班级名 / 座位数 / 分组大小）与活动预设（器材清单 / 任务模板）。
// 供编辑器与大屏共享：课前编辑预设，上课时一键加载，避免每节课重复配置。
// v4：预设包导入/导出逻辑在 preset-pkg.service.js（shared/preset-package.js 协议）。
const db = require('../db');
const { fail } = require('../errors');
const { nowMs, genId } = require('../utils');

function safeParseJSON(s) {
  try { return JSON.parse(s); } catch (_e) { return null; }
}
function toJSON(v) {
  return v == null ? null : JSON.stringify(v);
}

// ---------------- 班级预设 ----------------
function toClassPreset(row) {
  if (!row) return null;
  return {
    presetId: row.preset_id,
    name: row.name,
    totalSeats: row.total_seats,
    groupSize: row.group_size,
    groups: safeParseJSON(row.groups_json) || [],
    equipment: safeParseJSON(row.equipment_json) || [],
    note: row.note || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function listClasses() {
  return db.listClassPresets().map(toClassPreset);
}

function getClass(presetId) {
  const row = db.getClassPreset(presetId);
  if (!row) fail('E-NOTFOUND', '班级预设不存在');
  return toClassPreset(row);
}

// 分组配置标准化（v4.2）：[{ groupId, size }]，组名必填、人数 1-99
function normGroups(groups) {
  const out = [];
  let total = 0;
  for (const g of groups || []) {
    if (!g || !String(g.groupId || '').trim()) fail('E-VAL-01', '每个分组都须填写组名');
    const size = Math.floor(Number(g.size));
    if (!Number.isInteger(size) || size < 1 || size > 99) fail('E-VAL-01', '分组人数须为 1-99 的整数');
    out.push({ groupId: String(g.groupId).trim(), size });
    total += size;
  }
  if (total > 99) fail('E-VAL-01', '各组人数合计不能超过 99');
  return { list: out, total };
}

// 上课器材标准化（v4.2）：与活动器材同构 eqId/eqName/category/preset
function normEqList(list) {
  const out = [];
  for (const e of list || []) {
    if (!e || !e.eqId || !e.eqName) fail('E-VAL-01', '上课器材项须含 eqId 与 eqName');
    out.push({
      eqId: String(e.eqId),
      eqName: String(e.eqName),
      category: e.category ? String(e.category) : '其他',
      preset: Number.isInteger(Number(e.preset)) && Number(e.preset) >= 0 ? Number(e.preset) : 1,
    });
  }
  return out;
}

function validateClassInput(body, isUpdate) {
  const name = body.name == null ? undefined : String(body.name).trim();
  if (name !== undefined && !name) fail('E-VAL-01', '班级预设名称不能为空');
  if (isUpdate && name === undefined && body.totalSeats === undefined && body.groupSize === undefined
    && body.note === undefined && body.groups === undefined && body.equipment === undefined) {
    fail('E-VAL-01', '没有可更新的字段');
  }
  let totalSeats = body.totalSeats;
  if (totalSeats !== undefined) {
    totalSeats = Number(totalSeats);
    if (!Number.isInteger(totalSeats) || totalSeats < 1 || totalSeats > 99) {
      fail('E-VAL-01', '座位数须为 1-99 的整数');
    }
  }
  let groupSize = body.groupSize;
  if (groupSize !== undefined) {
    groupSize = Number(groupSize);
    if (!Number.isInteger(groupSize) || groupSize < 1 || groupSize > 20) {
      fail('E-VAL-01', '分组大小须为 1-20 的整数');
    }
  }
  let groups;
  let groupsTotal;
  if (body.groups !== undefined) {
    if (!Array.isArray(body.groups)) fail('E-VAL-01', 'groups 必须为数组');
    if (body.groups.length) {
      const r = normGroups(body.groups);
      groups = r.list;
      groupsTotal = r.total;
    } else {
      groups = [];
      groupsTotal = 0;
    }
  }
  let equipment;
  if (body.equipment !== undefined) {
    if (!Array.isArray(body.equipment)) fail('E-VAL-01', 'equipment 必须为数组');
    equipment = normEqList(body.equipment);
  }
  const note = body.note === undefined ? undefined : (body.note == null ? null : String(body.note).trim());
  return {
    name, totalSeats, groupSize, groups, groupsTotal, equipment, note,
    // 自定义分组时座位数跟随各组之和（前端已同步，此处兜底）
    effectiveTotal: groupsTotal || totalSeats,
  };
}

function createClass(body) {
  const v = validateClassInput(body, false);
  if (!v.name) fail('E-VAL-01', '班级预设名称不能为空');
  const presetId = 'CP-' + genId().slice(0, 8).toUpperCase();
  const now = nowMs();
  db.upsertClassPreset({
    preset_id: presetId,
    name: v.name,
    total_seats: v.groupsTotal || (v.totalSeats != null ? v.totalSeats : 50),
    group_size: v.groupSize != null ? v.groupSize : 5,
    groups_json: toJSON(v.groups || null),
    equipment_json: toJSON(v.equipment != null ? v.equipment : []),
    note: v.note != null ? v.note : null,
    created_at: now,
    updated_at: now,
  });
  return getClass(presetId);
}

function updateClass(presetId, body) {
  getClass(presetId); // 不存在则抛 E-NOTFOUND
  const v = validateClassInput(body, true);
  const patch = { updated_at: nowMs() };
  if (v.name !== undefined) patch.name = v.name;
  if (v.totalSeats !== undefined && !v.groupsTotal) patch.total_seats = v.totalSeats;
  if (v.groupsTotal) patch.total_seats = v.groupsTotal; // 自定义分组：座位数=各组之和
  if (v.groupSize !== undefined) patch.group_size = v.groupSize;
  if (v.groups !== undefined) patch.groups_json = toJSON(v.groups);
  if (v.equipment !== undefined) patch.equipment_json = toJSON(v.equipment);
  if (v.note !== undefined) patch.note = v.note;
  db.upsertClassPreset(Object.assign({ preset_id: presetId }, patch));
  return getClass(presetId);
}

function removeClass(presetId) {
  getClass(presetId);
  db.removeClassPreset(presetId);
  return { presetId };
}

// ---------------- 活动预设 ----------------
function toActivityPreset(row) {
  if (!row) return null;
  return {
    presetId: row.preset_id,
    name: row.name,
    category: row.category || null,
    equipment: safeParseJSON(row.equipment_json) || [],
    taskTemplates: safeParseJSON(row.task_templates_json) || [],
    timed: !!row.timed,
    durationSec: row.duration_sec != null ? row.duration_sec : 0,
    note: row.note || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function listActivities() {
  return db.listActivityPresets().map(toActivityPreset);
}

function getActivity(presetId) {
  const row = db.getActivityPreset(presetId);
  if (!row) fail('E-NOTFOUND', '活动预设不存在');
  return toActivityPreset(row);
}

function validateActivityInput(body, isUpdate) {
  const name = body.name == null ? undefined : String(body.name).trim();
  if (name !== undefined && !name) fail('E-VAL-01', '活动预设名称不能为空');
  const category = body.category === undefined ? undefined : (body.category == null ? null : String(body.category).trim());
  const note = body.note === undefined ? undefined : (body.note == null ? null : String(body.note).trim());

  let timed;
  if (body.timed !== undefined) timed = !!body.timed;

  let durationSec;
  if (body.durationSec !== undefined) {
    durationSec = Number(body.durationSec);
    if (!Number.isInteger(durationSec) || durationSec < 0 || durationSec > 7200) {
      fail('E-VAL-01', '默认时长须为 0-7200 秒的整数');
    }
    if (timed === true && durationSec <= 0) fail('E-VAL-01', '启用计时时默认时长必须 > 0');
  }

  let equipment;
  if (body.equipment !== undefined) {
    if (!Array.isArray(body.equipment)) fail('E-VAL-01', 'equipment 必须为数组');
    for (const e of body.equipment) {
      if (!e || !e.eqId || !e.eqName) fail('E-VAL-01', '器材项必须含 eqId 与 eqName');
    }
    equipment = body.equipment.map((e) => ({
      eqId: String(e.eqId),
      eqName: String(e.eqName),
      category: e.category ? String(e.category) : '其他',
      preset: Number.isInteger(Number(e.preset)) && Number(e.preset) >= 0 ? Number(e.preset) : 1,
    }));
  }

  let taskTemplates;
  if (body.taskTemplates !== undefined) {
    if (!Array.isArray(body.taskTemplates)) fail('E-VAL-01', 'taskTemplates 必须为数组');
    taskTemplates = body.taskTemplates.map((t) => ({
      title: t && t.title ? String(t.title).trim() : '未命名任务',
      desc: t && t.desc ? String(t.desc).trim() : '',
    }));
  }

  if (isUpdate && name === undefined && category === undefined && note === undefined
    && equipment === undefined && taskTemplates === undefined && timed === undefined && durationSec === undefined) {
    fail('E-VAL-01', '没有可更新的字段');
  }
  return { name, category, note, equipment, taskTemplates, timed, durationSec };
}

function createActivity(body) {
  const v = validateActivityInput(body, false);
  if (!v.name) fail('E-VAL-01', '活动预设名称不能为空');
  const presetId = 'AP-' + genId().slice(0, 8).toUpperCase();
  const now = nowMs();
  db.upsertActivityPreset({
    preset_id: presetId,
    name: v.name,
    category: v.category != null ? v.category : null,
    equipment_json: toJSON(v.equipment || []),
    task_templates_json: toJSON(v.taskTemplates || []),
    timed: v.timed ? 1 : 0,
    duration_sec: v.durationSec != null ? v.durationSec : null,
    note: v.note != null ? v.note : null,
    created_at: now,
    updated_at: now,
  });
  return getActivity(presetId);
}

function updateActivity(presetId, body) {
  getActivity(presetId);
  const v = validateActivityInput(body, true);
  const patch = { updated_at: nowMs() };
  if (v.name !== undefined) patch.name = v.name;
  if (v.category !== undefined) patch.category = v.category;
  if (v.note !== undefined) patch.note = v.note;
  if (v.equipment !== undefined) patch.equipment_json = toJSON(v.equipment);
  if (v.taskTemplates !== undefined) patch.task_templates_json = toJSON(v.taskTemplates);
  if (v.timed !== undefined) patch.timed = v.timed ? 1 : 0;
  if (v.durationSec !== undefined) patch.duration_sec = v.durationSec;
  db.upsertActivityPreset(Object.assign({ preset_id: presetId }, patch));
  return getActivity(presetId);
}

function removeActivity(presetId) {
  getActivity(presetId);
  db.removeActivityPreset(presetId);
  return { presetId };
}

module.exports = {
  toClassPreset, listClasses, getClass, createClass, updateClass, removeClass,
  toActivityPreset, listActivities, getActivity, createActivity, updateActivity, removeActivity,
};
