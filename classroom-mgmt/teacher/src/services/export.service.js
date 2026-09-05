'use strict';
// 报表导出：登记表 / 任务记录 / 器材使用 / 事件日志。xlsx 多 Sheet，csv 带 UTF-8 BOM。
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const Papa = require('papaparse');
const cfg = require('../config');
const db = require('../db');
const { fail } = require('../errors');
const { makeExportId, withBOM } = require('../utils');

const REPORTS = ['students', 'tasks', 'equipment', 'events'];
const REPORT_LABEL = { students: '登记表', tasks: '任务记录', equipment: '器材使用', events: '事件日志' };

function fmtTs(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function resolveSessionIds(scope) {
  if (scope === 'history') {
    return db.listSessions({}).items.map((s) => s.session_id);
  }
  const cur = db.getCurrentSession();
  if (!cur) fail('E-SESSION-01', '当前没有进行中的课堂会话，无法导出');
  return [cur.session_id];
}

function buildStudents(sessionIds) {
  const headers = ['座位', '小组', '姓名', '学号', '登记时间', '领取器材'];
  const rows = [];
  const eqMap = {}; // sessionId -> borrow map by seat
  for (const sid of sessionIds) {
    const borrows = db.queryBorrows(sid, {}).items;
    const bySeat = {};
    for (const b of borrows) { bySeat[b.seat] = bySeat[b.seat] || []; bySeat[b.seat].push(`${b.qty}×${b.eqName}`); }
    const students = db.queryStudents(sid).items;
    for (const s of students) {
      const eq = (bySeat[s.seat] || []).join('、');
      rows.push([s.seat, s.groupId || '', s.name || '', s.studentNo || '', fmtTs(s.checkinTime), eq]);
    }
  }
  return { headers, rows };
}

function buildTasks(sessionIds) {
  const headers = ['会话ID', '任务ID', '标题', '说明', '发布时间', '关闭时间', '进行中', '已完成', '求助'];
  const rows = [];
  for (const sid of sessionIds) {
    const list = require('./task.service').listTasksWithStats(sid);
    for (const t of list) {
      rows.push([sid, t.taskId, t.title, t.desc || '', fmtTs(t.publishTime), fmtTs(t.closeTime),
        t.stats.doing, t.stats.done, t.stats.help]);
    }
  }
  return { headers, rows };
}

function buildEquipment(sessionIds) {
  const headers = ['会话ID', '器材ID', '名称', '类别', '总数', '已领', '已还', '未还'];
  const rows = [];
  const eqRows = {};
  for (const e of db.queryEquipment()) eqRows[e.eq_id] = e;
  for (const sid of sessionIds) {
    const summary = db.queryBorrows(sid, {}).summary;
    for (const s of summary) {
      const eq = eqRows[s.eqId] || {};
      rows.push([sid, s.eqId, s.eqName, eq.category || '', s.total, s.borrowed, s.returned, s.outstanding]);
    }
  }
  return { headers, rows };
}

function buildEvents(sessionIds) {
  const headers = ['序号', '会话ID', '时间', '类型', '座位', '详情'];
  const rows = [];
  for (const sid of sessionIds) {
    const evs = db.queryEvents(sid, { limit: 100000 }).items;
    for (const e of evs) {
      rows.push([e.id, sid, fmtTs(e.ts), e.type, e.seat || '', e.detail ? JSON.stringify(e.detail) : '']);
    }
  }
  return { headers, rows };
}

const BUILDERS = { students: buildStudents, tasks: buildTasks, equipment: buildEquipment, events: buildEvents };

function csvOf(headers, rows) {
  return withBOM(Papa.unparse({ fields: headers, data: rows }));
}

function writeCsv(dir, report, headers, rows) {
  const fileName = `${REPORT_LABEL[report]}.csv`;
  fs.writeFileSync(path.join(dir, fileName), csvOf(headers, rows), 'utf8');
  return fileName;
}

function writeXlsx(dir, reportsData) {
  const fileName = '课堂报表.xlsx';
  const wb = XLSX.utils.book_new();
  for (const { report, headers, rows } of reportsData) {
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, REPORT_LABEL[report].slice(0, 31));
  }
  const filePath = path.join(dir, fileName);
  XLSX.writeFile(wb, filePath);
  return fileName;
}

function buildManifest(exportId, sessionId, files, createdAt) {
  return { exportId, sessionId: sessionId || null, createdAt, files };
}

// 生成报表并落盘，返回 ExportResult
function createExport({ scope = 'current', sessionIds, formats = ['xlsx', 'csv'], reports } = {}) {
  const reportList = (reports && reports.length) ? reports.filter((r) => REPORTS.includes(r)) : REPORTS.slice();
  if (reportList.length === 0) fail('E-VAL-01', 'reports 非法');
  const fmts = (Array.isArray(formats) && formats.length ? formats : ['xlsx', 'csv']).filter((f) => ['xlsx', 'csv'].includes(f));
  const ids = (sessionIds && sessionIds.length) ? sessionIds : resolveSessionIds(scope);
  const sessionId = (scope === 'current' && ids.length) ? ids[0] : null;

  const exportId = makeExportId();
  const dir = path.join(cfg.EXPORTS_DIR, exportId);
  fs.mkdirSync(dir, { recursive: true });

  const reportData = reportList.map((r) => {
    const { headers, rows } = BUILDERS[r](ids);
    return { report: r, headers, rows };
  });

  const files = [];
  for (const fmt of fmts) {
    if (fmt === 'csv') {
      for (const rd of reportData) {
        const fileName = writeCsv(dir, rd.report, rd.headers, rd.rows);
        const stat = fs.statSync(path.join(dir, fileName));
        files.push({ fileName, report: rd.report, format: 'csv', sizeBytes: stat.size, downloadUrl: `/api/v1/exports/${exportId}/files/${encodeURIComponent(fileName)}` });
      }
    } else if (fmt === 'xlsx') {
      const fileName = writeXlsx(dir, reportData);
      const stat = fs.statSync(path.join(dir, fileName));
      files.push({ fileName, report: 'all', format: 'xlsx', sizeBytes: stat.size, downloadUrl: `/api/v1/exports/${exportId}/files/${encodeURIComponent(fileName)}` });
    }
  }

  const createdAt = Date.now();
  const manifest = buildManifest(exportId, sessionId, files, createdAt);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

function getExport(exportId) {
  if (/(\.\.)|([/\\])/.test(exportId || '')) fail('E-VAL-01', '非法的导出批次标识');
  const manifestPath = path.join(cfg.EXPORTS_DIR, exportId, 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail('E-NOTFOUND', '导出批次不存在');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

// 校验文件名白名单（防路径穿越）：只允许该 exportId 清单内的文件名
function resolveFile(exportId, fileName) {
  if (/(\.\.)|([/\\])/.test(fileName || '')) fail('E-VAL-01', '非法的文件名');
  const manifest = getExport(exportId);
  const found = manifest.files.find((f) => f.fileName === fileName);
  if (!found) fail('E-VAL-01', '文件不在导出清单内');
  const filePath = path.join(cfg.EXPORTS_DIR, exportId, fileName);
  if (!fs.existsSync(filePath)) fail('E-NOTFOUND', '文件不存在');
  return { filePath, file: found };
}

module.exports = { REPORTS, createExport, getExport, resolveFile };
