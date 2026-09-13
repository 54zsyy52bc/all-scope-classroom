'use strict';
// =============================================================================
// S-3 回归防线：学生端关机「校验 + 执行」必须是主进程内的单一原子通道。
//
// 旧实现的缺陷（本测试锁死不再出现）：
//   1) preload 暴露 verify / execute 两个通道，渲染层是决策点 —— 渲染层完全可以
//      跳过 verify 直接调 execute，HMAC 校验形同虚设；
//   2) verify 与 execute 是两次 IPC 往返，中间存在 TOCTOU（60s 时间窗可能在两步
//      之间过期），也可能被"先校验后换票"。
//
// 测试分两部分：
//   A. IPC 面静态断言：只允许存在 shutdown:request，禁止 verify/execute 通道；
//   B. 渲染层行为：只发一次请求，且把主进程的判定结果如实反映到界面。
// =============================================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('-- S-3 关机原子化');

// ---------------------------------------------------------------------------
// A. IPC 面静态断言
// ---------------------------------------------------------------------------
const MAIN = read('main.js');
const PRELOAD = read('preload.js');

check('main.js 注册了 shutdown:request', /ipcMain\.handle\(\s*'shutdown:request'/.test(MAIN));
check('main.js 不再注册 shutdown:verify', !/ipcMain\.handle\(\s*'shutdown:verify'/.test(MAIN));
check('main.js 不再注册 shutdown:execute', !/ipcMain\.handle\(\s*'shutdown:execute'/.test(MAIN));
check('main.js 定义 requestShutdown（先校验后执行）', /function requestShutdown\(/.test(MAIN));
// 原子性核心：requestShutdown 内部必须先 verifyShutdownToken，且失败即 return
const rsBlock = MAIN.slice(MAIN.indexOf('function requestShutdown('), MAIN.indexOf('function isDryRun('));
check('requestShutdown 内部调用 verifyShutdownToken',
  /verifyShutdownToken\(ticket\)/.test(rsBlock));
check('校验失败时直接返回（不落到 executeShutdown）', (function () {
  // 按「位置序」断言原子性，而不是匹配花括号风格（单行 if 与多行块等价）：
  // 必须先调用 verifyShutdownToken → 出现 !v.verified 守卫并 return → 才轮到 executeShutdown
  const iVerify = rsBlock.indexOf('verifyShutdownToken(ticket)');
  const iGuard = rsBlock.indexOf('!v.verified');
  const iExec = rsBlock.indexOf('executeShutdown(');
  if (iVerify < 0 || iGuard < 0 || iExec < 0) return false;
  if (!(iVerify < iGuard && iGuard < iExec)) return false;
  return /if\s*\(!v\.verified\)[\s\S]*?\breturn\b/.test(rsBlock.slice(iVerify, iExec));
})());
check('requestShutdown 内部才调用 executeShutdown',
  /executeShutdown\(/.test(rsBlock));

check('preload 只暴露 shutdown:request 常量', /shutdown:\s*'shutdown:request'/.test(PRELOAD));
check('preload 不再有 verify 通道常量', !/verify:\s*'shutdown:verify'/.test(PRELOAD));
check('preload 不再有 execute 通道常量', !/execute:\s*'shutdown:execute'/.test(PRELOAD));
check('preload 暴露 requestShutdown', /requestShutdown:\s*\(ticket\)/.test(PRELOAD));
check('preload 不再暴露 verifyShutdown', !/verifyShutdown\s*:/.test(PRELOAD));
check('preload 不再暴露 executeShutdown', !/executeShutdown\s*:/.test(PRELOAD));

const DOWNLINK = read(path.join('renderer', 'downlink.js'));
check('渲染层改用 requestShutdown', /b\.requestShutdown\(/.test(DOWNLINK));
check('渲染层不再调用 verifyShutdown', !/b\.verifyShutdown\(/.test(DOWNLINK));
check('渲染层不再调用 executeShutdown', !/b\.executeShutdown\(/.test(DOWNLINK));

// ---------------------------------------------------------------------------
// B. 渲染层行为（加载真实 downlink.js，注入不同形态的桥接）
// ---------------------------------------------------------------------------
globalThis.window = globalThis;
(0, eval)(fs.readFileSync(path.join(ROOT, 'renderer', 'downlink.js'), 'utf8'));
const Downlink = globalThis.Downlink;

function makeCtx(bridgeImpl) {
  const toasts = [];
  const logs = [];
  const stages = [];
  const state = {
    phase: 'checkin', shutdownIn: null, shutdownDryRun: false,
    borrowed: [], returnChecked: {}, currentTask: null, taskStatus: null,
  };
  const c = {
    state,
    toast: (t, kind) => toasts.push({ text: t, kind }),
    renderStage: () => stages.push(state.phase),
    renderShutdown: () => {},
    bridge: () => bridgeImpl,
    log: (l) => logs.push(l),
    pad2: (n) => String(n).padStart(2, '0'),
    audit: () => {},
    resetEquipQty: () => {},
    onEquipment: () => {},
    onTimer: () => {},
    onPolicy: () => {},
  };
  const dl = Downlink.create(c);
  return { dl, state, toasts, logs };
}

function injectShutdown(dl, extra) {
  return dl.onCommand({ seat: '01', type: 'cmd', payload: Object.assign({ action: 'shutdown', sessionId: 'S-1', ts: Date.now(), token: 'T' }, extra || {}) });
}

(async () => {
  // B1. 桥接正常且校验通过 → 走倒计时，且只请求一次
  const calls = [];
  const b1 = {
    requestShutdown: (t) => { calls.push(t); return Promise.resolve({ verified: true, executed: true, dryRun: false, delaySec: 30 }); },
  };
  const x1 = makeCtx(b1);
  injectShutdown(x1.dl);
  await sleep(20);
  check('校验通过 → 只发出 1 次 requestShutdown', calls.length === 1, '实际 ' + calls.length);
  check('请求体带 sessionId/ts/token', calls[0] && calls[0].sessionId === 'S-1' && calls[0].token === 'T');
  check('校验通过 → 倒计时按主进程返回的 30 秒', x1.state.shutdownIn === 30, String(x1.state.shutdownIn));
  check('校验通过 → 非演练（dryRun=false）', x1.state.shutdownDryRun === false);
  check('校验通过 → 不弹错误 toast', x1.toasts.filter((t) => t.kind === 'error').length === 0);
  check('校验通过 → 记「已执行」日志', x1.logs.some((l) => l.indexOf('已执行') >= 0), x1.logs.join(' | '));

  // B2. 校验未通过 → 绝不起倒计时，且提示已忽略
  const b2 = { requestShutdown: () => Promise.resolve({ verified: false, reason: 'HMAC 签名不匹配' }) };
  const x2 = makeCtx(b2);
  injectShutdown(x2.dl);
  await sleep(20);
  check('校验未通过 → 不起倒计时', x2.state.shutdownIn === null, String(x2.state.shutdownIn));
  check('校验未通过 → 弹错误提示', x2.toasts.some((t) => t.kind === 'error' && t.text.indexOf('校验未通过') >= 0),
    JSON.stringify(x2.toasts));
  check('校验未通过 → 日志带具体原因', x2.logs.some((l) => l.indexOf('HMAC 签名不匹配') >= 0), x2.logs.join(' | '));

  // B3. 校验通过但系统层执行失败（shutdown 被策略拦截）→ 不得假装在倒计时
  const b3 = { requestShutdown: () => Promise.resolve({ verified: true, executed: false, dryRun: false, error: 'access denied' }) };
  const x3 = makeCtx(b3);
  injectShutdown(x3.dl);
  await sleep(20);
  check('执行失败 → 不起倒计时', x3.state.shutdownIn === null, String(x3.state.shutdownIn));
  check('执行失败 → 提示下发失败', x3.toasts.some((t) => t.kind === 'error' && t.text.indexOf('下发失败') >= 0),
    JSON.stringify(x3.toasts));

  // B4. 演练模式（dry-run，交付默认）→ 起倒计时且标记 dryRun
  const b4 = { requestShutdown: () => Promise.resolve({ verified: true, executed: false, dryRun: true, delaySec: 60 }) };
  const x4 = makeCtx(b4);
  injectShutdown(x4.dl);
  await sleep(20);
  check('演练模式 → 起倒计时 60 秒', x4.state.shutdownIn === 60, String(x4.state.shutdownIn));
  check('演练模式 → 标记 dryRun=true', x4.state.shutdownDryRun === true);
  check('演练模式 → 不报错', x4.toasts.filter((t) => t.kind === 'error').length === 0);

  // B5. 只有旧接口（verifyShutdown/executeShutdown）、没有 requestShutdown 的桥接
  //     → 必须落回「无桥接演练」分支，绝不能调旧的双通道（那正是 S-3 要消灭的路径）
  const legacyCalls = [];
  const b5 = {
    verifyShutdown: (t) => { legacyCalls.push('verify'); return Promise.resolve({ verified: true }); },
    executeShutdown: (o) => { legacyCalls.push('execute'); return Promise.resolve({ executed: true, delaySec: 60 }); },
  };
  const x5 = makeCtx(b5);
  injectShutdown(x5.dl);
  await sleep(20);
  check('旧双通道桥接 → 严格不调用 verifyShutdown', legacyCalls.indexOf('verify') < 0, legacyCalls.join(','));
  check('旧双通道桥接 → 严格不调用 executeShutdown', legacyCalls.indexOf('execute') < 0, legacyCalls.join(','));
  check('旧双通道桥接 → 落回演练倒计时', x5.state.shutdownIn !== null && x5.state.shutdownDryRun === true,
    x5.state.shutdownIn + '/' + x5.state.shutdownDryRun);

  // B6. 桥接抛异常 → 不能静默，必须有日志
  const b6 = { requestShutdown: () => Promise.reject(new Error('ipc broken')) };
  const x6 = makeCtx(b6);
  injectShutdown(x6.dl);
  await sleep(20);
  check('桥接异常 → 记异常日志', x6.logs.some((l) => l.indexOf('ipc broken') >= 0), x6.logs.join(' | '));
  check('桥接异常 → 不起倒计时', x6.state.shutdownIn === null, String(x6.state.shutdownIn));

  console.log('-- S-3 关机原子化 总结: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail === 0 ? 0 : 1);
})();