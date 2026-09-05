'use strict';
// =============================================================================
// Preset Studio · 本地预设库（JSON 文件存储，办公电脑独立应用的数据层）。
// 纯 Node 模块，不依赖 Electron —— 可无头单测；Electron 主进程负责读写与 IPC。
//
// 职责：
//   - 班级预设 / 活动预设 CRUD（created_at/updated_at 维护，upsert 保留创建时间）
//   - 器材字典（常用器材速选，编辑活动时引用）
//   - 预设包导出 / 导入（shared/preset-package.js 协议；冲突仲裁同 teacher 端）
// 持久化：单 JSON 文件，写入原子化（临时文件 + rename）。
// =============================================================================
const fs = require('node:fs');
const path = require('node:path');
const presetPkg = require('../../shared/preset-package');

const DEFAULT_DICT = [
  { eqId: 'DEV-BOARD', eqName: '开发板', category: '主控' },
  { eqId: 'ARDUINO-UNO', eqName: 'Arduino UNO', category: '主控' },
  { eqId: 'LED', eqName: 'LED 发光二极管', category: '元件' },
  { eqId: 'RESISTOR', eqName: '电阻', category: '元件' },
  { eqId: 'BREADBOARD', eqName: '面包板', category: '工具' },
  { eqId: 'SOLDER-KIT', eqName: '焊接套件', category: '焊接' },
  { eqId: 'SENSOR-TEMP', eqName: '温度传感器', category: '传感器' },
  { eqId: 'SENSOR-LIGHT', eqName: '光敏传感器', category: '传感器' },
  { eqId: 'MOTOR-CAR', eqName: '小车底盘套件', category: '套件' },
  { eqId: 'DUPONT-WIRE', eqName: '杜邦线', category: '线材' },
];

