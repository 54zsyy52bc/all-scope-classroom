'use strict';
// Preset Studio 渲染层无头测试（DOM 桩 + StudioApi 桩）。
// 验证：适配层装配、初始列表渲染、班级/活动保存负载、器材字典保存、导出调用。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'renderer');
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

// ---------- 桩 DOM ----------
const elsMap = {};
function makeEl(id) {
  const classSet = new Set();
  return {
    id, value: '', textContent: '', innerHTML: '', hidden: true, dataset: {},
    className: '', _listeners: {}, children: [],
    classList: {
      add(c) { classSet.add(c); this._c = classSet; },
      remove(c) { classSet.delete(c); },
      contains(c) { return classSet.has(c); },
      _s: classSet,
    },
    addEventListener(ev, fn) { this._listeners[ev] = fn; },
    onclick: null, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; },
    appendChild() {}, removeChild() {}, prepend() {}, click() {},
  };
}
const byId = [
  'brand-mark', 'btn-import-pkg', 'btn-export-pkg',
  'panel-classes', 'panel-activities', 'panel-dict',
  'c-name', 'c-seats', 'c-group', 'c-note', 'btn-class-save', 'class-list',
  'a-name', 'a-category', 'a-note', 'a-timed', 'a-duration',
  'eq-editor', 'btn-eq-add', 'tpl-editor', 'btn-tpl-add', 'btn-activity-save', 'activity-list',
  'd-eqid', 'd-eqname', 'd-category', 'btn-dict-save', 'dict-list',
  'overlay-import', 'import-title', 'import-file-name', 'import-result',
  'import-cancel', 'import-commit', 'toast',
];
for (const id of byId) elsMap[id] = makeEl(id);

const tabBtns = [makeEl('tab-classes'), makeEl('tab-activities'), makeEl('tab-dict')];
const documentStub = {
  readyState: 'loading',
  addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') domReady = fn; },
  getElementById(id) { return elsMap[id] || (elsMap[id] = makeEl(id)); },
  createElement(tag) { return makeEl(tag); },
  createTextNode() { return { textContent: '' }; },
  querySelectorAll(sel) {
    if (sel === '.tab') return tabBtns;
    if (sel === '.tab-panel') return [elsMap['panel-classes'], elsMap['panel-activities'], elsMap['panel-dict']];
    return [];
  },
};
let domReady = null;

// ---------- 桩 StudioApi（内存模拟主进程 store）----------
const studioLog = [];
const memory = { classes: [], activities: [], dict: [{ eqId: 'LED', eqName: 'LED', category: '元件' }] };
globalThis.StudioApi = {
  listAll: async () => ({
    classes: memory.classes.map((c) => Object.assign({}, c)),
    activities: memory.activities.map((a) => Object.assign({}, a, { equipment: a.equipment.slice(), taskTemplates: a.taskTemplates.slice() })),
    dict: memory.dict.map((d) => Object.assign({}, d)),
  }),
  saveClass: async (row) => {
    studioLog.push({ op: 'class:save', body: row });
    const r = Object.assign({ preset_id: row.preset_id || 'CP-GEN001' }, row);
    const i = memory.classes.findIndex((c) => c.preset_id === r.preset_id);
    if (i >= 0) memory.classes[i] = r; else memory.classes.push(r);
    return Object.assign({}, r);
  },
  removeClass: async (id) => { memory.classes = memory.classes.filter((c) => c.preset_id !== id); return { presetId: id }; },
  saveActivity: async (row) => {
    studioLog.push({ op: 'activity:save', body: row });
    const r = Object.assign({ preset_id: row.preset_id || 'AP-GEN001' }, row);
    const i = memory.activities.findIndex((a) => a.preset_id === r.preset_id);
    if (i >= 0) memory.activities[i] = r; else memory.activities.push(r);
    return Object.assign({}, r);
  },
  removeActivity: async (id) => { memory.activities = memory.activities.filter((a) => a.preset_id !== id); return { presetId: id }; },
  saveDict: async (item) => { studioLog.push({ op: 'dict:save', body: item }); memory.dict.push(item); return item; },
  removeDict: async () => ({}),
  pkgExport: async () => { studioLog.push({ op: 'pkg:export' }); return { pkg: 'kct-preset-package', schemaVersion: 1, exportedAt: Date.now(), classes: [], activities: [] }; },
  pkgSaveFile: async () => { studioLog.push({ op: 'pkg:save-file' }); return null; },
  pkgOpenFile: async () => null,
  pkgPreview: async () => ({}),
  pkgCommit: async () => ({}),
};
globalThis.window = globalThis;
globalThis.document = documentStub;
globalThis.confirm = () => true;

// 预置一个已保存活动（渲染列表用）
memory.activities.push({
  preset_id: 'AP-EXIST', name: '焊接入门', category: '焊接', timed: true, durationSec: 480,
  equipment: [{ eqId: 'DEV-BOARD', eqName: '开发板', category: '主控', preset: 1 }],
  taskTemplates: [{ title: '点亮 LED', desc: '' }], note: null,
});

