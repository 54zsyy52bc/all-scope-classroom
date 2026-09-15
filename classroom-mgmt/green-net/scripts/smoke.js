'use strict';
// =============================================================================
// 冒烟测试：真跑一次 Electron，验证「能起窗口 → 能建首个标签 → 屏蔽引擎生效」。
//
// 为什么必须有这一步：语法检查 / 单元测试都发现不了"主进程装配错误"这类问题
// （例如 WebContentsView 参数写错、协议未注册、preload 路径不对）。
// 只有真起一次 Electron 才能暴露。退出码 0 = 通过。
//
// 用法：node scripts/smoke.js
// =============================================================================
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const APP_ROOT = path.join(__dirname, '..');

function findElectron() {
  const cands = [
    process.env.ELECTRON_BIN,
    path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    path.join(APP_ROOT, '..', 'student', 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(APP_ROOT, '..', '..', 'classroom-mgmt', 'student', 'node_modules', 'electron', 'dist', 'electron.exe'),
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (_e) { /* next */ }
  }
  return null;
}

const bin = findElectron();
if (!bin) {
  // eslint-disable-next-line no-console
  console.error('✗ 找不到 Electron 可执行文件。请先在本目录执行 npm install，');
  // eslint-disable-next-line no-console
  console.error('  或设置环境变量 ELECTRON_BIN 指向 electron 可执行文件。');
  process.exit(2);
}

// eslint-disable-next-line no-console
console.log('使用 Electron：' + bin);

// ---------------------------------------------------------------------------
// 启动环境净化（踩坑记录，务必保留）
//
// 宿主（WorkBuddy CLI / 某些 IDE 终端 / CI 容器）会往子进程注入
//   ELECTRON_RUN_AS_NODE=1
//   NODE_OPTIONS=--require=".../node-language-shim.cjs"
// 一旦带着 ELECTRON_RUN_AS_NODE 启动，electron.exe 会「退化成纯 Node」：
//   1) process.versions.electron 仍在，但 Electron 内建模块不再注册；
//   2) Module.builtinModules 里不含 'electron'，require.resolve('electron')
//      会落到 node_modules/electron/index.js；
//   3) 那个 npm 包导出的是「electron.exe 的路径字符串」而不是 API 对象。
// 症状：主进程报 “Cannot read properties of undefined (reading 'app')”，
//       极易被误判成工程代码写错了。所以启动前必须剥掉。
// ---------------------------------------------------------------------------
function sanitizeEnv(base) {
  const env = Object.assign({}, base, { ELECTRON_ENABLE_LOGGING: '0' });
  delete env.ELECTRON_RUN_AS_NODE;
  // NODE_OPTIONS 里的 --require 垫片在 Electron 主进程里无意义且可能干扰
  if (env.NODE_OPTIONS) {
    delete env.NODE_OPTIONS;
  }
  return env;
}

const args = [APP_ROOT, '--smoke', '--no-kiosk'];
if (process.env.ELECTRON_RUN_AS_NODE || process.env.NODE_OPTIONS) {
  // eslint-disable-next-line no-console
  console.log('（已剥离注入的 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，避免 Electron 退化为纯 Node）');
}
const r = spawnSync(bin, args, {
  cwd: APP_ROOT,
  encoding: 'utf8',
  timeout: 60000,
  env: sanitizeEnv(process.env),
});

const out = String(r.stdout || '') + String(r.stderr || '');
const lines = out.split(/\r?\n/).filter((l) => l.includes('[smoke]') || l.includes('[boot]') || /error|Error/i.test(l));

// eslint-disable-next-line no-console
console.log('—— 运行输出 ——');
lines.slice(0, 40).forEach((l) => console.log(l));

const ok = r.status === 0
  && out.includes('[smoke] tabs=')
  && /\[smoke\] blocklist=.*"enabled":true/.test(out)
  && /\[smoke\] blocklist=.*"check":true/.test(out)
  // 新增断言（这类"静默失效"以前抓不到）：
  //   ① 渲染进程无未捕获错误 —— 挡住"协议层把 .js 回成 HTML"这类问题
  //   ② 首页真的渲染出内容 —— 端到端验证协议/脚本/preload/IPC 四环通畅
  && /\[smoke\] pageErrors=0\b/.test(out)
  && /\[smoke\] home-dom=\{[^}]*"groups":[1-9]/.test(out)
  && /\[smoke\] home-dom=\{[^}]*"cards":[1-9]/.test(out)
  && /\[smoke\] home-dom=\{[^}]*"quick":[1-9]/.test(out);

// eslint-disable-next-line no-console
console.log('—— 结论 ——');
if (ok) {
  // eslint-disable-next-line no-console
  console.log('✅ 冒烟通过：窗口建立、首个标签加载、屏蔽引擎拦截生效');
  process.exit(0);
}
// eslint-disable-next-line no-console
console.error('✗ 冒烟失败（退出码 ' + r.status + (r.error ? '，' + r.error.message : '') + '）');
if (r.error && r.error.code === 'ETIMEDOUT') {
  // eslint-disable-next-line no-console
  console.error('  提示：进程超时未退出，说明主进程可能卡在启动阶段（检查 index.js 的装配顺序）。');
}
process.exit(1);
