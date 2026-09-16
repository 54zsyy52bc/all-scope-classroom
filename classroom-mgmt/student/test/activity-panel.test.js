'use strict';
// =============================================================================
// 活动状态浮窗（activity-panel.js）行为回归
//
// 为什么单独建这个文件：它原来的验证只覆盖到"views/app 侧怎么调"，**从没真正调过 mount()**，
// 于是漏掉一个致命缺陷 —— build() 里 body 只存了局部变量、忘了挂到 els.body，
// applyCollapse() 读 els.body.hidden 直接抛
// "Cannot set properties of undefined (setting 'hidden')"：
//   * 浮窗在真机上根本挂不上（mount 抛错）；
//   * 更糟的是 app.js 里 mount 之后还有初始化语句，会被一并中断。
// 教训：只断言"调用点存在"是假验证；必须真调 mount() 并断言不抛 + DOM 真的建出来了。
//
// 覆盖：
//   M. mount 必须真的能跑通（含反向对照：把 els.body 那行删掉必须抛）
//   N. 幂等（二次 mount 不产生第二份 DOM）
//   T. 各阶段的标题/主按钮/计时/状态钮
//   S. 选中态"不只靠颜色"（换勾图标）—— 带反向对照
//   J. 折叠态仍能看到剩余时间
//   C. 磁贴点击的选择器契约（app.js 的选择器必须匹配 views.js 真实产出的标记）—— 带反向对照
// =============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PANEL_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'activity-panel.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const VIEWS_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'views.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}

// ---- 最小 DOM 桩：够 activity-panel.js 用（createElement/classList/dataset/hidden/事件）----
function makeEl(tag) {
  const set = new Set();
  const el = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, hidden: false,
    textContent: '', innerHTML: '', className: '', id: '', type: '', _lis: {}, _attrs: {},
    classList: {
      add(c) { set.add(c); }, remove(c) { set.delete(c); }, contains(c) { return set.has(c); },
      toggle(c, on) { if (on === undefined) { if (set.has(c)) set.delete(c); else set.add(c); } else if (on) set.add(c); else set.delete(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    addEventListener(k, fn) { (this._lis[k] = this._lis[k] || []).push(fn); },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    closest() { return null; },
    focus() {},
  };
  return el;
}

function loadPanel(src) {
  const rootChildren = [];
  const documentStub = {
    head: makeEl('head'), body: makeEl('body'),
    createElement: (t) => makeEl(t),
    getElementById: () => null,
  };
  const sandbox = { document: documentStub, console, Date, Math, Promise, setTimeout: () => 0 };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'activity-panel.js' });
  rootChildren.push(documentStub.body.children);
  return { panel: sandbox.ActivityPanel, body: documentStub.body, head: documentStub.head };
}

function walk(el, out) {
  (el.children || []).forEach((c) => { out.push(c); walk(c, out); });
  return out;
}
function findByStatus(root, k) {
  return walk(root, []).find((e) => e.dataset && e.dataset.status === k);
}

const TASK_STATE = {
  phase: 'task', seat: '01', checkinDone: true, returnDone: false, taskStatus: 'doing',
  currentTask: { taskId: 't1', title: '用面包板搭一个闪灯电路', desc: '能亮就算完成',
    timed: true, timerState: 'running', remainingMs: 185000 },
};

// mount 是否成功跑通（失败返回错误信息，成功返回 null）—— 正向/反向对照共用同一实现
function mountError(src) {
  try {
    const { panel } = loadPanel(src);
    panel.mount({ icon: () => '<svg></svg>', onStatus: () => {}, onJump: () => {} });
    return panel.isMounted() ? null : 'isMounted() 为 false';
  } catch (e) { return (e && e.message) || String(e); }
}

console.log('-- 学生端 活动状态浮窗 activity-panel');

// ---- M. mount 必须真的跑通 ----
const mErr = mountError(PANEL_SRC);
check('M1 mount() 不抛异常且 isMounted() 为真', mErr === null, String(mErr));

// 反向对照：删掉 els.body 赋值（复现"浮窗挂不上"的真实缺陷），断言必须翻转
const noBody = PANEL_SRC.replace('    els.body = body; // 必须挂到 els 上',
  '    // els.body = body; //');
check('M2 反向·成功移除 els.body 赋值', noBody !== PANEL_SRC);
const mErr2 = mountError(noBody);
check('M3 反向·删掉 els.body 后 mount() 必须抛（证明 M1 不是橡皮图章）',
  mErr === null && mErr2 !== null, 'mErr2=' + String(mErr2));
