'use strict';
// =============================================================================
// 预设包协议（共享契约）：办公端 Preset Studio ↔ 教室大屏 之间的数据交换格式。
// 双端复用：teacher server（导入/导出）与 preset-studio（本地独立应用）均 require 本文件。
// 约定：
//   - 纯数据、无副作用、零第三方依赖（双端都能直接用）。
//   - 校验失败返回错误数组（空数组 = 通过），不抛异常。
//   - presetId 由生产端生成并跨机器保持稳定，是两端合并的唯一依据。
//   - 冲突仲裁用 updatedAt（毫秒时间戳）：包内 >= 本地 → 覆盖；否则跳过。
// =============================================================================

const PKG_MARK = 'kct-preset-package';
const SCHEMA_VERSION = 1;
const FILE_EXT = '.kctpreset';

function isNonEmptyStr(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// 课时条目校验（v5.2 加性字段）：班级条目内的可选 lessons[]，老端忽略、新端消费。
function validateLesson(l, path) {
  const errs = [];
  if (!l || typeof l !== 'object') return [path + '必须为对象'];
  if (!isNonEmptyStr(l.name)) errs.push(path + '.name 不能为空');
  if (l.activityIds != null && !Array.isArray(l.activityIds)) errs.push(path + '.activityIds 必须为数组');
  if (l.equipment != null) {
    if (!Array.isArray(l.equipment)) errs.push(path + '.equipment 必须为数组');
    else {
      for (let i = 0; i < l.equipment.length; i += 1) {
        const e = l.equipment[i];
        if (!e || !isNonEmptyStr(e.eqId) || !isNonEmptyStr(e.eqName)) {
          errs.push(path + '.equipment[' + i + '] 须含 eqId/eqName');
        }
      }
    }
  }
  return errs;
}

// 应用包条目校验（v5.6 加性字段）：独立应用清单，开课时选用；apps 为应用名列表，
// 学生端按名称匹配本机 desktop-config 里的应用（id 跨机不稳定，只有名称可靠）。
function validateAppSet(s, path) {
  const errs = [];
  if (!s || typeof s !== 'object') return [path + '必须为对象'];
  if (!isNonEmptyStr(s.name)) errs.push(path + '.name 不能为空');
  if (s.apps != null) {
    if (!Array.isArray(s.apps)) errs.push(path + '.apps 必须为数组');
    else s.apps.forEach((a, i) => { if (!isNonEmptyStr(a)) errs.push(path + '.apps[' + i + '] 不能为空'); });
  }
  return errs;
}

// ---------------- 单条目校验 ----------------
function validateClassPreset(c, path) {
  const errs = [];
  const p = path ? path + '.' : '';
  if (!c || typeof c !== 'object') return [p + '条目必须为对象'];
  if (!isNonEmptyStr(c.name)) errs.push(p + 'name 不能为空');
  if (!Number.isInteger(Number(c.totalSeats)) || Number(c.totalSeats) < 1 || Number(c.totalSeats) > 99) {
    errs.push(p + 'totalSeats 须为 1-99 整数');
  }
  if (!Number.isInteger(Number(c.groupSize)) || Number(c.groupSize) < 1 || Number(c.groupSize) > 20) {
    errs.push(p + 'groupSize 须为 1-20 整数');
  }
  if (c.lessons != null) {
    if (!Array.isArray(c.lessons)) errs.push(p + 'lessons 必须为数组');
    else c.lessons.forEach((l, i) => errs.push(...validateLesson(l, p + 'lessons[' + i + ']')));
  }
  return errs;
}

function validateActivityPreset(a, path) {
  const errs = [];
  const p = path ? path + '.' : '';
  if (!a || typeof a !== 'object') return [p + '条目必须为对象'];
  if (!isNonEmptyStr(a.name)) errs.push(p + 'name 不能为空');
  if (a.equipment != null) {
    if (!Array.isArray(a.equipment)) errs.push(p + 'equipment 必须为数组');
    else {
      for (let i = 0; i < a.equipment.length; i += 1) {
        const e = a.equipment[i];
        if (!e || !isNonEmptyStr(e.eqId) || !isNonEmptyStr(e.eqName)) {
          errs.push(p + 'equipment[' + i + '] 须含 eqId/eqName');
        }
      }
    }
  }
  if (a.taskTemplates != null && !Array.isArray(a.taskTemplates)) {
    errs.push(p + 'taskTemplates 必须为数组');
  }
  if (a.timed) {
    const d = Number(a.durationSec);
    if (!Number.isInteger(d) || d < 5 || d > 7200) {
      errs.push(p + 'durationSec 须为 5-7200 整数（启用计时时必填）');
    }
  }
  return errs;
}

// ---------------- 整包校验 ----------------
function validatePackage(pkg) {
  if (!pkg || typeof pkg !== 'object') return ['包必须为 JSON 对象'];
  const errs = [];
  if (pkg.pkg !== PKG_MARK) errs.push('pkg 标记须为 "' + PKG_MARK + '"（不是预设包文件）');
  if (pkg.schemaVersion !== SCHEMA_VERSION) errs.push('schemaVersion 须为 ' + SCHEMA_VERSION);
  if (!Array.isArray(pkg.classes)) errs.push('classes 必须为数组');
  else pkg.classes.forEach((c, i) => errs.push(...validateClassPreset(c, 'classes[' + i + ']')));
  if (!Array.isArray(pkg.activities)) errs.push('activities 必须为数组');
  else pkg.activities.forEach((a, i) => errs.push(...validateActivityPreset(a, 'activities[' + i + ']')));
  // v5.6 应用包：可选加性字段；老包无此字段照常通过
  if (pkg.appSets != null) {
    if (!Array.isArray(pkg.appSets)) errs.push('appSets 必须为数组');
    else pkg.appSets.forEach((s, i) => errs.push(...validateAppSet(s, 'appSets[' + i + ']')));
  }
  if (errs.length === 0 && pkg.classes.length === 0 && pkg.activities.length === 0
    && !(Array.isArray(pkg.appSets) && pkg.appSets.length)) {
    errs.push('包内没有任何预设条目');
  }
  return errs;
}

// ---------------- 组包 ----------------
function buildPackage(opts) {
  const o = opts || {};
  return {
    pkg: PKG_MARK,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    source: o.source || null,
    classes: Array.isArray(o.classes) ? o.classes : [],
    activities: Array.isArray(o.activities) ? o.activities : [],
    appSets: Array.isArray(o.appSets) ? o.appSets : [],
  };
}

module.exports = {
  PKG_MARK, SCHEMA_VERSION, FILE_EXT,
  validatePackage, buildPackage,
};
