'use strict';
// =============================================================================
// 教师大屏无头验证（DOM 桩 + fetch / EventSource 桩）
//
// 验证：快照渲染（统计/阶段/小组墙/任务横幅）、SSE stream.ready 应用、
//       开始上课弹窗、导出触发、强制关机确认。
// 运行：node test/dashboard.dom.test.js
// =============================================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'public');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}

// ---------- 快照样例（与 dashboard.service.js 输出逐字段一致）----------
const SNAP = {
  revision: 7, serverTs: Date.now(),
  session: { sessionId: 'S-TEST', teacher: '王老师', className: '初二(1)班', startTime: Date.now(), endTime: null, phase: 'task', totalSeats: 50, exportFlag: false },
  stats: { checkedIn: 45, pending: 5, checkinRate: 0.9, online: 44, offline: 6, taskDoing: 3, taskDone: 40, taskHelp: 2, returned: 0, borrowRate: 0 },
  currentTask: { taskId: 'T-001', sessionId: 'S-TEST', title: '焊接练习', desc: '第一关 · 点亮 LED', publishTime: Date.now(), closeTime: null, timed: true, durationSec: 600, timerState: 'running', remainingMs: 600000 },
  groups: [
    { groupId: 'G1', seats: ['01', '02', '03', '04', '05'], checkedIn: 5, helpCount: 1, doneCount: 4, returned: false, hasHelp: true },
    { groupId: 'G2', seats: ['06', '07', '08', '09', '10'], checkedIn: 4, helpCount: 0, doneCount: 3, returned: false, hasHelp: false },
  ],
  seats: [
    { seat: '01', groupId: 'G1', name: '张三', checkinStatus: 'done', taskStatus: 'help', returnStatus: 'pending', online: true, lastSeenAt: Date.now(), conflict: false },
    { seat: '02', groupId: 'G1', name: '李四', checkinStatus: 'done', taskStatus: 'done', returnStatus: 'pending', online: true, lastSeenAt: Date.now(), conflict: false },
    { seat: '06', groupId: 'G2', name: '王五', checkinStatus: 'pending', taskStatus: null, returnStatus: 'pending', online: false, lastSeenAt: null, conflict: true },
  ],
  conflicts: [{ seat: '06', machineIds: ['PC-A', 'PC-B'], firstSeenAt: Date.now(), lastSeenAt: Date.now(), messageCount: 2 }],
  mqtt: { state: 'online' },
};

// ---------- 桩 DOM ----------
const elsMap = {};
function makeEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', hidden: true, dataset: {},
    className: '', _listeners: {},
    addEventListener(ev, fn) { this._listeners[ev] = fn; },
    onclick: null,
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    appendChild(child) {
      if (child && child.textContent !== undefined) this.textContent += child.textContent;
    },
    removeChild() {},
    prepend() {},
    children: [],
  };
}
const byId = new Set([
  'brand-mark', 'class-meta', 'phase-pill', 'conn-pill', 'st-checkin', 'st-checkin-rate',
  'st-pending', 'st-online', 'st-online-rate', 'st-help', 'st-task-done', 'st-returned',
  'task-banner', 'task-icon', 'task-title', 'task-desc', 'ts-doing', 'ts-done', 'ts-help',
  'groups', 'alerts', 'events-body', 'toast', 'btn-start', 'btn-task', 'btn-end', 'btn-shutdown',
  'btn-export-xlsx', 'btn-export-csv', 'confirm-start', 'confirm-task', 'f-teacher', 'f-class',
  'f-seats', 'f-task-title', 'f-task-desc', 'overlay-start', 'overlay-task',
  'f-class-preset', 'f-activity-preset', 'f-activity-hint', 'tpl-chips',
  'manage', 'btn-manage', 'btn-manage-close', 'm-import-file', 'm-import-btn', 'm-export-btn',
  'm-import-result', 'm-class-list', 'm-activity-list',
  'f-task-preset', 'f-task-timed', 'f-task-duration',
  'activity-bar', 'ab-icon', 'ab-title', 'ab-desc', 'ab-time', 'ab-state',
  'ab-pause', 'ab-resume', 'ab-adjust', 'ab-restart', 'ab-stop', 'btn-policy',
]);
for (const id of byId) elsMap[id] = makeEl(id);
// 弹窗内的输入框：让 querySelectorAll('input') 返回假元素
elsMap['overlay-start'].querySelectorAll = () => [elsMap['f-teacher'], elsMap['f-class'], elsMap['f-seats']];
elsMap['overlay-task'].querySelectorAll = () => [elsMap['f-task-title'], elsMap['f-task-desc']];
elsMap['overlay-start'].querySelector = () => elsMap['f-teacher'];
elsMap['overlay-task'].querySelector = () => elsMap['f-task-title'];
// events-body 需要 createElement 出的子元素结构
const fakeChild = { appendChild() {}, textContent: '' };
elsMap['events-body'].prepend = (c) => { elsMap['events-body'].children.unshift(c); };
elsMap['events-body'].removeChild = () => { elsMap['events-body'].children.pop(); };