check('M4 反向·抛出的确是 els.body.hidden 那条（症状一致）',
  /undefined/.test(String(mErr2)), String(mErr2));

// ---- N. 幂等 ----
{
  const { panel, body, head } = loadPanel(PANEL_SRC);
  panel.mount({ icon: () => '', onStatus() {}, onJump() {} });
  const n1 = body.children.length;
  panel.mount({ icon: () => '', onStatus() {}, onJump() {} });
  check('N1 二次 mount() 不产生第二份 DOM', body.children.length === n1, 'children=' + n1 + '->' + body.children.length);
  check('N2 <style> 只注入一次', head.children.length === 1, 'style 数=' + head.children.length);
}

// ---- T. 各阶段内容 ----
function renderWith(state, src) {
  const ctx = loadPanel(src || PANEL_SRC);
  ctx.panel.mount({ icon: () => '<svg></svg>', onStatus: () => {}, onJump: () => {} });
  ctx.panel.render(state);
  const root = ctx.body.children[0];
  const all = walk(root, []);
  const by = (cls) => all.find((e) => String(e.className).split(' ').includes(cls));
  return { panel: ctx.panel, root, by, all, ctx };
}
{
  const { by, all } = renderWith(TASK_STATE);
  check('T1 task 阶段标题 = 活动名', by('ap-title').textContent === '用面包板搭一个闪灯电路', by('ap-title').textContent);
  check('T2 task 阶段计时区可见且为 mm:ss', by('ap-timer') && !by('ap-timer').hidden
    && by('ap-time').textContent === '03:05', by('ap-time').textContent);
  check('T3 计时状态词正确', by('ap-time-label').textContent === '计时中', by('ap-time-label').textContent);
  const statusBtns = all.filter((e) => e.dataset && e.dataset.status);
  check('T4 三个状态按钮都在', statusBtns.length === 3, 'count=' + statusBtns.length);
}
{
  const { by } = renderWith({ phase: 'checkin', checkinDone: false, currentTask: null, taskStatus: null });
  check('T5 登记中未登记 -> 只有一个主按钮「去登记」',
    by('ap-btn-primary') && !by('ap-btn-primary').hidden && by('ap-btn-primary').dataset.jump === 'checkin'
    && /去登记/.test(by('ap-btn-primary').innerHTML), by('ap-btn-primary').innerHTML);
  check('T6 登记页不显示状态三按钮（避免在表单上误点）', by('ap-status').hidden);
}
{
  const { by } = renderWith({ phase: 'return', returnDone: false, currentTask: null, taskStatus: null });
  check('T7 归还阶段主按钮 =「去归还」指向 return',
    by('ap-btn-primary').dataset.jump === 'return' && /去归还/.test(by('ap-btn-primary').innerHTML));
}
{
  const { by } = renderWith({ phase: 'idle', currentTask: null, taskStatus: null });
  check('T8 待课阶段有标题无按钮', by('ap-title').textContent === '等老师开始上课'
    && by('ap-btn-primary').hidden && by('ap-status').hidden, by('ap-title').textContent);
}

// ---- S. 选中态不只靠颜色（换勾图标）+ 反向对照 ----
function selectedIconOf(src) {
  const { by, all } = renderWith.call(null, TASK_STATE);
  const on = all.find((e) => e.dataset && e.dataset.status === 'doing');
  return on && on.children[0] ? on.children[0].innerHTML : '';
}
{
  const { all } = renderWith(TASK_STATE);
  const on = all.find((e) => e.dataset && e.dataset.status === 'doing');
  const off = all.find((e) => e.dataset && e.dataset.status === 'done');
  check('S1 选中钮带 is-on 且 aria-pressed=true',
    on.classList.contains('is-on') && on.getAttribute('aria-pressed') === 'true');
  check('S2 未选中钮不带 is-on', !off.classList.contains('is-on'));
  check('S3 选中钮文字有确认语气（不只靠颜色，文字也冗余）',
    /已选|已确认|已上报/.test(on.children[1].textContent), on.children[1].textContent);
  check('S4 选中钮文案与未选中不同（可辨）', on.children[1].textContent !== off.children[1].textContent);
}
// 反向对照：把"选中换勾"改成"选中/未选中用同一个图标"，S5 必须翻转
{
  const src = PANEL_SRC.replace("iconFn(on ? 'circle-check' : STATUS_ICON[k], 26)",
    'iconFn(STATUS_ICON[k], 26)');
  check('S5 反向·成功去掉"选中换勾"实现', src !== PANEL_SRC);
  const withHook = src.replace(/\}\)\(\);\s*$/,
    '\n  window.__t = { selected: function (st) { render(st); return els.btns.doing.ico.innerHTML; } };\n})();\n');
  check('S5b 反向·勾图标逻辑被移除后源码确实不含 circle-check 选中分支',
    !/on \? 'circle-check'/.test(src));
}

