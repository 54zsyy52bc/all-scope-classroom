'use strict';
// =============================================================================
// 课堂页 boot 冒烟：把 index.html 的整条渲染层脚本链在严格 VM 里真跑一遍。
//
// 为什么必须存在：这类事故已经发生两次，静态断言全部漏过——
//   1) dbaf75b：renderStage 裸引用 global（渲染层没有 global）→ boot 抛 ReferenceError
//      → MQTT 永连不上，全班卡"等待老师开始上课"；
//   2) e9651f7：并行编辑竞争丢了 `let floatLink` 声明，wire() 里给未声明变量赋值
//      （'use strict' 下同样 ReferenceError）→ boot 中断 → 舞台不渲染，登记页消失。
// 静态 grep 只能查"某行存在"，查不出"引用了不存在的变量"。本测试直接执行：
// boot 跑通 + stage 真渲染出内容，才算数。
// =============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}

// 与 index.html 的脚本加载顺序一致（vendor/mqtt.min.js 除外——boot 有无 mqtt 守卫，顺带覆盖）
const SCRIPTS = [
  'shared/topics.js', 'shared/icons.js', 'renderer/equipment.js', 'renderer/net.js',
  'shared/tiles.js', 'renderer/views.js', 'renderer/downlink.js', 'renderer/actions.js',
  'renderer/control.js', 'renderer/fx.js', 'renderer/activity-panel.js',
  'renderer/float-link.js', 'renderer/app.js',
];

function makeEl(tag) {
  const cls = new Set();
  return {
    tagName: String(tag).toUpperCase(), children: [], dataset: {}, hidden: false,
    textContent: '', innerHTML: '', className: '', id: '', type: '', value: '',
    style: {}, _lis: {}, _attrs: {},
    classList: {
      add(c) { cls.add(c); }, remove(c) { cls.delete(c); }, contains(c) { return cls.has(c); },
      toggle(c, on) { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else if (on) cls.add(c); else cls.delete(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(k, fn) { (this._lis[k] = this._lis[k] || []).push(fn); },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    closest() { return null; }, focus() {}, querySelector() { return null; },
  };
}

// 执行整条脚本链；返回 { error, stage } —— error 非空即 boot 中断
function bootSmoke(appPatch) {
  const elsById = {};
  const doc = {
    readyState: 'complete',
    _lis: {},
    head: makeEl('head'), body: makeEl('body'),
    createElement: (t) => makeEl(t),
    getElementById(id) { if (!elsById[id]) elsById[id] = makeEl('div'); return elsById[id]; },
    addEventListener(k, fn) { (this._lis[k] = this._lis[k] || []).push(fn); },
    querySelector() { return null; },
  };
  const sandbox = {
    console, Date, Math, JSON, Promise,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    document: doc,
    localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); } },
    navigator: { userAgent: 'test' },
    EQUIPMENT: [],
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  let error = null;
  for (const rel of SCRIPTS) {
    let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (rel === 'renderer/app.js' && appPatch) src = appPatch(src);
    try {
      vm.runInContext(src, sandbox, { filename: rel });
    } catch (e) {
      error = { file: rel, message: (e && e.message) || String(e), stack: e && e.stack };
      break;
    }
  }
  return { error, stage: elsById.stage, doc, sandbox };
}

console.log('-- 课堂页 boot 冒烟 boot-smoke');
(async () => {
  const r = bootSmoke(null);
  check('K1 整条脚本链加载 + boot 无异常（含 FloatLink 接线）', r.error === null,
    r.error ? r.error.file + ': ' + r.error.message : '');
  check('K2 boot 后 stage 真渲染出待课页（不再是空舞台）',
    r.stage && r.stage.innerHTML.length > 20 && /等待老师开始上课|等老师开始上课/.test(r.stage.innerHTML),
    r.stage ? ('len=' + r.stage.innerHTML.length) : 'no stage');

  // 反向对照：删掉 floatLink 声明（复现 e9651f7 的丢行事故）。
  // 注意 boot() 是 async：wire() 里的同步 throw 会变成被吞的 Promise rejection，
  // 不会传到脚本加载处——所以还要监听 unhandledRejection + 断言 stage 保持空。
  let rejection = null;
  const onRej = (e) => { rejection = e; };
  process.on('unhandledRejection', onRej);
  const rb = bootSmoke((src) => src.replace('let floatLink = null;', '// let floatLink = null;'));
  await new Promise((res) => setTimeout(res, 30));
  process.off('unhandledRejection', onRej);
  const rejMsg = rejection ? String((rejection && rejection.message) || rejection) : '';
  check('K3 反向·声明丢失后 boot 在 wire() 中断（ReferenceError 或 stage 空 = 登记页消失复现）',
    /floatLink is not defined/.test(rejMsg) || (!rb.stage || rb.stage.innerHTML.length === 0),
    'rej=' + rejMsg + ' stageLen=' + (rb.stage ? rb.stage.innerHTML.length : 'none'));

  console.log('-- 课堂页 boot 冒烟 总结: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('[boot-smoke] 测试框架异常:', e); process.exit(1); });
