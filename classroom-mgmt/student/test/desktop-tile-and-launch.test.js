'use strict';
// =============================================================================
// 学生桌面·磁贴双面结构 + 应用启动链路 回归防线
//
// 背景（真因，2026-09-13 现场）：给磁贴加 Win8 翻转动效时引入双面 DOM
//   <button class="tile"><span class="tile-inner"><span class="tile-front">…
// 但 .tile-inner 只有 width:100%; min-height:132px，没有 display —— 它是 <span>，
// 行内元素上宽高不生效，实测塌成 0x0（Edge headless 量得 inner=0x0 / front=24x24 /
// ico=38x25 / nm=0x0），于是「图标被挤扁 + 应用名看不见」。
//
// 同一批排查还暴露启动链路两个静默失效：
//   1) desktop:set 写盘后不重装备守卫 -> allowMap/registry 仍是启动时的快照，
//      新添加的应用 launch() 直接 return false，点了毫无反应，悬浮坞进程状态也不更新；
//   2) launch() 静默 return false，渲染层拿不到原因，现场无法判断是没保存还是路径丢了。
//
// 本测试：
//   A. 行为级：在 vm 里真正执行 tileHtml，校验双面结构与名称非空
//   B. CSS 级：.tile-inner 规则必须显式声明非 inline 的 display（含反向对照）
//   C. 行为级：真加载 main-guard.js，launch 未知 id 必须回传 {ok:false,err}
//   D. 源码 tripwire：desktop:set / import-config 必须重装备守卫；bindLaunch 必须过滤噪声进程
// 仅内存改写源码，绝不写回仓库。
// =============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'desktop.html'), 'utf8');
const DESKTOP_JS = fs.readFileSync(path.join(ROOT, 'renderer', 'desktop.js'), 'utf8');
const DOCK_JS = fs.readFileSync(path.join(ROOT, 'renderer', 'app-dock.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}

// ---------------------------------------------------------------------------
// A. 行为级：真正执行 tileHtml（vm 沙箱 + 桩 DOM）
// ---------------------------------------------------------------------------
const HOOK = "\n  globalThis.__exposed = { tileHtml: tileHtml };\n";
function withHook(src) { return src.replace(/\n\}\)\(\);\s*$/m, HOOK + '})();\n'); }

function makeEl(id) {
  const el = {
    id, value: '', textContent: '', _html: '', hidden: true, checked: false,
    className: '', dataset: {}, style: {}, children: [],
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    remove() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = v; },
  });
  return el;
}

const BRIDGE = {
  getShellState: async () => ({ machineId: 'M-TEST', elevated: true }),
  getRuntime: async () => ({ siotIp: '127.0.0.1' }),
  getDesktopConfig: async () => ({ course: { id: 'c1', name: 'T', homeApps: [], apps: [] }, guard: {} }),
  getShellConfig: async () => ({ admin: { enabled: false } }),
  setDesktopConfig: async () => ({ ok: true }),
  launchApp: async () => ({ ok: true }),
  log() {}, verifyLocal: async () => ({ ok: true }),
  pickApp: async () => ({ canceled: true }), importConfig: async () => ({ canceled: true }),
  goShell() {}, openClass() {}, guardStart() {}, onKill() {},
  getAppsState: async () => ({ ok: true, apps: [] }), onApps() {}, onMinimize() {},
};

