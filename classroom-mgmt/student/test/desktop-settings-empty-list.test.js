'use strict';
// =============================================================================
// 设置弹窗·空课程应用列表回归防线
//
// 背景（真因）：openSettings -> renderAppList 在「课程应用列表为空」时，
// 把 #app-list 渲染成占位行 '<div class="row">暂无应用</div>'，
// 随后 box.querySelectorAll('.row').forEach 对它执行
//   row.querySelector('[data-f="name"]').oninput = ...
// 占位行没有 [data-f="name"] 输入框 -> null.oninput 抛 TypeError，
// 且该崩溃发生在 `$('set-overlay').hidden = false`（显示弹窗）之前，
// 于是「点设置/课程应用管理打不开」。新装机必然是空列表 -> 必现。
//
// 之前 settings-gate.test.js 只断言 openSettings/askPwd 含 floatToast 文案，
// 并不真正执行 renderAppList，因此漏掉了这个运行时崩溃。
//
// 本测试：在 vm 沙箱里用「能复现占位行的桩 DOM」真正执行 openSettings，
//   1) 固定版（已带守卫）：不抛异常且 set-overlay 最终 hidden===false
//   2) 反向对照：在内存中去掉守卫 -> 空列表下必抛 null.oninput
//      以此证明断言不是橡皮图章（去掉修复后必须翻转成失败）。
// 仅内存改写源码，绝不写回仓库。
// =============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'renderer', 'desktop.js');
const BASE = fs.readFileSync(SRC_PATH, 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}

// 在 IIFE 末尾暴露内部 openSettings（仅内存改写，不写盘）
const HOOK = "\n  globalThis.__exposed = { openSettings: openSettings };\n";
function withHook(src) {
  return src.replace(/\n\}\)\(\);\s*$/m, HOOK + '})();\n');
}

// 把 #app-list 的 innerHTML 解析成「行桩」：占位行没有 [data-f="name"] 输入框
function parseRows(html) {
  const re = /<div class="row"[^>]*>([\s\S]*?)<\/div>/g;
  const rows = [];
  let m;
  while ((m = re.exec(html))) {
    const inner = m[1];
    rows.push({
      querySelector(sel) {
        if (sel === '[data-f="name"]') return inner.includes('data-f="name"') ? { oninput: null } : null;
        if (sel === '[data-a="pin"]') return inner.includes('data-a="pin"') ? { onclick: null } : null;
        if (sel === '[data-a="del"]') return inner.includes('data-a="del"') ? { onclick: null } : null;
        return null;
      },
    });
  }
  return rows;
}

function makeEl(id) {
  const el = {
    id, value: '', textContent: '', _html: '', hidden: true, checked: false,
    className: '', dataset: {}, style: {},
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {}, focus() {},
    querySelector() { return null; },
    querySelectorAll(sel) { return sel === '.row' ? parseRows(this._html) : []; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = v; },
  });
  return el;
}

// 在独立 vm 上下文真正执行 desktop.js 并调用 openSettings（async，直接 await 结果）
async function runScenario(src, bridge) {
  const elCache = {};
  const documentStub = {
    readyState: 'complete',
    body: makeEl('body'),
    getElementById(id) { if (!elCache[id]) elCache[id] = makeEl(id); return elCache[id]; },
    createElement(tag) { return makeEl(tag); },
    addEventListener() {}, removeEventListener() {},
  };
  const sandbox = {
    console,
    document: documentStub,
    setInterval: () => 0,
    setTimeout: () => 0,
    fetch: () => Promise.reject(new Error('no-net')),
    Promise,
  };
  sandbox.window = sandbox;       // b() === window.classroom || null
  sandbox.globalThis = sandbox;
  sandbox.classroom = bridge;     // null = 新装机无桥接（口令闸门 fail-open 跳过）
  vm.createContext(sandbox);
  vm.runInContext(withHook(src), sandbox);

  const out = { threw: false, err: null, overlayHidden: true };
  try {
    const exposed = sandbox.__exposed;
    if (!exposed || typeof exposed.openSettings !== 'function') {
      out.threw = true; out.err = new Error('openSettings 未暴露（hook 注入失败）');
    } else {
      await exposed.openSettings();   // 真正执行到 set-overlay.hidden = false
    }
  } catch (e) {
    out.threw = true; out.err = e;
  }
  out.overlayHidden = documentStub.getElementById('set-overlay').hidden;
  return out;
}

// 反向对照：去掉「占位行守卫」两行，还原成崩溃版
const FIX = "      const nameEl = row.querySelector('[data-f=\"name\"]');\r\n"
  + "      if (!nameEl) return; // 暂无应用占位行无输入框，跳过绑定，否则 null.oninput 抛错会阻断设置弹窗显示\r\n"
  + "      const i = Number(row.dataset.i);\r\n"
  + "      nameEl.oninput = (e) => { draft.course.apps[i].name = e.target.value; };";
const BUG = "      const i = Number(row.dataset.i);\r\n"
  + "      row.querySelector('[data-f=\"name\"]').oninput = (e) => { draft.course.apps[i].name = e.target.value; };";

async function main() {
  console.log('-- 设置弹窗·空课程应用列表回归');

  // (0) 源码自身必须含修复（守卫在），否则这道回归防线本身就被撤掉了
  check('源码含占位行空值守卫 if (!nameEl) return', BASE.indexOf('if (!nameEl) return') >= 0);

  // (1) 固定版 + 新装机路径（b() 返回 null，口令闸门 fail-open 跳过）
  const fixedNull = await runScenario(BASE, null);
  check('固定版(无桥接/新装机) openSettings 空列表下不抛异常', !fixedNull.threw, fixedNull.err && fixedNull.err.message);
  check('固定版(无桥接/新装机) 设置弹窗已显示 (set-overlay.hidden===false)', fixedNull.overlayHidden === false);

  // (2) 固定版 + 桥接路径（getShellConfig 返回 admin.enabled=false）
  const fixedBridge = await runScenario(BASE, { getShellConfig: async () => ({ admin: { enabled: false } }) });
  check('固定版(桥接 admin.enabled=false) openSettings 空列表下不抛异常', !fixedBridge.threw, fixedBridge.err && fixedBridge.err.message);
  check('固定版(桥接) 设置弹窗已显示', fixedBridge.overlayHidden === false);

  // (3) 反向对照：去掉修复后，空列表必抛 null.oninput
  const buggy = BASE.replace(FIX, BUG);
  const removed = buggy !== BASE;
  check('反向·成功移除占位行守卫（FIX 片段在源码中存在）', removed);
  if (removed) {
    const r = await runScenario(buggy, null);
    check('反向·去掉修复后 openSettings 在空列表下抛异常', r.threw === true, r.err && r.err.message);
    check('反向特异性·固定版通过而 buggy 失败（证明不是橡皮图章）',
      !fixedNull.threw && r.threw === true);
  }

  console.log('\n设置弹窗-空列表回归总结: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('验证脚本异常:', e && e.stack || e);
  process.exit(1);
});