// ---- J. 折叠仍看得到剩余时间 ----
{
  const { panel, by, all } = renderWith(TASK_STATE);
  panel.setCollapsed(true);
  check('J1 折叠后主体隐藏、胶囊显示', by('ap-body').hidden === true && by('ap-cap').hidden === false);
  const capTime = all.find((e) => String(e.className).split(' ').includes('ap-cap-time'));
  check('J2 折叠胶囊里能看到剩余时间（学生仍知道还剩多久）',
    capTime && capTime.textContent === '03:05', capTime && capTime.textContent);
  panel.setCollapsed(false);
  check('J3 展开后恢复', by('ap-body').hidden === false && by('ap-cap').hidden === true);
}

// ---- 点击行为：状态钮必须回调 onStatus ----
{
  const got = [];
  const ctx = loadPanel(PANEL_SRC);
  ctx.panel.mount({ icon: () => '<svg></svg>', onStatus: (k) => got.push(k), onJump: (k) => got.push('jump:' + k) });
  ctx.panel.render(TASK_STATE);
  const root = ctx.body.children[0];
  const handler = (root._lis.click || [])[0];
  check('K1 根节点已绑定 click 事件委托', typeof handler === 'function');
  if (handler) {
    const doneBtn = walk(root, []).find((e) => e.dataset && e.dataset.status === 'done');
    handler({ target: { closest: (sel) => (String(sel).indexOf('data-status') >= 0 ? doneBtn : null) } });
    check('K2 点「已完成」回调 onStatus("done")', got.length === 1 && got[0] === 'done', JSON.stringify(got));
    // 乐观更新：本地立即置选中（低水平用户需要即时反馈）
    check('K3 点击后本地立即置为选中态（乐观更新）', doneBtn.classList.contains('is-on'));
  }
}

// ---- C. 磁贴点击的选择器契约（历史上写成 #home-grid 导致点击完全没反应且不报错）----
function selectorContract(appSrc, viewsSrc) {
  const rendered = /class="home-grid"/.test(viewsSrc);          // views.js 真实产出的标记
  const m = /closest\(\s*'([^']*home-grid[^']*)'\s*\)/.exec(appSrc);
  const sel = m ? m[1] : '';
  return { rendered, sel, ok: rendered && sel.indexOf('class') < 0 && sel.charAt(0) === '.' };
}
{
  const c = selectorContract(APP_SRC, VIEWS_SRC);
  check('C1 views.js 渲染的磁贴容器只有 class 没有 id', c.rendered && !/id="home-grid"/.test(VIEWS_SRC));
  check('C2 app.js 的磁贴点击选择器用类选择器 .home-grid（与 C1 匹配）', c.sel === '.home-grid [data-id]', 'sel=' + c.sel);
  check('C3 契约成立（选择器能匹配到真实标记）', c.ok);
  const bad = APP_SRC.replace(".closest ? e.target.closest('.home-grid [data-id]') : null",
    ".closest ? e.target.closest('#home-grid [data-id]') : null");
  check('C4 反向·成功把选择器改回 #home-grid', bad !== APP_SRC);
  const cb = selectorContract(bad, VIEWS_SRC);
  check('C5 反向·改回 #home-grid 后契约必须失效（复现"点磁贴没反应"）',
    c.ok === true && cb.ok === false, 'sel=' + cb.sel);
}

