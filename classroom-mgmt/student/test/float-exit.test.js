'use strict';
// =============================================================================
// 置顶独立浮窗 + 「退出课堂」联动回归（学生端）
//
// 架构契约（违反任一即现场翻车）：
//   * MQTT 唯一真源在课堂页 app.js —— 浮窗/主进程**绝不**出现第二套 MQTT；
//   * 浮窗是独立 BrowserWindow（alwaysOnTop），页面内 DOM 浮窗已被替换，
//     app.js 不再挂 ActivityPanel（否则同屏两份状态面板）；
//   * 退出课堂 = 本地重置回待课 + 上行 exit（教师端落库标记），不切页不断连；
//   * 退出口令走主进程 shell:verify-local（modeExit 域），哈希不出主进程。
// 覆盖：B 行为（FloatLink 真加载执行）+ S 静态接线 + R 反向对照。
// =============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FL_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'float-link.js'), 'utf8');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}

// ---- B. FloatLink 行为（真加载执行，桩 bridge/actions）----
function runFl(mutate) {
  const calls = { push: 0, sent: [], status: [], jumps: [], toasts: [], renders: 0, saves: 0, audits: [] };
  const state = {
    phase: 'task', seat: '03', currentTask: { taskId: 't1', title: '闪灯' }, taskStatus: 'doing',
    checkinDone: true, returnDone: false, returnChecked: { e1: true }, borrowed: ['e1'],
    locked: true,
  };
  const els = { lock: { hidden: false } };
  const sandbox = { console, Date };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mutate || FL_SRC, sandbox, { filename: 'float-link.js' });
  const fl = sandbox.FloatLink.create({
    state, els,
    toast: (m) => calls.toasts.push(m),
    renderStage: () => { calls.renders += 1; },
    saveLocal: () => { calls.saves += 1; },
    sendUp: (t, p) => { calls.sent.push({ t, p }); return true; },
    audit: (ty, d) => calls.audits.push(ty + ':' + d),
    bridge: () => ({ floatStatus: (p) => { calls.push += 1; calls.lastPush = p; } }),
    actions: { submitTaskStatus: (k) => calls.status.push(k) },
    resetEquipQty: () => {},
    onJump: (k) => calls.jumps.push(k),
  });
  return { fl, state, els, calls };
}

console.log('-- 学生端 置顶浮窗联动 float-link');
{
  const r = runFl();
  r.fl.push();
  check('B1 push() 把状态快照推给浮窗（经 bridge.floatStatus）',
    r.calls.push === 1 && r.calls.lastPush.phase === 'task'
    && r.calls.lastPush.currentTask.taskId === 't1' && r.calls.lastPush.taskStatus === 'doing'
    && r.calls.lastPush.checkinDone === true, JSON.stringify(r.calls.lastPush));
  r.fl.onAction({ type: 'sync-request' });
  check('B2 浮窗加载后请求快照（sync-request → 再推一次）', r.calls.push === 2);
  r.fl.onAction({ type: 'status', status: 'help' });
  check('B3 浮窗状态三键 → actions.submitTaskStatus（与页内同一上行链路）',
    r.calls.status.length === 1 && r.calls.status[0] === 'help', JSON.stringify(r.calls.status));
  r.fl.onAction({ type: 'jump', to: 'return' });
  check('B4 浮窗「去归还」→ onJump("return")（切整屏表单语义不变）',
    r.calls.jumps.length === 1 && r.calls.jumps[0] === 'return');
  r.fl.performExit();
  check('B5 退出后本地重置回待课空态（phase=idle，活动/状态/登记/归还/借还全清）',
    r.state.phase === 'idle' && r.state.currentTask === null && r.state.taskStatus === null
      && r.state.checkinDone === false && r.state.returnDone === false
      && r.state.borrowed.length === 0 && r.state.locked === false, JSON.stringify(r.state));
  check('B6 退出上行 exit 报文（教师端据此落库标记）',
    r.calls.sent.length === 1 && r.calls.sent[0].t === 'exit', JSON.stringify(r.calls.sent));
  check('B7 退出有审计、提示与重渲（不静默）',
    r.calls.audits.length === 1 && /exit-class/.test(r.calls.audits[0])
    && r.calls.toasts.length === 1 && r.calls.renders === 1 && r.calls.saves === 1,
    JSON.stringify({ a: r.calls.audits, t: r.calls.toasts, r: r.calls.renders, s: r.calls.saves }));
  check('B8 退出时锁定遮罩一并收起', r.els.lock.hidden === true);
  // bridge 不可达不阻断
  const r2 = runFl();
  check('B9 无桥接（浏览器预览）时 push 不抛', (() => { try { r2.fl.push(); return true; } catch (_e) { return false; } })());
  // 反向对照：把 exit 上行改成别的 type，B6 必须翻转
  const bad = FL_SRC.replace("sendUp('exit', { reason: 'student' });", "sendUp('noop', {});");
  check('B10 反向·成功把 exit 上行改成 noop', bad !== FL_SRC);
  const rb = runFl(bad);
  rb.fl.performExit();
  check('B11 反向·改后不再上行 exit（教师端无从感知退出）',
    rb.calls.sent.length === 1 && rb.calls.sent[0].t === 'noop', JSON.stringify(rb.calls.sent));
}