let domReady = null;
const documentStub = {
  readyState: 'loading',
  body: makeEl('body'),
  addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') domReady = fn; },
  createTextNode(t) { return { textContent: t }; },
  getElementById(id) { return elsMap[id] || (elsMap[id] = makeEl(id)); },
  createElement(tag) { return makeEl(tag); },
  querySelectorAll(sel) { return []; },
};

// ---------- 桩 fetch / EventSource / confirm ----------
const fetchLog = [];
async function fetchStub(url, opts) {
  const method = (opts && opts.method) || 'GET';
  fetchLog.push({ url, method, body: opts && opts.body ? JSON.parse(opts.body) : null });
  if (url.endsWith('/dashboard/snapshot')) return { json: async () => ({ code: 0, data: SNAP }) };
  if (url.endsWith('/presets/export')) {
    return { json: async () => ({ code: 0, data: { pkg: 'kct-preset-package', schemaVersion: 1, exportedAt: Date.now(), classes: [], activities: [] } }) };
  }
  if (url.includes('/presets/import')) {
    return { json: async () => ({ code: 0, data: { added: 0, updated: 0, skipped: 0, items: [] } }) };
  }
  if (url.includes('/presets/')) return { json: async () => ({ code: 0, data: [] }) };
  if (url.includes('/exports')) {
    return {
      json: async () => ({
        code: 0,
        data: { exportId: 'E-TEST', files: [{ fileName: '课堂报表.xlsx', format: 'xlsx', downloadUrl: '/api/v1/exports/E-TEST/files/%E8%AF%BE%E5%A0%82%E6%8A%A5%E8%A1%A8.xlsx' }] },
      }),
    };
  }
  if (method === 'POST') return { json: async () => ({ code: 0, data: { ok: true } }) };
  return { json: async () => ({ code: 0, data: {} }) };
}
let esHandler = null;
function EventSourceStub() {
  this.addEventListener = (name, fn) => { (esHandler = esHandler || {})[name] = fn; };
  this.onerror = null;
}
const clickedDownloads = [];
const downloadAnchor = {
  _download: '',
  set href(v) {},
  set download(v) { this._download = v; },
  get download() { return this._download; },
  set target(v) {},
  click() { clickedDownloads.push(this._download); },
};
documentStub.createElement = (tag) => (tag === 'a' ? downloadAnchor : makeEl(tag));
// manage.js exportPackage 依赖 Blob / URL.createObjectURL
globalThis.Blob = function () { return { size: 0 }; };
globalThis.URL = Object.assign(globalThis.URL || {}, {
  createObjectURL: () => 'blob:test',
  revokeObjectURL: () => {},
});