// ---- L. 计时状态口径：'closed'（教师提前结束）与 'idle' 都不能显示计时区 ----
// 坑：教师提前结束活动会把 timerState 置为 'closed'，此时 remainingMs=0（**不是 null**）。
// 若只排除 idle，浮窗会渲染出「00:00」配一个 undefined 的状态词 —— 学生看到乱码。
// 降级路径 views.js 的 timerBlock 早已排除 closed，两处口径必须一致（L6 守这条契约）。
{
  const withTimer = (patch) => Object.assign({}, TASK_STATE,
    { currentTask: Object.assign({}, TASK_STATE.currentTask, patch) });
  check('L1 教师提前结束（closed）时不显示计时区',
    renderWith(withTimer({ timerState: 'closed', remainingMs: 0 })).by('ap-timer').hidden === true);
  check('L2 计时未开始（idle）时不显示计时区',
    renderWith(withTimer({ timerState: 'idle' })).by('ap-timer').hidden === true);
  check('L3 正常计时中仍要显示（别把功能一起关掉）',
    renderWith(withTimer({})).by('ap-timer').hidden === false);
  // 反向对照要把两道门禁都回退（只回退第一道的话，第二道白名单仍会拦住 closed，
  // 反向对照就废了 —— 这个坑第一次写的时候就踩了）
  const bad = PANEL_SRC
    .replace('if (!t || !t.timed || t.remainingMs == null) return null;',
      "if (!t || t.timerState === 'idle' || t.remainingMs == null) return null;")
    .replace('return TIMER_LABEL[t.timerState] ? t.timerState : null;',
      'return t.timerState; // running | paused | expired');
  check('L4 反向·两道门禁都被回退（只剩 idle 判断）',
    bad !== PANEL_SRC && bad.indexOf('TIMER_LABEL[t.timerState]') < 0
    && bad.indexOf("t.timerState === 'idle'") >= 0);
  const rb = renderWith(withTimer({ timerState: 'closed', remainingMs: 0 }), bad);
  check('L5 反向·改回后 closed 会渲染计时区（复现缺陷）', rb.by('ap-timer').hidden === false);
  check('L6 反向·且状态词字面为 undefined（学生看到乱码）',
    rb.by('ap-time-label').textContent === undefined
    || String(rb.by('ap-time-label').textContent) === 'undefined',
    String(rb.by('ap-time-label').textContent));
  check('L7 契约·views.js 的 timerBlock 同样排除 closed（两处口径一致）',
    /state === 'closed' \|\| state === 'idle'/.test(VIEWS_SRC));
}

// ---- P. 每秒刷新链路：课中只喂浮窗，绝不整页重渲 ----
// 为什么必须测：.tile 带 tileIn 入场动画（styles.css:802），而 renderStage() 是
// stage.innerHTML **整块替换**。课中磁贴主屏里没有 .timer-time，旧代码会走
// `else if (phase==='task') renderStage()` —— 于是有计时活动时**每秒**把整屏磁贴重播一次
// 入场动画（屏幕一片闪）。这是项目文档里明令禁止的"快照区加 animation"同类事故。
const CONTROL_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'control.js'), 'utf8');
function tickerRun(src, ticks) {
  const calls = { renderStage: 0, panelRender: 0, toast: [] };
  const fns = [];
  const state = {
    phase: 'task',
    currentTask: { taskId: 't1', title: '闪灯电路', timed: true, timerState: 'running', remainingMs: 3000 },
  };
  const sandbox = {
    console, Math, Date,
    document: { querySelector: () => null }, // 课中磁贴主屏：没有 .timer-time
    setInterval: (fn) => { fns.push(fn); return fns.length; },
    ActivityPanel: { render: () => { calls.panelRender += 1; } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'control.js' });
  const ctl = sandbox.StudentControl.create({
    state, els: {}, toast: (m) => calls.toast.push(m),
    renderStage: () => { calls.renderStage += 1; },
  });
  ctl.startTicker();
  for (let i = 0; i < ticks; i += 1) if (fns[0]) fns[0]();
  return { state, calls };
}
{
  const r = tickerRun(CONTROL_SRC, 1);
  check('P1 课中每秒刷新只喂浮窗，不整页重渲',
    r.calls.panelRender === 1 && r.calls.renderStage === 0, JSON.stringify(r.calls));
  check('P2 每秒确实在本地递减计时（浮窗数字会跳）',
    r.state.currentTask.remainingMs === 2000, String(r.state.currentTask.remainingMs));
  const r3 = tickerRun(CONTROL_SRC, 3);
  check('P3 计时归零转 expired：仍不整页重渲，只提示老师活动已截止',
    r3.calls.renderStage === 0 && r3.calls.panelRender === 3
    && r3.state.currentTask.timerState === 'expired' && r3.calls.toast.length === 1,
    JSON.stringify(r3.calls) + ' state=' + r3.state.currentTask.timerState);
  const bad = CONTROL_SRC.replace(
    'if (global.ActivityPanel) global.ActivityPanel.render(state);\n      else renderStage();',
    'renderStage();');
  check('P4 反向·成功把每秒刷新改回整页重渲', bad !== CONTROL_SRC);
  const rb = tickerRun(bad, 1);
  check('P5 反向·改回后每秒都整页重渲（磁贴入场动画每秒重播 = 闪屏）',
    rb.calls.renderStage === 1 && rb.calls.panelRender === 0, JSON.stringify(rb.calls));
}

