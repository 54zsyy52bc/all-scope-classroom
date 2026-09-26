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
    appendChild() {}, removeChild() {}, prepend() {},
    click() { if (this._listeners.click) this._listeners.click(); },
    insertAdjacentHTML(_pos, html) { this.innerHTML += html; },
  };
}
const byId = [
  'brand-mark', 'btn-import-pkg', 'btn-export-pkg',
  'panel-classes', 'panel-activities', 'panel-dict',
  'c-name', 'c-seats', 'c-group', 'c-note', 'c-grade', 'c-room', 'c-teacher', 'btn-class-save', 'class-list',
  'btn-class-reset', 'btn-activity-reset',
  'a-name', 'a-category', 'a-note', 'a-timed', 'a-duration',
  'eq-editor', 'btn-eq-add', 'tpl-editor', 'btn-tpl-add', 'btn-activity-save', 'activity-list',
  'd-eqid', 'd-eqname', 'd-category', 'btn-dict-save', 'dict-list',
  'overlay-import', 'import-title', 'import-file-name', 'import-result',
  'import-cancel', 'import-commit', 'toast',
  'ss-ai-result', 'ss-target-class',
  'overlay-oobe', 'ob-dots', 'ob-step-1', 'ob-step-teacher', 'ob-step-2', 'ob-step-import', 'ob-step-3', 'ob-step-4',
  'ob-class-name', 'ob-seats', 'ob-group', 'ob-dict-seed', 'ob-prev', 'ob-next', 'ob-skip',
  'ob-teacher-name', 'ob-teacher-school', 'ob-import-pkg',
];
for (const id of byId) elsMap[id] = makeEl(id);

