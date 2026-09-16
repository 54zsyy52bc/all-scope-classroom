'use strict';
// =============================================================================
// 守卫启动链路·真机级验证（真 main-guard + 真 guard-win + 真 powershell 子进程）
//
// 背景（真因，2026-09-16）：start() 的外层门禁写成 `hasApps || denyList.length`，
// 而母盘是 course.apps:[] + guard.enabled:true + denyExe:[]——denyList 仅当
// guard.enabled 为真时才填，denyExe 为空即 denyList 为空，于是两个条件皆假、
// 整段被跳过：guard-window.ps1 助手不启动、tick 定时器不建立，
// 「非课堂窗口自动最小化」在母盘默认态下完全失效，且现场无任何异常可看。
// 单元测试用桩替换 guard-win 只能验"调没调 start()"，验不到"子进程真的起来、
// sweep 真的发得出去"。故本用例跑真实链路。
//
// 安全约定：绝不执行仓库里的 guard-window.ps1（那会最小化用户当前所有窗口）。
// 改为在临时目录放一个只回显指令、不做任何窗口操作的桩脚本，并靠 __dirname
// 注入让 GUARD_PS 指向桩（见 loadGuardFrom）。
// 非 Windows 或 powershell 不可用 → SKIP（退出码 0）。
// =============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STUB_DIR = path.join(os.tmpdir(), 'qy-guard-stub-' + process.pid);
const STUB_PS = path.join(STUB_DIR, 'guard-window.ps1');
const STUB_SRC = '# 无害桩：只回显指令，不碰任何窗口\n'
  + "$ErrorActionPreference = 'SilentlyContinue'\n"
  + 'while ($true) {\n'
  + '  $line = [Console]::In.ReadLine()\n'
  + '  if ($null -eq $line) { break }\n'
  + "  if ($line -eq 'Q') { break }\n"
  + "  $esc = $line.Replace('\\', '\\\\').Replace('\"', '\\\"')\n"
  + '  [Console]::Out.WriteLine(\'{"stub":true,"got":"\' + $esc + \'","minimized":0}\')\n'
  + '  [Console]::Out.Flush()\n'
  + '}\n';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}

if (process.platform !== 'win32') {
  console.log('[SKIP] 非 Windows，跳过守卫启动链路真机验证');
  process.exit(0);
}

console.log('-- 学生端 守卫启动链路 guard-startup-integration');

// ---- 安全前置：桩目录绝不能是仓库/交付包目录，且其中的 guard-window.ps1 必须是桩 ----
fs.rmSync(STUB_DIR, { recursive: true, force: true });
fs.mkdirSync(STUB_DIR, { recursive: true });
fs.writeFileSync(STUB_PS, STUB_SRC, 'utf8');
check('S1 桩脚本落在临时目录（不覆盖仓库真实脚本）',
  path.resolve(STUB_DIR) !== path.resolve(ROOT) && fs.readFileSync(STUB_PS, 'utf8') === STUB_SRC);
check('S2 桩脚本不含真实最小化调用（ShowWindow/MinimizeAll 等）',
  !/ShowWindow|MinimizeAll|EnumWindows/i.test(STUB_SRC));