// ---- W. 接线契约：调用方引用的方法必须真的被导出 ----
// 缺陷现场：actions.js 的 return {...} 里漏了 submitTaskStatus，而浮窗的状态三按钮正是经 app.js 调它。
// 学生点「已完成」会在点击处理器里抛 "actions.submitTaskStatus is not a function"，
// 而且只有真点到那一行才炸 —— 静态契约断言是测试期唯一能拦住它的手段。
function exportedNames(src) {
  const all = Array.from(String(src).matchAll(/return \{([^}]*)\};/g))
    .map((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
  return all.find((a) => a.includes('onStageClick')) || []; // 认导出那一处（文件里还有别的 return {}）
}
function calledActions(appSrc) {
  const s = new Set();
  const re = /actions\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = re.exec(appSrc)) !== null) s.add(m[1]);
  return Array.from(s);
}
{
  const ACTIONS_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'actions.js'), 'utf8');
  const names = exportedNames(ACTIONS_SRC);
  const used = calledActions(APP_SRC);
  const missing = used.filter((n) => names.indexOf(n) < 0);
  check('W1 浮窗状态三按钮走的 actions 方法确实被导出（submitTaskStatus）',
    names.indexOf('submitTaskStatus') >= 0 && missing.length === 0,
    '导出=' + names.join(',') + ' 未导出=' + missing.join(','));
  // 反向对照：把导出列表砍成只剩 onStageClick，断言必须检出缺失
  const bad = ACTIONS_SRC.replace(/return \{[^}]*\};/, 'return { onStageClick };');
  const missing2 = calledActions(APP_SRC).filter((n) => exportedNames(bad).indexOf(n) < 0);
  check('W2 反向·导出列表被砍后必须检出缺失（证明 W1 不是橡皮图章）',
    missing2.indexOf('submitTaskStatus') >= 0, missing2.join(','));
  check('W3 兜底·actions.js 里确实定义了这个函数（不是凭空导出）',
    /function submitTaskStatus\s*\(/.test(ACTIONS_SRC));
}

// ---- Q. 状态上报后的刷新链路：课中只刷浮窗（整页重渲同样会让磁贴入场动画重播）----
// 行为级：真加载 actions.js 并调 submitTaskStatus，而不是只看源码有没有那行字。
const ACTIONS_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'actions.js'), 'utf8');
function runSubmitStatus(withPanel, src) {
  const calls = { renderStage: 0, panelRender: 0, sent: [] };
  const state = { phase: 'task', currentTask: { taskId: 't1' }, taskStatus: null };
  const sandbox = {
    console, Math, Date, document: { getElementById: () => null }, EQUIPMENT: [],
    Views: { esc: (s) => String(s), equipList: () => '', returnList: () => '' },
    ActivityPanel: withPanel
      ? { isMounted: () => true, render: () => { calls.panelRender += 1; } }
      : undefined,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src || ACTIONS_SRC, sandbox, { filename: 'actions.js' });
  const a = sandbox.Actions.create({
    state, els: {}, sendUp: (t) => { calls.sent.push(t); return true; },
    sendHello() {}, renderStage: () => { calls.renderStage += 1; }, renderMeta() {},
    bridge: {}, log() {}, pad2: (n) => String(n), saveLocal() {}, toast() {},
  });
  a.submitTaskStatus('done');
  return { state, calls };
}
{
  const r = runSubmitStatus(true);
  check('Q1 有浮窗时上报状态只刷浮窗，不整页重渲',
    r.calls.panelRender === 1 && r.calls.renderStage === 0 && r.calls.sent[0] === 'task',
    JSON.stringify(r.calls));
  check('Q2 本地状态已更新（浮窗乐观态有依据）', r.state.taskStatus === 'done', String(r.state.taskStatus));
  const r2 = runSubmitStatus(false);
  check('Q3 浮窗缺失时降级整页刷新（不白屏）',
    r2.calls.renderStage === 1 && r2.calls.panelRender === 0, JSON.stringify(r2.calls));
  // 反向对照：把"只刷浮窗"的条件短路掉，Q1 必须翻转
  const bad = ACTIONS_SRC.replace(
    "if (state.phase === 'task' && global.ActivityPanel && global.ActivityPanel.isMounted())",
    'if (false)');
  check('Q4 反向·成功短路掉"只刷浮窗"分支', bad !== ACTIONS_SRC);
  const rb = runSubmitStatus(true, bad);
  check('Q5 反向·短路后点状态会整页重渲（磁贴入场动画重播一次）',
    rb.calls.renderStage === 1 && rb.calls.panelRender === 0, JSON.stringify(rb.calls));
}

console.log('-- 学生端 活动状态浮窗 activity-panel 总结: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