function tileOf(app) {
  const elCache = {};
  const documentStub = {
    readyState: 'complete', body: makeEl('body'),
    getElementById(id) { if (!elCache[id]) elCache[id] = makeEl(id); return elCache[id]; },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {}, removeEventListener() {},
  };
  const sandbox = {
    console, document: documentStub, setInterval: () => 0, setTimeout: () => 0,
    fetch: () => Promise.reject(new Error('no-net')), Promise,
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.classroom = BRIDGE;
  vm.createContext(sandbox);
  vm.runInContext(withHook(DESKTOP_JS), sandbox);
  return sandbox.__exposed.tileHtml(app, true);
}

// ---------------------------------------------------------------------------
// B. CSS 级：抽取 .tile-inner 规则块，校验 display
// ---------------------------------------------------------------------------
function ruleBlock(css, selector) {
  const re = new RegExp('(?:^|\\n)\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '\\s*\\{([^}]*)\\}');
  const m = re.exec(css);
  return m ? m[1] : null;
}
function displayValue(block) {
  if (!block) return null;
  const m = /display\s*:\s*([a-zA-Z-]+)/.exec(block);
  return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// E. 行为级：真加载 app-dock.js，点未注册应用必须提示且不抛异常
// ---------------------------------------------------------------------------
function loadDock(bridge) {
  const elCache = {};
  const documentStub = {
    readyState: 'complete', head: makeEl('head'), body: makeEl('body'),
    getElementById(id) { if (!elCache[id]) elCache[id] = makeEl(id); return elCache[id]; },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {}, removeEventListener() {},
  };
  const sandbox = {
    console, document: documentStub,
    setInterval: () => 0, clearInterval: () => {}, setTimeout, Promise,
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.classroom = bridge;
  vm.createContext(sandbox);
  const src = DOCK_JS.replace(/\n\}\)\(\);\s*$/m,
    "\n  globalThis.__exposed = { onRow: onRow };\n})();\n");
  vm.runInContext(src, sandbox);
  return { sandbox, doc: documentStub };
}

// ---------------------------------------------------------------------------
// C. 行为级：真加载 main-guard.js（拦截 electron 依赖，无副作用：不调 guard:start）
// ---------------------------------------------------------------------------
function loadGuard() {
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') {
      return { dialog: { showOpenDialog: async () => ({ canceled: true }) },
        app: { getAppPath: () => ROOT, setLoginItemSettings() {}, on() {} } };
    }
    return origLoad.apply(this, arguments);
  };
  let guard = null;
  try {
    const factory = require(path.join(ROOT, 'main-guard.js'));
    const handlers = {};
    guard = factory({
      app: { getAppPath: () => ROOT, setLoginItemSettings() {}, on() {} },
      ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
      readConfig: () => ({}),
      saveConfig: () => {},
    });
    guard.__handlers = handlers;
  } finally {
    Module._load = origLoad;
  }
  return guard;
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('-- 学生桌面·磁贴双面结构 + 启动链路回归');

  // --- A. 双面结构 ---
  const html = tileOf({ id: 'a1', name: '焊接Studio', path: 'C:\\w.exe' });
  check('A1 tileHtml 产出 .tile-inner 双面容器', /class="tile-inner"/.test(html));
  check('A2 正面 .tile-front 存在', /class="tile-front"/.test(html));
  check('A3 背面 .tile-back 存在', /class="tile-back"/.test(html));
  check('A4 正面含图标 .ico', /class="ico"/.test(html));
  check('A5 正面含应用名 .nm 且文本非空', /class="nm">焊接Studio<\/span>/.test(html), html.slice(0, 160));
  check('A6 图标取首字母（非空占位）', /class="ico">焊<\/span>/.test(html));
  check('A7 tile-inner 是 <span>（行内元素，故必须有 display 声明）',
    /<span class="tile-inner">/.test(html));
  check('A8 data-id 挂在 button 上（点击可拿到 id）',
    /<button[^>]*data-id="a1"/.test(html));

  // --- B. CSS：display 必须显式且非 inline ---
  const innerBlock = ruleBlock(HTML, '.tile-inner');
  check('B1 存在 .tile-inner 规则块', !!innerBlock);
  const disp = displayValue(innerBlock);
  check('B2 .tile-inner 显式声明 display（行内元素不声明会塌成 0x0）', disp !== null, 'display=' + disp);
  check('B3 display 值不是 inline', disp !== null && disp !== 'inline', 'display=' + disp);
  check('B4 .tile-inner 声明了 min-height（撑起双面层）', !!innerBlock && /min-height\s*:/.test(innerBlock));
  check('B5 .tile-inner 保持 preserve-3d', !!innerBlock && /transform-style\s*:\s*preserve-3d/.test(innerBlock));

  const faceBlock = ruleBlock(HTML, '.tile-front, .tile-back');
  check('B6 正反面 absolute + inset:0（贴满 tile-inner）',
    !!faceBlock && /position\s*:\s*absolute/.test(faceBlock) && /inset\s*:\s*0/.test(faceBlock));
  check('B7 正反面 backface-visibility:hidden（翻转不穿帮）',
    !!faceBlock && /backface-visibility\s*:\s*hidden/.test(faceBlock));
  check('B8 hover 时 inner 翻转 180deg',
    /\.tile:hover\s+\.tile-inner[^{]*\{[^}]*rotateY\(180deg\)/.test(HTML));

  // --- B 反向对照：去掉 display 声明后 B2/B3 必须翻转 ---
  const broken = HTML.replace(/(^|\n)(\s*)\.tile-inner \{ display:block;/, '$1$2.tile-inner {');
  const brokeOk = broken !== HTML;
  check('B9 反向·成功移除 .tile-inner 的 display:block', brokeOk);
  if (brokeOk) {
    const bDisp = displayValue(ruleBlock(broken, '.tile-inner'));
    check('B10 反向·去掉后 display 声明消失（塌成 0x0 的条件成立）', bDisp === null, 'display=' + bDisp);
    check('B11 反向特异性·固定版通过而破损版失败（证明不是橡皮图章）',
      disp !== null && disp !== 'inline' && bDisp === null);
  }

  // --- C. 行为级：launch 必须回传结构化失败原因 ---
  const guard = loadGuard();
  check('C1 main-guard 可加载且暴露 launch', guard && typeof guard.launch === 'function');
  const r = guard.launch('no-such-app');
  check('C2 launch 未知 id 返回对象而非裸 false', r && typeof r === 'object', JSON.stringify(r));
  check('C3 launch 未知 id ok===false', r && r.ok === false);
  check('C4 launch 未知 id 带 err 文案（渲染层可提示）', !!(r && r.err), r && r.err);
  check('C5 guard:app-focus 未知 id 也回传 err',
    (() => { const h = guard.__handlers['guard:app-focus']; if (!h) return false;
      const o = h(null, 'no-such-app'); return o && o.ok === false && !!o.err; })());

  // --- D. 源码 tripwire ---
  const MG = fs.readFileSync(path.join(ROOT, 'main-guard.js'), 'utf8');
  const GA = fs.readFileSync(path.join(ROOT, 'guard-apps.js'), 'utf8');
  const setIdx = MG.indexOf("ipcMain.handle('desktop:set'");
  const setBody = setIdx >= 0 ? MG.slice(setIdx, setIdx + 1400) : '';
  check('D1 desktop:set 写盘后重装备守卫 start(dRead())', /dWrite\(d\);\s*start\(dRead\(\)\)/.test(setBody));
  const impIdx = MG.indexOf("ipcMain.handle('desktop:import-config'");
  const impBody = impIdx >= 0 ? MG.slice(impIdx, impIdx + 900) : '';
  check('D2 desktop:import-config 导入后重装备守卫', /dWrite\(d\);\s*start\(dRead\(\)\)/.test(impBody));
  check('D3 tick 有启动宽限（新应用未进 allow 前不最小化）', /lastLaunchAt/.test(MG) && /LAUNCH_GRACE_MS/.test(MG));
  check('D4 bindLaunch 过滤系统噪声进程', /NOISE\.has\(x\)/.test(GA));
  check('D5 bindLaunch 排除已被别的应用认领的进程', /claimed\.has\(x\)/.test(GA));

  // --- E. 悬浮坞点击失败路径（防 ReferenceError 这类「点了没反应还报错」）---
  let dockErr = null;
  let dockCtx = null;
  try {
    dockCtx = loadDock({
      guardStart() {}, onApps() {}, onMinimize() {},
      getAppsState: async () => ({ ok: true, apps: [{ id: 'a1', name: 'X', running: false, procNames: [] }] }),
      launchApp: async () => ({ ok: false, err: '应用未注册（保存设置后即可打开）' }),
      focusApp: async () => ({ ok: true }),
    });
    await new Promise((r) => setTimeout(r, 20)); // 等 boot 里的 refresh() 落地
    await dockCtx.sandbox.__exposed.onRow('a1');
  } catch (e) { dockErr = e; }
  check('E1 悬浮坞 onRow 执行不抛异常（防调用本文件不存在的函数）', !dockErr, dockErr && dockErr.message);
  const toasts = dockCtx ? dockCtx.doc.body.children : [];
  check('E2 启动失败时浮层提示已插入 body', toasts.length >= 1, 'children=' + toasts.length);
  check('E3 提示文案含主进程回传的原因', toasts.some((c) => /应用未注册/.test(String(c.textContent))),
    toasts.map((c) => c.textContent).join('|'));
  const floatCalls = [...new Set((DOCK_JS.match(/\bfloat[A-Za-z]+\s*\(/g) || [])
    .map((s) => s.replace(/[\s(]+$/, '')))];
  check('E4 悬浮坞内 float* 调用均有本文件定义（静态兜底）',
    floatCalls.length > 0 && floatCalls.every((fn) => new RegExp('function\\s+' + fn + '\\s*\\(').test(DOCK_JS)),
    floatCalls.join(','));

  console.log('\n桌面磁贴+启动链路回归总结: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('验证脚本异常:', (e && e.stack) || e);
  process.exit(1);
});