const tabBtns = [makeEl('tab-classes'), makeEl('tab-activities'), makeEl('tab-dict')];
tabBtns[0].dataset = { tab: 'classes' }; tabBtns[1].dataset = { tab: 'activities' }; tabBtns[2].dataset = { tab: 'dict' };
const documentStub = {
  readyState: 'loading',
  addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') domReady = fn; },
  removeEventListener() {},
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
const metaStore = {};
let genSeq = 0; // 桩 id 自增（与真实 store.genId 行为一致）
const memory = { classes: [], activities: [], dict: [{ eqId: 'LED', eqName: 'LED', category: '元件' }] };
globalThis.StudioApi = {
  listAll: async () => ({
    // 与真实 store 一致：snake_case 落库 + presetId camelCase 别名出栈
    classes: memory.classes.map((c) => Object.assign({}, c, { presetId: c.preset_id })),
    activities: memory.activities.map((a) => Object.assign({}, a, { presetId: a.preset_id, equipment: a.equipment.slice(), taskTemplates: a.taskTemplates.slice() })),
    dict: memory.dict.map((d) => Object.assign({}, d)),
  }),
  saveClass: async (row) => {
    studioLog.push({ op: 'class:save', body: row });
    const r = Object.assign({ preset_id: row.preset_id || 'CP-GEN' + String(++genSeq).padStart(3, '0') }, row);
    const i = memory.classes.findIndex((c) => c.preset_id === r.preset_id);
    if (i >= 0) memory.classes[i] = r; else memory.classes.push(r);
    return Object.assign({}, r);
  },
  removeClass: async (id) => { memory.classes = memory.classes.filter((c) => c.preset_id !== id); return { presetId: id }; },
  saveActivity: async (row) => {
    studioLog.push({ op: 'activity:save', body: row });
    const r = Object.assign({ preset_id: row.preset_id || 'AP-GEN' + String(++genSeq).padStart(3, '0') }, row);
    const i = memory.activities.findIndex((a) => a.preset_id === r.preset_id);
    if (i >= 0) memory.activities[i] = r; else memory.activities.push(r);
    return Object.assign({}, r);
  },
  removeActivity: async (id) => { memory.activities = memory.activities.filter((a) => a.preset_id !== id); return { presetId: id }; },
  saveDict: async (item) => { studioLog.push({ op: 'dict:save', body: item }); memory.dict.push(item); return item; },
  removeDict: async () => ({}),
  metaGet: async (key) => (key in metaStore ? metaStore[key] : null),
  metaSet: async (key, value) => { metaStore[key] = value; return value; },
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
(0, eval)(fs.readFileSync(path.join(ROOT, 'class-roster-ui.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'class-lessons-ui.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'smart-import.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'smart-studio.js'), 'utf8'));
(0, eval)(fs.readFileSync(path.join(ROOT, 'oobe.js'), 'utf8'));
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
  elsMap['c-grade'].value = '初二';
  elsMap['c-room'].value = '东机房';
  elsMap['c-teacher'].value = '张老师';
  elsMap['btn-class-save'].onclick();
  await new Promise((r) => setTimeout(r, 30));
  const clsSave = studioLog.find((l) => l.op === 'class:save');
  check('班级保存：负载正确', !!clsSave && clsSave.body.name === '初二(1)班' && clsSave.body.totalSeats === 48
    && clsSave.body.groupSize === 6 && clsSave.body.preset_id === undefined,
    clsSave ? JSON.stringify(clsSave.body) : '无调用');
  check('班级保存：v4.2 挂载 groups/equipment 键', !!clsSave && Array.isArray(clsSave.body.groups)
    && Array.isArray(clsSave.body.equipment), clsSave ? JSON.stringify(clsSave.body.groups) : '');
  check('班级保存：v5 信息包进负载', !!clsSave && !!clsSave.body.info
    && clsSave.body.info.grade === '初二' && clsSave.body.info.teacher === '张老师',
    clsSave ? JSON.stringify(clsSave.body.info) : '');
  check('班级保存：v5 学生包/课时包键存在', !!clsSave && Array.isArray(clsSave.body.students)
    && Array.isArray(clsSave.body.lessons),
    clsSave ? JSON.stringify([clsSave.body.students, clsSave.body.lessons]) : '');
  check('PresetClassUi 已装配', !!global.PresetClassUi && typeof global.PresetClassUi.collectGroups === 'function');
  const savedCls = (global.Editor.classes || []).find((c) => c.name === '初二(1)班');
  check('班级保存后保持编辑态（不清空，可继续调整）', elsMap['c-name'].value === '初二(1)班'
    && elsMap['c-name'].dataset.editId === savedCls.presetId
    && elsMap['btn-class-save'].textContent === '保存修改',
    JSON.stringify([elsMap['c-name'].value, elsMap['c-name'].dataset.editId]));
  elsMap['btn-class-reset'].onclick();
  check('清空新建：回到新建态', elsMap['c-name'].value === ''
    && elsMap['btn-class-save'].textContent !== '保存修改');
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
  const savedAct = (global.Editor.activities || []).find((a) => a.name === '传感器实验');
  check('活动保存后保持编辑态', elsMap['a-name'].value === '传感器实验'
    && !!savedAct && elsMap['a-name'].dataset.editId === savedAct.presetId
    && elsMap['btn-activity-save'].textContent === '保存修改');

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

  // 批量课件导入：识别活动 → 每课件一个课时 + 活动批量创建挂接（同名去重）
  globalThis.StudioApi.pickCourseware = async () => ({ files: [
    { fileName: '点亮LED.pptx', baseName: '点亮LED', filePath: 'C:/f/点亮LED.pptx' },
    { fileName: '面包板入门.pdf', baseName: '面包板入门', filePath: 'C:/f/面包板入门.pdf' },
  ] });
  globalThis.StudioApi.parseCourseware = async (paths) => paths.map((p) => (p.endsWith('.pptx')
    ? { fileName: '点亮LED.pptx', baseName: '点亮LED', titles: ['活动一：认识面包板', '实验：LED 亮度'] }
    : { fileName: '面包板入门.pdf', baseName: '面包板入门', titles: [], reason: '该格式暂不支持内容识别（PPTX/DOCX 可识别），已按文件名生成课时' }));
  await global.PresetSmart.importCourseware();
  const cwActs = studioLog.filter((l) => l.op === 'activity:save'
    && ['活动一：认识面包板', '实验：LED 亮度'].includes(l.body.name));
  check('批量课件：识别到的 2 个活动已创建', cwActs.length === 2
    && cwActs.some((l) => l.body.name === '活动一：认识面包板') && cwActs.some((l) => l.body.name === '实验：LED 亮度'),
    JSON.stringify(cwActs.map((l) => l.body.name)));
  const cwIds = ['活动一：认识面包板', '实验：LED 亮度'].map((n) => (global.Editor.activities || []).find((a) => a.name === n));
  check('批量课件：两个活动 id 独立（不互相覆盖）', cwIds.every(Boolean) && cwIds[0].presetId !== cwIds[1].presetId,
    JSON.stringify(cwIds.map((a) => a && a.presetId)));
  const lessonsHtml = elsMap['c-lessons-editor'].innerHTML;
  check('批量课件：两个课时骨架生成', /点亮LED/.test(lessonsHtml) && /面包板入门/.test(lessonsHtml),
    lessonsHtml.slice(0, 200));
  check('批量课件：活动 chip 自动勾选挂接', (lessonsHtml.match(/data-l-act value="AP-[^"]*" checked/g) || []).length >= 2,
    lessonsHtml.slice(-260));
  check('批量课件：缓存含新建活动', ['活动一：认识面包板', '实验：LED 亮度'].every((n) => (global.Editor.activities || []).some((a) => a.name === n)));
  check('批量课件：PDF 降级提示', /暂不支持/.test(elsMap['roster-import-note'].innerHTML || ''), elsMap['roster-import-note'].innerHTML.slice(0, 150));

  // ===================== 智能生成页：快速识别 → AI 回贴 → 确认入库 =====================
  // 前置：保存一个班级进入缓存（作为入库目标）
  elsMap['btn-class-reset'].onclick(); // 连贯化出口：编辑态下先清空再新建
  elsMap['c-name'].value = '初二(9)班';
  elsMap['btn-class-save'].onclick();
  await new Promise((r) => setTimeout(r, 30));
  const clsSmart = (global.Editor.classes || []).find((c) => c.name === '初二(9)班');
  check('智能生成：前置班级已入缓存', !!clsSmart && !!clsSmart.presetId, JSON.stringify(global.Editor.classes.map((c) => c.name)));

  // 快速识别：桩返回活动标题 + 依据 dict 的器材命中 + AI 用全文行
  global.Editor.dict = [{ eqId: 'LED', eqName: 'LED 发光二极管', category: '元件' }];
  globalThis.StudioApi.parseCourseware = async (payload) => {
    const paths = Array.isArray(payload) ? payload : payload.paths;
    const dict = Array.isArray(payload) ? [] : (payload.dict || []);
    return paths.map((p) => (p.endsWith('.pptx') ? {
      fileName: '点亮LED.pptx', baseName: '点亮LED',
      titles: ['活动一：认识面包板', '实验：LED 亮度'],
      equipment: dict.some((d) => d.eqId === 'LED') ? [{ eqId: 'LED', eqName: 'LED 发光二极管', preset: 1 }] : [],
      lines: ['第1课 点亮LED', '实验：观察 LED 亮度变化'],
    } : { fileName: '面包板入门.pdf', baseName: '面包板入门', titles: [], equipment: [], lines: [] }));
  };
  globalThis.StudioApi.openAiPage = async (url, prompt) => ({ copied: !!prompt, opened: !!url });
  elsMap['ss-import-quick'].onclick();
  await new Promise((r) => setTimeout(r, 30));
  check('智能生成：快速识别产生 2 条草稿', global.PresetSmartStudio._drafts().length === 2,
    JSON.stringify(global.PresetSmartStudio._drafts().map((d) => d.fileName)));
  const ssHtml = elsMap['ss-drafts'].innerHTML;
  check('智能生成：草稿含识别活动与器材命中', ssHtml.includes('实验：LED 亮度') && ssHtml.includes('LED 发光二极管'),
    ssHtml.slice(0, 200));

  // AI 回贴：覆盖第一条草稿（课时名/活动/器材）
  elsMap['ss-ai-result'].value = JSON.stringify([{
    courseware: '点亮LED.pptx', lessonName: '第1课 点亮LED（AI）',
    activities: [{ name: '挑战：设计交通灯' }], equipment: [{ eqId: 'LED', preset: 3 }],
  }]);
  await global.PresetSmartStudio.applyAiResult();
  const d0 = global.PresetSmartStudio._drafts()[0];
  check('智能生成：AI 回贴覆盖草稿', d0.lessonName === '第1课 点亮LED（AI）'
    && d0.activities[0] === '挑战：设计交通灯' && d0.equipment[0].preset === 3,
    JSON.stringify(d0));

  // 确认入库：活动去重（面包板/实验已存在）+ 新建「挑战」+ 课时挂到班级
  const actsBefore = studioLog.filter((l) => l.op === 'activity:save').length;
  elsMap['ss-target-class'].value = clsSmart.presetId;
  elsMap['ss-commit'].onclick();
  await new Promise((r) => setTimeout(r, 30));
  const newAct = studioLog.filter((l) => l.op === 'activity:save'
    && l.body.name === '挑战：设计交通灯');
  check('智能生成：新活动已创建（同名去重复用旧活动）', newAct.length === 1
    && studioLog.filter((l) => l.op === 'activity:save').length === actsBefore + 1,
    JSON.stringify(studioLog.filter((l) => l.op === 'activity:save').map((l) => l.body.name)));
  const smartSave = studioLog.filter((l) => l.op === 'class:save').pop();
  const mergedLesson = smartSave && smartSave.body.lessons.find((l) => l.name === '第1课 点亮LED（AI）');
  check('智能生成：课时挂到班级（activityIds+器材）', !!mergedLesson && mergedLesson.activityIds.length === 1
    && mergedLesson.equipment[0].eqId === 'LED' && mergedLesson.equipment[0].preset === 3,
    smartSave ? JSON.stringify(smartSave.body.lessons) : '无调用');
  check('智能生成：入库后草稿清空', global.PresetSmartStudio._drafts().length === 0);
  // 连贯化：入库后自动跳到班级页签并载入目标班级进入编辑态
  check('智能生成：入库后跳转班级页签', tabBtns[0].classList.contains('active')
    && tabBtns[1].classList.contains('active') === false);
  check('智能生成：入库后自动载入目标班级', elsMap['c-name'].value === '初二(9)班'
    && elsMap['c-name'].dataset.editId === clsSmart.presetId,
    JSON.stringify([elsMap['c-name'].value, elsMap['c-name'].dataset.editId]));

  // 适配层拒绝不支持的接口（无课堂接口可用）
  const j = await global.Editor.api('POST', '/api/v1/task', { title: 'x' });
  check('适配层拒绝课堂接口', j.code === 1, JSON.stringify(j));

  // OOBE 首次运行向导（6 步）：弹出 → 教师信息 → 建班 → 导入步骤 → 字典种子 → 完成写标记
  check('OOBE：meta 未标记时自动弹出', elsMap['overlay-oobe'].hidden === false
    && elsMap['ob-step-1'].hidden === false && elsMap['ob-dots'].innerHTML.includes('on'),
    'hidden=' + elsMap['overlay-oobe'].hidden);
  elsMap['ob-teacher-name'].value = '王老师';
  elsMap['ob-teacher-school'].value = '实验中学';
  await global.Oobe.next(); // 1→2（教师信息步骤，暂存填写值）
  await global.Oobe.next(); // 2→3：保存教师信息
  check('OOBE：教师信息写入 meta', metaStore.teacherInfo && metaStore.teacherInfo.name === '王老师'
    && metaStore.teacherInfo.school === '实验中学', JSON.stringify(metaStore.teacherInfo));
  elsMap['ob-class-name'].value = 'OOBE班';
  elsMap['ob-seats'].value = '48';
  await global.Oobe.next(); // 3→4：创建班级
  const oobeCls = studioLog.filter((l) => l.op === 'class:save').pop();
  check('OOBE：创建班级', !!oobeCls && oobeCls.body.name === 'OOBE班'
    && oobeCls.body.totalSeats === 48 && oobeCls.body.note === 'OOBE 创建', JSON.stringify(oobeCls && oobeCls.body));
  check('OOBE：进入导入步骤', elsMap['ob-step-import'].hidden === false && elsMap['ob-step-1'].hidden === true);
  await global.Oobe.next(); // 3→4：导入步骤无操作
  check('OOBE：进入字典种子步骤', elsMap['ob-step-3'].hidden === false);
  elsMap['ob-dict-seed'].checked = true;
  const dictBefore = studioLog.filter((l) => l.op === 'dict:save').length;
  await global.Oobe.next(); // 4→5：字典种子
  const dictAdds = studioLog.filter((l) => l.op === 'dict:save').length - dictBefore;
  check('OOBE：字典种子导入 6 条', dictAdds === 6
    && memory.dict.some((d) => d.eqId === 'LED'), String(dictAdds));
  await global.Oobe.next(); // 5→6：完成
  check('OOBE：完成写 meta 标记并关闭弹层', metaStore.oobeDone === true
    && elsMap['overlay-oobe'].hidden === true, 'oobeDone=' + metaStore.oobeDone);
  // 连贯化：OOBE 建班后自动落位到班级页签并载入该班
  const oobeClsSaved = (global.Editor.classes || []).find((c) => c.name === 'OOBE班');
  check('OOBE：完成后落位到新班级', tabBtns[0].classList.contains('active')
    && !!oobeClsSaved && elsMap['c-name'].value === 'OOBE班'
    && elsMap['c-name'].dataset.editId === oobeClsSaved.presetId,
    JSON.stringify([elsMap['c-name'].value, elsMap['c-name'].dataset.editId]));

  // OOBE 导入入口：点击隐藏向导并复用主导入流程（桩 pkgOpenFile 返回 null = 用户取消）
  elsMap['overlay-oobe'].hidden = false;
  elsMap['ob-import-pkg'].onclick();
  check('OOBE：导入入口复用主导入流程', elsMap['overlay-oobe'].hidden === true
    && typeof global.Editor.importPkg === 'function');

  // 器材编号 → 名称自动同步（草稿卡 data-d-eqid 行；字典命中才带出）
  memory.dict.push({ eqId: 'TEST-EQ', eqName: '测试器材甲', category: '元件' });
  await global.Editor.refreshPresets(); // 同步 Editor.dict 缓存（与真实使用一致）
  const eqNameEl = { value: '' };
  const synced = global.PresetClassUi.syncEqName({
    dataset: { dEqid: '' }, value: 'TEST-EQ',
    parentElement: { querySelector: () => eqNameEl },
  });
  check('器材编号：命中字典自动带出名称', synced === true && eqNameEl.value === '测试器材甲', eqNameEl.value);
  const notHit = global.PresetClassUi.syncEqName({
    dataset: { dEqid: '' }, value: 'NO-SUCH-EQ',
    parentElement: { querySelector: () => eqNameEl },
  });
  check('器材编号：未命中不动名称', notHit === false && eqNameEl.value === '测试器材甲');

  console.log('\nPreset Studio 渲染层验证：' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常:', e && e.stack || e);
  process.exit(1);
});