function createStore(dataFile) {
  const file = dataFile || path.join(__dirname, '..', 'data', 'presets.json');
  const dir = path.dirname(file);

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        version: raw.version || 1,
        classes: Array.isArray(raw.classes) ? raw.classes : [],
        activities: Array.isArray(raw.activities) ? raw.activities : [],
        dict: Array.isArray(raw.dict) ? raw.dict : DEFAULT_DICT.map((d) => Object.assign({}, d)),
      };
    } catch (_e) {
      // 首次运行 / 文件损坏：新建空库（损坏文件重命名为 .bak 防止覆盖丢失）
      try {
        if (fs.existsSync(file)) fs.renameSync(file, file + '.bak-' + Date.now());
      } catch (_e2) { /* 忽略 */ }
      return { version: 1, classes: [], activities: [], dict: DEFAULT_DICT.map((d) => Object.assign({}, d)) };
    }
  }

  let state = load();

  function persist() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  function now() { return Date.now(); }
  function genId(prefix) {
    return prefix + '-' + Math.random().toString(16).slice(2, 10).toUpperCase();
  }

  // ---------------- 班级预设 ----------------
  function toClass(row) {
    return row ? Object.assign({}, row) : null;
  }
  function listClasses() { return state.classes.map(toClass).sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0)); }
  function getClass(presetId) {
    return toClass(state.classes.find((c) => c.preset_id === presetId) || null);
  }
  // 增量合并语义：只覆盖 input 提供的字段（与 teacher updateClass 一致，防局部更新丢字段）
  function normClass(input) {
    const r = {};
    if (input.name !== undefined) r.name = String(input.name || '').trim();
    if (input.total_seats !== undefined) r.total_seats = Number(input.total_seats);
    if (input.group_size !== undefined) r.group_size = Number(input.group_size);
    if (input.note !== undefined) r.note = input.note ? String(input.note).trim() : null;
    // v4.2：分组配置（[{groupId,size}]）——提供即标准化；非空时座位数联动 = 各组之和
    if (input.groups !== undefined) {
      r.groups = Array.isArray(input.groups)
        ? input.groups
          .map((g) => ({
            groupId: String((g && g.groupId) || '').trim(),
            size: Math.max(1, Math.floor(Number(g && g.size)) || 1),
          }))
          .filter((g) => g.groupId) : [];
      if (r.groups.length) r.total_seats = r.groups.reduce((acc, g) => acc + g.size, 0);
    }
    // v4.2：上课器材（与活动器材同构，随上课下发并与活动器材合并）
    if (input.equipment !== undefined) {
      r.equipment = Array.isArray(input.equipment)
        ? input.equipment
          .map((e) => ({
            eqId: String((e && e.eqId) || '').trim(),
            eqName: String((e && e.eqName) || '').trim(),
            category: (e && e.category) ? String(e.category) : '其他',
            preset: Number.isInteger(Number(e && e.preset)) && Number(e.preset) >= 0 ? Number(e.preset) : 1,
          }))
          .filter((e) => e.eqId && e.eqName) : [];
    }
    if (input.created_at !== undefined) r.created_at = input.created_at;
    if (input.updated_at !== undefined) r.updated_at = input.updated_at;
    return r;
  }
  function upsertClass(input) {
    const existing = state.classes.find((c) => c.preset_id === input.preset_id);
    const r = normClass(input);
    if (!existing) {
      const row = Object.assign({
        preset_id: input.preset_id, name: '未命名班级', total_seats: 50, group_size: 5,
        groups: [], equipment: [], note: null, created_at: now(), updated_at: now(),
      }, r);
      state.classes.push(row);
      persist();
      return toClass(row);
    }
    Object.assign(existing, r);
    if (r.updated_at === undefined) existing.updated_at = now();
    persist();
    return toClass(existing);
  }
  function removeClass(presetId) {
    const i = state.classes.findIndex((c) => c.preset_id === presetId);
    if (i >= 0) state.classes.splice(i, 1);
    persist();
  }

  // ---------------- 活动预设 ----------------
  function toActivity(row) {
    return row ? Object.assign({}, row, {
      equipment: Array.isArray(row.equipment) ? row.equipment : [],
      taskTemplates: Array.isArray(row.taskTemplates) ? row.taskTemplates : [],
    }) : null;
  }
  function listActivities() {
    return state.activities.map(toActivity).sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0));
  }
  function getActivity(presetId) {
    return toActivity(state.activities.find((a) => a.preset_id === presetId) || null);
  }
  function normActivity(input) {
    const r = {};
    if (input.name !== undefined) r.name = String(input.name || '').trim();
    if (input.category !== undefined) r.category = input.category ? String(input.category).trim() : null;
    if (input.equipment !== undefined) r.equipment = Array.isArray(input.equipment) ? input.equipment : [];
    if (input.taskTemplates !== undefined) r.taskTemplates = Array.isArray(input.taskTemplates) ? input.taskTemplates : [];
    if (input.timed !== undefined) r.timed = !!input.timed;
    if (input.durationSec !== undefined) r.durationSec = input.durationSec;
    if (input.note !== undefined) r.note = input.note ? String(input.note).trim() : null;
    if (input.created_at !== undefined) r.created_at = input.created_at;
    if (input.updated_at !== undefined) r.updated_at = input.updated_at;
    return r;
  }
  function upsertActivity(input) {
    const existing = state.activities.find((a) => a.preset_id === input.preset_id);
    const r = normActivity(input);
    if (!existing) {
      const row = Object.assign({
        preset_id: input.preset_id, name: '未命名活动', category: null,
        equipment: [], taskTemplates: [], timed: false, durationSec: null,
        note: null, created_at: now(), updated_at: now(),
      }, r);
      state.activities.push(row);
      persist();
      return toActivity(row);
    }
    // timed 关闭时联动清空 durationSec（避免残留旧时长）
    if (r.timed === false && existing.timed && r.durationSec === undefined) r.durationSec = null;
    Object.assign(existing, r);
    if (r.updated_at === undefined) existing.updated_at = now();
    persist();
    return toActivity(existing);
  }
  function removeActivity(presetId) {
    const i = state.activities.findIndex((a) => a.preset_id === presetId);
    if (i >= 0) state.activities.splice(i, 1);
    persist();
  }

  // ---------------- 器材字典 ----------------
  function listDict() { return state.dict.map((d) => Object.assign({}, d)); }
  function upsertDictItem(item) {
    if (!item || !item.eqId || !item.eqName) throw new Error('E-VAL-01: 字典项须含 eqId/eqName');
    const existing = state.dict.find((d) => d.eqId === item.eqId);
    const row = {
      eqId: String(item.eqId),
      eqName: String(item.eqName).trim(),
      category: item.category ? String(item.category).trim() : '其他',
    };
    if (existing) Object.assign(existing, row);
    else state.dict.push(row);
    persist();
    return Object.assign({}, row);
  }
  function removeDictItem(eqId) {
    const i = state.dict.findIndex((d) => d.eqId === eqId);
    if (i >= 0) state.dict.splice(i, 1);
    persist();
  }

  // ---------------- 预设包 导出 / 导入 ----------------
  // filter 可选：{ classes?:[id], activities?:[id] } 只导出勾选的（如"单活动预设包"）
  function exportPackage(filter) {
    const f = filter || {};
    const cls = Array.isArray(f.classes) && f.classes.length ? state.classes.filter((c) => f.classes.includes(c.preset_id)) : state.classes;
    const acts = Array.isArray(f.activities) && f.activities.length ? state.activities.filter((a) => f.activities.includes(a.preset_id)) : state.activities;
    const toPkgClass = (c) => ({
      presetId: c.preset_id, name: c.name, totalSeats: c.total_seats, groupSize: c.group_size,
      groups: c.groups || [], equipment: c.equipment || [],
      note: c.note, createdAt: c.created_at, updatedAt: c.updated_at,
    });
    const toPkgActivity = (a) => ({
      presetId: a.preset_id, name: a.name, category: a.category,
      equipment: a.equipment, taskTemplates: a.taskTemplates,
      timed: a.timed, durationSec: a.durationSec, note: a.note,
      createdAt: a.created_at, updatedAt: a.updated_at,
    });
    return presetPkg.buildPackage({
      classes: cls.map(toPkgClass),
      activities: acts.map(toPkgActivity),
      source: 'preset-studio',
    });
  }

  function previewImport(pkg) {
    const errs = presetPkg.validatePackage(pkg);
    if (errs.length) {
      const e = new Error('E-PKG-01: ' + errs[0] + (errs.length > 1 ? '（共 ' + errs.length + ' 项）' : ''));
      e.errorCode = 'E-PKG-01';
      throw e;
    }
    const summary = { added: 0, updated: 0, skipped: 0, items: [] };
    const compare = (list, localFind, kind) => (x) => {
      const local = localFind(x.presetId);
      const pkgTs = x.updatedAt != null ? x.updatedAt : 0;
      const action = !local ? 'added' : (pkgTs >= (local.updated_at || 0) ? 'updated' : 'skipped');
      summary[action] += 1;
      summary.items.push({ kind, presetId: x.presetId, name: x.name, action,
        pkgUpdatedAt: pkgTs, localUpdatedAt: local ? local.updated_at : null });
    };
    (pkg.classes || []).forEach(compare(state.classes, getClass, 'class'));
    (pkg.activities || []).forEach(compare(state.activities, getActivity, 'activity'));
    return summary;
  }

  function commitImport(pkg) {
    const preview = previewImport(pkg);
    for (const it of preview.items) {
      if (it.action === 'skipped') continue;
      if (it.kind === 'class') {
        const c = (pkg.classes || []).find((x) => x.presetId === it.presetId);
        upsertClass({
          preset_id: c.presetId, name: c.name, total_seats: c.totalSeats, group_size: c.groupSize,
          groups: c.groups, equipment: c.equipment, note: c.note,
          created_at: c.createdAt, updated_at: c.updatedAt,
        });
      } else {
        const a = (pkg.activities || []).find((x) => x.presetId === it.presetId);
        upsertActivity({
          preset_id: a.presetId, name: a.name, category: a.category,
          equipment: a.equipment, taskTemplates: a.taskTemplates,
          timed: a.timed, durationSec: a.durationSec, note: a.note,
          created_at: a.createdAt, updated_at: a.updatedAt,
        });
      }
    }
    return preview;
  }

  return {
    file, genId,
    listClasses, getClass, upsertClass, removeClass,
    listActivities, getActivity, upsertActivity, removeActivity,
    listDict, upsertDictItem, removeDictItem,
    exportPackage, previewImport, commitImport,
  };
}

module.exports = { createStore, DEFAULT_DICT };