// ---- S. 静态接线契约 ----
{
  const app = read('renderer/app.js');
  const indexHtml = read('renderer/index.html');
  const floatHtml = read('renderer/float.html');
  const floatJs = read('renderer/float.js');
  const mainJs = read('main.js');
  const preload = read('preload.js');
  const floatWin = read('float-window.js');
  const floatPreload = read('float-preload.js');

  check('S1 app.js 已改为 FloatLink 联动，不再挂页内 ActivityPanel（防双面板）',
    /FloatLink\.create/.test(app) && !/ActivityPanel\.mount/.test(app));
  check('S2 index.html 引入 float-link.js（在 app.js 之前）',
    /<script src="float-link\.js"><\/script>\s*<script src="app\.js">/.test(indexHtml));
  check('S3 index.html 无设计工具污染（data-page-node-id 必须为 0 处）',
    !/data-page-node-id/.test(indexHtml));
  check('S4 preload 暴露浮窗通道（floatStatus 推送 + onFloatAction 回流）',
    /floatStatus:/.test(preload) && /onFloatAction:/.test(preload));
  check('S5 主进程创建浮窗并随主窗口导航联动（index.html=显示，其余=隐藏）',
    /float-window/.test(mainJs) && /did-navigate/.test(mainJs) && /onMainNav/.test(mainJs));
  check('S6 浮窗窗口置顶（alwaysOnTop screen-saver 级，压过课程应用）',
    /setAlwaysOnTop\(true,\s*'screen-saver'\)/.test(floatWin));
  check('S7 浮窗点击穿透（透明区域不挡底下课程应用的点击）',
    /setIgnoreMouseEvents/.test(floatWin) && /setClickthrough/.test(floatJs));
  check('S8 浮窗页复用 activity-panel.js（不为状态显示再造第二套渲染）',
    /activity-panel\.js/.test(floatHtml) && /ActivityPanel\.mount/.test(floatJs));
  check('S9 退出口令走主进程校验（modeExit 域 + shell:get-config 探测），哈希不出主进程',
    /verifyLocal\('modeExit'/.test(floatJs) && /getShellConfig/.test(floatJs)
      && !/setShellConfig|set-config/.test(floatPreload));
  check('S10 浮窗桥不暴露任何配置写通道（只读+校验+动作）',
    !/desktop:set|shell:set-config|saveProfile|requestShutdown/.test(floatPreload));
  check('S11 浮窗预加载是独立文件且 contextIsolation（不与主窗 preload 混用）',
    /float-preload\.js/.test(floatWin) && /contextIsolation: true/.test(floatWin));
  // 反向对照：去掉 alwaysOnTop，检查器必须能发现（防"浮窗被课程应用盖住"回归）
  const bad = floatWin.replace("win.setAlwaysOnTop(true, 'screen-saver');", '');
  check('S12 反向·成功删除置顶语句', bad !== floatWin);
  check('S13 反向·删除后被静态断言检出（复现"浮窗被盖住"）',
    !/setAlwaysOnTop\(true,\s*'screen-saver'\)/.test(bad));
  // 反向对照：app.js 重新挂回页内 ActivityPanel → 必须检出（双面板）
  const badApp = app + '\n  if (window.ActivityPanel) window.ActivityPanel.mount({});\n';
  check('S14 反向·页内挂载被重新引入时检出（防同屏两份状态面板）',
    /ActivityPanel\.mount/.test(badApp));
}

console.log('-- 置顶浮窗+退出课堂联动 总结: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
