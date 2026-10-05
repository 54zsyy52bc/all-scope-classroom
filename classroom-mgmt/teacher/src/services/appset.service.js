'use strict';
// 应用包服务（v5.6）：独立的"桌面应用清单"预设，与班级/课时互不绑定；
// 老师开始上课时选用一套，随 sync 下发应用名列表，学生端按名称过滤本机磁贴。
// 只存应用名（不存 exe 路径）：学生机 desktop-config 的应用 id 跨机不稳定，名称才可对应；
// exe 路径仍在本机配置，不破坏"桌面配置本机化"原则。
const db = require('../db');
const { fail } = require('../errors');
const { nowMs, genId } = require('../utils');
function safeParseJSON(s) {
  try { return JSON.parse(s); } catch (_e) { return null; }
}
function toAppSet(row) {
  if (!row) return null;
  return {
    appSetId: row.app_set_id,
    name: row.name,
    apps: safeParseJSON(row.apps_json) || [],
    note: row.note || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}
function listAppSets() {
  return db.listAppSets().map(toAppSet);
}
function getAppSet(appSetId) {
  const row = db.getAppSet(appSetId);
  if (!row) fail('E-NOTFOUND', '应用包不存在');
  return toAppSet(row);
}
// 标准化：名称必填、apps 为非空应用名数组（≤24 个，对应一屏磁贴可读上限）
function normAppSets(list) {
  const out = [];
  for (const s of list || []) {
    if (!s || !String(s.name || '').trim()) fail('E-VAL-01', '应用包名称不能为空');
    const apps = Array.isArray(s.apps)
      ? s.apps.map((x) => String(x == null ? '' : x).trim()).filter(Boolean)
      : [];
    if (!apps.length) fail('E-VAL-01', '应用包「' + String(s.name).trim() + '」至少要有一个应用名');
    if (apps.length > 24) fail('E-VAL-01', '应用包应用数量不能超过 24');
    out.push({
      appSetId: s.appSetId ? String(s.appSetId).trim().slice(0, 30) : 'AS-' + genId().slice(0, 8).toUpperCase(),
      name: String(s.name).trim().slice(0, 40),
      apps,
      note: s.note ? String(s.note).trim() : null,
    });
  }
  return out;
}
// 批量入库（预设包导入 / 大屏手工维护共用）：按 appSetId upsert，保留本地 created_at
function upsertAppSets(list) {
  const norm = normAppSets(list);
  for (const s of norm) {
    const local = db.getAppSet(s.appSetId);
    db.upsertAppSet({
      app_set_id: s.appSetId,
      name: s.name,
      apps_json: JSON.stringify(s.apps),
      note: s.note,
      created_at: local ? local.created_at : nowMs(),
      updated_at: nowMs(),
    });
  }
  return norm.length;
}
function removeAppSet(appSetId) {
  getAppSet(appSetId);
  db.S().remove('t_app_set', { app_set_id: appSetId });
  return { appSetId };
}
module.exports = { toAppSet, listAppSets, getAppSet, normAppSets, upsertAppSets, removeAppSet };
