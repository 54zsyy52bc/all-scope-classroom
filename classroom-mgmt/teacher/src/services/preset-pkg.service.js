'use strict';
// 预设包服务（v4）：办公端 Preset Studio ↔ 教室大屏 的预设包导入/导出。
// 与 preset.service.js 分离，保持单一职责：CRUD 归 preset.service，包流转归本模块。
// 协议契约：shared/preset-package.js（pkg 标记 / schemaVersion / presetId 合并 / updatedAt 仲裁）。
const db = require('../db');
const presetPkg = require('../../../shared/preset-package');
const presetSvc = require('./preset.service');
const { fail } = require('../errors');
const { nowMs } = require('../utils');

// 导出：组当前教室库全量预设包（备份 / 回迁办公端 Studio 继续编辑）。
function exportPackage() {
  return presetPkg.buildPackage({
    classes: presetSvc.listClasses(),
    activities: presetSvc.listActivities(),
    source: 'teacher-dashboard',
  });
}

// 导入预演：校验 + 与本地逐条比对（presetId 唯一依据），不落库。
// 冲突仲裁：包内 updatedAt >= 本地 updated_at → updated（覆盖）；否则 skipped（本地较新）。
function previewImport(pkg) {
  const errs = presetPkg.validatePackage(pkg);
  if (errs.length) {
    fail('E-PKG-01', '预设包校验失败：' + errs[0] + (errs.length > 1 ? '（共 ' + errs.length + ' 项）' : ''));
  }
  const summary = { added: 0, updated: 0, skipped: 0, items: [] };
  for (const c of pkg.classes || []) {
    const local = db.getClassPreset(c.presetId);
    const pkgTs = c.updatedAt != null ? c.updatedAt : 0;
    const action = !local ? 'added' : (pkgTs >= (local.updated_at || 0) ? 'updated' : 'skipped');
    summary[action] += 1;
    summary.items.push({
      kind: 'class', presetId: c.presetId, name: c.name, action,
      pkgUpdatedAt: pkgTs, localUpdatedAt: local ? local.updated_at : null,
    });
  }
  for (const a of pkg.activities || []) {
    const local = db.getActivityPreset(a.presetId);
    const pkgTs = a.updatedAt != null ? a.updatedAt : 0;
    const action = !local ? 'added' : (pkgTs >= (local.updated_at || 0) ? 'updated' : 'skipped');
    summary[action] += 1;
    summary.items.push({
      kind: 'activity', presetId: a.presetId, name: a.name, action,
      pkgUpdatedAt: pkgTs, localUpdatedAt: local ? local.updated_at : null,
    });
  }
  return summary;
}

// 活动预设条目 → db 行字段（协议校验已保证结构，此处只补默认值）。
function activityRowFromPkg(a, local) {
  return {
    preset_id: a.presetId,
    name: String(a.name).trim(),
    category: a.category ? String(a.category).trim() : null,
    equipment_json: toJSON(Array.isArray(a.equipment)
      ? a.equipment.map((e) => ({
        eqId: String(e.eqId), eqName: String(e.eqName),
        category: e.category ? String(e.category) : '其他',
        preset: Number.isInteger(Number(e.preset)) && Number(e.preset) >= 0 ? Number(e.preset) : 1,
      })) : []),
    task_templates_json: toJSON(Array.isArray(a.taskTemplates)
      ? a.taskTemplates.map((t) => ({ title: String(t.title || '未命名任务').trim(), desc: t.desc ? String(t.desc).trim() : '' }))
      : []),
    timed: a.timed ? 1 : 0,
    duration_sec: a.timed ? Number(a.durationSec) : null,
    note: a.note ? String(a.note).trim() : null,
    created_at: local ? local.created_at : (a.createdAt != null ? a.createdAt : nowMs()),
    updated_at: a.updatedAt != null ? a.updatedAt : nowMs(),
  };
}

function toJSON(v) {
  return v == null ? null : JSON.stringify(v);
}

// 提交导入：按预演结果单事务 upsert（skipped 不动；created_at 保留本地原值）。
function commitImport(pkg) {
  const preview = previewImport(pkg);
  const writes = [];
  for (const it of preview.items) {
    if (it.action === 'skipped') continue;
    if (it.kind === 'class') {
      const c = (pkg.classes || []).find((x) => x.presetId === it.presetId);
      const local = db.getClassPreset(it.presetId);
      writes.push(() => db.upsertClassPreset({
        preset_id: c.presetId,
        name: String(c.name).trim(),
        total_seats: Number(c.totalSeats),
        group_size: Number(c.groupSize),
        groups_json: Array.isArray(c.groups) ? toJSON(c.groups) : null,
        equipment_json: Array.isArray(c.equipment) ? toJSON(c.equipment) : null,
        note: c.note ? String(c.note).trim() : null,
        created_at: local ? local.created_at : (c.createdAt != null ? c.createdAt : nowMs()),
        updated_at: c.updatedAt != null ? c.updatedAt : nowMs(),
      }));
    } else {
      const a = (pkg.activities || []).find((x) => x.presetId === it.presetId);
      const local = db.getActivityPreset(it.presetId);
      writes.push(() => db.upsertActivityPreset(activityRowFromPkg(a, local)));
    }
  }
  if (writes.length) db.transaction(() => { for (const w of writes) w(); });
  return preview;
}

module.exports = { exportPackage, previewImport, commitImport };