const MG_SRC = fs.readFileSync(path.join(ROOT, 'main-guard.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 真 main-guard.js + 真 guard-win.js + 真 guard-apps.js；仅 __dirname 指向桩目录
function loadGuardFrom(src) {
  const reports = [];
  const moduleObj = { exports: {} };
  const realGuardWin = require(path.join(ROOT, 'guard-win.js'));
  const wrapGuardWin = (opts) => realGuardWin(Object.assign({}, opts, {
    onReport: (o) => { reports.push(o); if (opts && opts.onReport) opts.onReport(o); },
  }));
  const fakeRequire = (req) => {
    if (req === 'electron') {
      return { dialog: { showOpenDialog: async () => ({ canceled: true }), showErrorBox() {} },
        app: { getAppPath: () => ROOT, setLoginItemSettings() {}, on() {} } };
    }
    if (req === './guard-win') return wrapGuardWin;
    if (req === './guard-apps') return require(path.join(ROOT, 'guard-apps.js'));
    return require(req);
  };
  const wrapper = vm.runInThisContext(
    '(function (require, module, exports, __dirname, __filename) {' + src + '\n})',
    { filename: path.join(STUB_DIR, 'main-guard.js') });
  wrapper(fakeRequire, moduleObj, moduleObj.exports, STUB_DIR, path.join(STUB_DIR, 'main-guard.js'));
  const obj = moduleObj.exports({ app: { getAppPath: () => ROOT, setLoginItemSettings() {}, on() {} },
    ipcMain: { handle() {} }, readConfig: () => ({}), saveConfig: () => {} });
  return { obj, reports };
}

// 母盘出厂态：无课程应用、强杀未启用（denyExe 空）、开了非课堂窗口最小化
const MD_EMPTY = { course: { id: 'c1', name: 'T', homeApps: [], apps: [] },
  guard: { enabled: true, denyExe: [], minimizeOthers: true } };

async function boot(src, desktop) {
  const { obj, reports } = loadGuardFrom(src);
  obj.start(desktop);
  const deadline = Date.now() + 12000; // 等 powershell 冷启动 + 首轮 tick
  while (Date.now() < deadline && !reports.some((r) => r && /^S\|/.test(String(r.got)))) {
    await sleep(200);
  }
  const alive = obj.winGuard.isAlive();
  const sweeps = reports.filter((r) => r && /^S\|/.test(String(r.got))).map((r) => String(r.got));
  obj.stop();
  await sleep(120);
  return { alive, sweeps, all: reports };
}

(async () => {
  const fixed = await boot(MG_SRC, MD_EMPTY);
  check('G1 母盘态下 PowerShell 助手进程真的起来了', fixed.alive);
  check('G2 母盘态下 sweep 指令真的发得出去（不是静默丢弃）', fixed.sweeps.length > 0,
    'reports=' + fixed.all.length);
  const s0 = fixed.sweeps[0] ? fixed.sweeps[0].trim() : '';
  const f = s0.split('|');
  check('G3 sweep 协议格式 S|<allowCsv>|<主进程pid>|<dry>', /^S\|/.test(s0) && f.length === 4, s0);
  check('G4 sweep 带主进程 pid（助手据此跳过自己，防自我最小化）', f[2] === String(process.pid),
    'pid=' + f[2]);
  check('G5 sweep dry 位为 0（真执行最小化而非演练）', f[3] === '0', s0);
  check('G6 allow 列表含自身可执行文件名（kiosk 不能被自己最小化）',
    String(f[1]).toLowerCase() === path.basename(process.execPath).toLowerCase(), 'allow=' + f[1]);

  // 反向对照：把门禁改回旧写法，同一场景下助手不应启动、也不应有 sweep
  const oldSrc = MG_SRC.replace('if (hasApps || denyList.length || minimizeOthers) {',
    'if (hasApps || denyList.length) {');
  check('反向·成功把门禁改回旧写法', oldSrc !== MG_SRC);
  const old = await boot(oldSrc, MD_EMPTY);
  check('G7 反向·旧门禁下母盘态助手不启动（复现本次缺陷）', !old.alive && old.sweeps.length === 0,
    'alive=' + old.alive + ' sweeps=' + old.sweeps.length);
  check('G8 反向特异性·同一场景固定版通过而旧版失败',
    fixed.sweeps.length > 0 && old.sweeps.length === 0);

  try { fs.rmSync(STUB_DIR, { recursive: true, force: true }); } catch (_e) { /* noop */ }
  console.log('-- 学生端 守卫启动链路 guard-startup-integration 总结: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('验证脚本异常:', (e && e.stack) || e);
  process.exit(1);
});