// ---------- 加载脚本（按页面顺序）----------
(0, eval)(fs.readFileSync(path.join(ROOT, 'icons.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'presets.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'preset-class-ui.js'), 'utf8'));
if (domReady) domReady();

async function main() {
  await new Promise((r) => setTimeout(r, 30));
  check('初始刷新：活动列表渲染已保存活动', elsMap['activity-list'].innerHTML.includes('焊接入门'),
    elsMap['activity-list'].innerHTML.slice(0, 120));
  check('初始刷新：活动列表显示计时信息', elsMap['activity-list'].innerHTML.includes('计时 8 分钟'),
    elsMap['activity-list'].innerHTML.slice(0, 200));
  check('器材字典渲染种子', elsMap['dict-list'].innerHTML.includes('LED'));

  // 班级保存（新建，无 presetId）
  elsMap['c-name'].value = '初二(1)班';
  elsMap['c-seats'].value = '48';
  elsMap['c-group'].value = '6';
  elsMap['c-note'].value = '东机房';
  elsMap['btn-class-save'].onclick();
  await new Promise((r) => setTimeout(r, 30));
  const clsSave = studioLog.find((l) => l.op === 'class:save');
  check('班级保存：负载正确', !!clsSave && clsSave.body.name === '初二(1)班' && clsSave.body.totalSeats === 48
    && clsSave.body.groupSize === 6 && clsSave.body.preset_id === undefined,
    clsSave ? JSON.stringify(clsSave.body) : '无调用');
  check('班级保存：v4.2 挂载 groups/equipment 键', !!clsSave && Array.isArray(clsSave.body.groups)
    && Array.isArray(clsSave.body.equipment), clsSave ? JSON.stringify(clsSave.body.groups) : '');
  check('PresetClassUi 已装配', !!global.PresetClassUi && typeof global.PresetClassUi.collectGroups === 'function');
  check('班级保存后表单重置', elsMap['c-name'].value === '');
  check('班级保存后列表刷新', elsMap['class-list'].innerHTML.includes('初二(1)班'),
    elsMap['class-list'].innerHTML.slice(0, 120));

  // 活动保存（计时 8 分钟 + 器材 + 模板）
  elsMap['a-name'].value = '传感器实验';
  elsMap['a-category'].value = '传感器';
  elsMap['a-timed'].checked = true;
  elsMap['a-duration'].value = '8';
  // 器材行桩：presets.js 的 saveActivity 校验「至少一件器材」，模拟一行
  const eqRowStub = {
    querySelector(sel) {
      const map = {
        '[data-eq-id]': { value: 'SENSOR-T' },
        '[data-eq-name]': { value: '温度传感器' },
        '[data-eq-cat]': { value: '传感器' },
        '[data-eq-preset]': { value: '2' },
      };
      return map[sel] || { value: '' };
    },
  };
  elsMap['eq-editor'].querySelectorAll = (sel) => (sel === '.eq-row' ? [eqRowStub] : []);
  elsMap['tpl-editor'].querySelectorAll = (sel) => (sel === '.tpl-row' ? [] : []);
  elsMap['btn-activity-save'].onclick();
  await new Promise((r) => setTimeout(r, 30));
  const actSave = studioLog.filter((l) => l.op === 'activity:save').pop();
  check('活动保存：负载含名称/计时', !!actSave && actSave.body.name === '传感器实验' && actSave.body.timed === true
    && actSave.body.durationSec === 480, actSave ? JSON.stringify(actSave.body) : '无调用');
  check('活动保存：器材与模板为数组', !!actSave && Array.isArray(actSave.body.equipment) && Array.isArray(actSave.body.taskTemplates));
  check('活动保存：器材行字段收集', !!actSave && actSave.body.equipment.length === 1
    && actSave.body.equipment[0].eqId === 'SENSOR-T' && actSave.body.equipment[0].preset === 2,
    actSave ? JSON.stringify(actSave.body.equipment) : '');

  // 器材字典保存
  elsMap['d-eqid'].value = 'SENSOR-X';
  elsMap['d-eqname'].value = '测试传感器';
  elsMap['d-category'].value = '传感器';
  elsMap['btn-dict-save'].onclick();
  await new Promise((r) => setTimeout(r, 30));
  const dictSave = studioLog.find((l) => l.op === 'dict:save');
  check('字典保存：负载正确', !!dictSave && dictSave.body.eqId === 'SENSOR-X' && dictSave.body.eqName === '测试传感器');
  check('字典保存后列表刷新', elsMap['dict-list'].innerHTML.includes('SENSOR-X'));

  // 导出调用
  elsMap['btn-export-pkg'].onclick();
  await new Promise((r) => setTimeout(r, 20));
  check('导出：触发 pkgExport', studioLog.some((l) => l.op === 'pkg:export'));

  // 适配层拒绝不支持的接口（无课堂接口可用）
  const j = await global.Editor.api('POST', '/api/v1/task', { title: 'x' });
  check('适配层拒绝课堂接口', j.code === 1, JSON.stringify(j));

  console.log('\nPreset Studio 渲染层验证：' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常:', e && e.stack || e);
  process.exit(1);
});