// ---------- 加载大屏脚本 ----------
globalThis.window = globalThis;
globalThis.document = documentStub;
globalThis.fetch = fetchStub;
globalThis.EventSource = EventSourceStub;
globalThis.confirm = () => true;
// 预载 Icons（真实 icons.js），然后按页面顺序加载 app.js → presets.js → activity.js → manage.js → stream.js
(0, eval)(fs.readFileSync(path.join(ROOT, 'icons.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'presets.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'admit.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'activity.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'manage.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'stream.js'), 'utf8'));
// 模拟浏览器：全部脚本加载后触发 DOMContentLoaded（app.js 的 init 在此执行）
if (domReady) domReady();

// ---------- 断言 ----------
async function main() {
  // init 拉快照并渲染
  await new Promise((r) => setTimeout(r, 30));
  check('阶段渲染为 task（课中）', elsMap['phase-pill'].textContent === '课中', elsMap['phase-pill'].textContent);
  check('班级信息渲染', elsMap['class-meta'].textContent.includes('初二(1)班'));
  check('已登记统计', Number(elsMap['st-checkin'].textContent) === 45, elsMap['st-checkin'].textContent);
  check('登记率', elsMap['st-checkin-rate'].textContent === '90%', elsMap['st-checkin-rate'].textContent);
  check('求助统计', Number(elsMap['st-help'].textContent) === 2, elsMap['st-help'].textContent);
  check('任务横幅可见且标题正确', elsMap['task-banner'].hidden === false && elsMap['task-title'].textContent === '焊接练习');
  check('任务统计：已完成 40', Number(elsMap['ts-done'].textContent) === 40, elsMap['ts-done'].textContent);
  check('小组墙渲染 G1 与 G2', elsMap['groups'].innerHTML.includes('G1') && elsMap['groups'].innerHTML.includes('G2'));
  check('小组墙带求助徽标', elsMap['groups'].innerHTML.includes('求助 1'));
  check('座位 06 冲突标记', elsMap['groups'].innerHTML.includes('s-conflict'));
  check('冲突提示可见', elsMap['alerts'].hidden === false && elsMap['alerts'].innerHTML.includes('06'));
  check('连接状态为在线', elsMap['conn-pill'].dataset.state === 'online');

  // SSE stream.ready 再推一次快照（revision 更新场景）
  esHandler['stream.ready']({ data: JSON.stringify({ payload: { snapshot: SNAP } }) });
  check('stream.ready 应用后仍渲染正确', elsMap['phase-pill'].textContent === '课中');

  // 活动计时条（SNAP.currentTask timed running → 10:00）
  check('活动计时条显示 10:00', elsMap['activity-bar'].hidden === false && elsMap['ab-time'].textContent === '10:00',
    elsMap['ab-time'].textContent);
  check('计时条标题', elsMap['ab-title'].textContent === '焊接练习');

  // SSE activity.timer 暂停 → 计时条更新
  esHandler['activity.timer']({ data: JSON.stringify({ payload: { taskId: 'T-001', state: 'paused', remainingMs: 420000 } }) });
  check('SSE 暂停 → 计时条 07:00 + 已暂停', elsMap['ab-time'].textContent === '07:00' && elsMap['ab-state'].textContent === '已暂停',
    elsMap['ab-time'].textContent + ' / ' + elsMap['ab-state'].textContent);
  check('暂停时显示「继续」按钮', elsMap['ab-resume'].hidden === false);

  // SSE policy.changed → 策略按钮文案
  esHandler['policy.changed']({ data: JSON.stringify({ payload: { mode: 'activity', locked: true, phase: 'task', reason: 'no-activity' } }) });
  check('策略按钮更新为仅活动期间', elsMap['btn-policy'].textContent.includes('仅活动期间'), elsMap['btn-policy'].textContent);

  // 点击策略按钮 → POST policy 切换
  elsMap['btn-policy'].onclick();
  await new Promise((r) => setTimeout(r, 10));
  const polCall = fetchLog.find((f) => f.method === 'POST' && f.url.includes('/policy'));
  check('切换策略 POST 负载', !!polCall && polCall.body.mode === 'open', polCall ? JSON.stringify(polCall.body) : '无调用');

  // 发布活动（计时 5 分钟）
  elsMap['btn-task'].onclick();
  await new Promise((r) => setTimeout(r, 10));
  elsMap['f-task-title'].value = '自定义活动';
  elsMap['f-task-timed'].checked = true;
  elsMap['f-task-duration'].value = 5;
  elsMap['confirm-task'].onclick();
  await new Promise((r) => setTimeout(r, 10));
  const actCall = fetchLog.find((f) => f.method === 'POST' && f.url.includes('/activities'));
  check('发布活动 POST 负载（计时 5 分钟）', !!actCall && actCall.body.title === '自定义活动' && actCall.body.timed === true && actCall.body.durationSec === 300,
    actCall ? JSON.stringify(actCall.body) : '无调用');

  // 开始上课弹窗
  elsMap['btn-start'].onclick();
  check('点击开始上课打开弹窗', elsMap['overlay-start'].hidden === false);
  elsMap['f-teacher'].value = '李老师';
  elsMap['f-class'].value = '初二(2)班';
  elsMap['f-seats'].value = '48';
  elsMap['confirm-start'].onclick();
  await new Promise((r) => setTimeout(r, 10));
  const startCall = fetchLog.find((f) => f.method === 'POST' && f.url === '/api/v1/sessions');
  check('开始上课 POST 参数正确', !!startCall && startCall.body.teacher === '李老师' && startCall.body.totalSeats === 48);
  check('开始上课后弹窗关闭', elsMap['overlay-start'].hidden === true);
  check('事件流记录开始上课', elsMap['events-body'].children.some((c) => c.textContent && c.textContent.includes('开始上课')));

  // 导出 xlsx
  elsMap['btn-export-xlsx'].onclick();
  await new Promise((r) => setTimeout(r, 10));
  const exportCall = fetchLog.find((f) => f.url.includes('/exports'));
  check('导出 POST 带 formats=[xlsx]', !!exportCall && exportCall.body.formats[0] === 'xlsx');
  check('触发文件下载（a.click）', clickedDownloads.length >= 1, clickedDownloads.join(','));

  // 强制关机（confirm 桩返回 true）
  elsMap['btn-shutdown'].onclick();
  await new Promise((r) => setTimeout(r, 10));
  const shutCall = fetchLog.find((f) => f.method === 'POST' && f.url === '/api/v1/commands/shutdown');
  check('强制关机 POST force=true', !!shutCall && shutCall.body.force === true);

  // 结束课堂归档（return -> closed，v4.1 补的 UI 闭环）
  elsMap['btn-finish'].onclick();
  await new Promise((r) => setTimeout(r, 10));
  const finCall = fetchLog.find((f) => f.method === 'POST' && f.url === '/api/v1/session/finish');
  check('结束课堂 POST /session/finish', !!finCall, finCall ? '' : '无调用');

  // 预设管理面板（v4 收编：无编辑表单，只有导入/导出/列表/删除）
  check('面板初始隐藏', elsMap['manage'].hidden === true);
  elsMap['btn-manage'].onclick();
  check('点「预设管理」打开面板', elsMap['manage'].hidden === false);
  check('面板不再有新建班级输入框', !elsMap['m-c-name'], '仍存在 m-c-name');
  check('列表空态提示引导至办公端编辑器', elsMap['m-class-list'].innerHTML.includes('预设编辑器'),
    elsMap['m-class-list'].innerHTML.slice(0, 80));
  // 导出备份 → fetch /presets/export + 触发下载
  elsMap['m-export-btn'].onclick();
  await new Promise((r) => setTimeout(r, 10));
  const pkgCall = fetchLog.find((f) => f.url.endsWith('/presets/export'));
  check('导出备份 GET /presets/export', !!pkgCall);
  check('导出触发 .kctpreset 文件下载', clickedDownloads.some((d) => d.endsWith('.kctpreset')),
    clickedDownloads.join(','));

  // 清理活动计时条/快照合并等残留定时器，避免进程退出竞态
  for (let i = 1; i <= 20; i += 1) clearInterval(i);
  console.log('\n大屏验证：' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常:', e && e.stack || e);
  process.exit(1);
});
