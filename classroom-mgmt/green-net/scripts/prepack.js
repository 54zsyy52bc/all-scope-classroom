'use strict';
// =============================================================================
// 打包前置处理：让产物回到「出厂未初始化」状态
//
// 为什么需要它：
//   app-config.json 在开发机上跑过之后，会被 ensureMachineId() 写入这台机器的
//   machineId（形如 M-d0d44063）。打包只是复制文件，于是**每台学生机都带着同一个
//   machineId**。而 machineId 直接决定 MQTT clientId（RNET_<machineId>），
//   同 clientId 连同一个 broker 会互相踢下线 —— 机房里装了 N 台，只有最后一台能收到指令。
//   这个故障在现场表现为「装第一台好使，装完全都不好使」，极难当场定位。
//
// 做法：
//   打包期间把 machineId 临时清空（每台机器首次启动时用 deriveMachineId() 按
//   主机名 + MAC + CPU + 架构 自行派生唯一值），打包结束后**无论成败都恢复工程文件**。
//   同时清掉运行期残留（audit.log / admin.json），避免把开发机的口令哈希打进包里。
//
// 用法：node scripts/prepack.js [electron-builder 的参数...]
//   npm run pack  → node scripts/prepack.js --win dir
//   npm run dist  → node scripts/prepack.js --win nsis
//   node scripts/prepack.js --verify-only   只校验已有 dist 产物，不重新打包（离线可用）
// =============================================================================
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CFG = path.join(ROOT, 'app-config.json');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'dist');

// data/ 下属于「默认配置、必须打进包」的文件；其余是运行期产物，打包前清掉
const KEEP_IN_DATA = ['blocklist.json', 'nav-config.json'];

// 产物内的 app-config.json 与 data/ —— 校验与清理都针对这两个位置
const PACKED_APP = path.join(OUT_DIR, 'win-unpacked', 'resources', 'app');
const PACKED_CFG = path.join(PACKED_APP, 'app-config.json');
const PACKED_DATA = path.join(PACKED_APP, 'data');

function log(msg) { console.log('[prepack] ' + msg); }

// ---- 产物校验：machineId 必须为空 + data/ 不能有运行期文件 ----
// 单独抽成函数，既供打包后调用，也供 --verify-only 离线调用。
function verifyArtifacts() {
  const problems = [];
  if (!fs.existsSync(PACKED_CFG)) {
    problems.push('找不到产物内的 app-config.json：' + PACKED_CFG + '（尚未打包？）');
    return problems;
  }
  let c = {};
  try { c = JSON.parse(fs.readFileSync(PACKED_CFG, 'utf8')); } catch (e) {
    problems.push('产物内 app-config.json 不是合法 JSON：' + e.message);
  }
  const mid = String(c.machineId || '');
  if (mid) {
    problems.push('产物内 machineId 非空（' + mid + '）—— 多台机器会用同一个 MQTT clientId 互踢，'
      + '只有最后一台能收到指令');
  }
  if (fs.existsSync(PACKED_DATA)) {
    const leftover = fs.readdirSync(PACKED_DATA).filter((f) => !KEEP_IN_DATA.includes(f));
    if (leftover.length) problems.push('产物 data/ 内仍有运行期文件：' + leftover.join('、'));
  }
  return problems;
}

// ---- --verify-only：只校验，不打包、不改文件 ----
if (process.argv.includes('--verify-only')) {
  const problems = verifyArtifacts();
  if (problems.length) {
    problems.forEach((p) => console.error('[prepack] ✗ ' + p));
    console.error('[prepack] ✗ 产物校验未通过（' + problems.length + ' 项）—— 这样发出去，'
      + '机房里会出现「装第一台好使、装完全都不好使」');
    process.exit(1);
  }
  log('✅ 产物校验通过：machineId 为空、data/ 无运行期文件 —— 可以直接多机部署');
  process.exit(0);
}

// ---- 1) 备份并重置 app-config.json ----
if (!fs.existsSync(CFG)) {
  console.error('[prepack] ✗ 找不到 ' + CFG);
  process.exit(2);
}
const original = fs.readFileSync(CFG, 'utf8');
let parsed;
try {
  parsed = JSON.parse(original);
} catch (e) {
  console.error('[prepack] ✗ app-config.json 不是合法 JSON：' + e.message);
  process.exit(2);
}

const hadMachineId = String(parsed.machineId || '');
if (hadMachineId) {
  parsed.machineId = '';
  fs.writeFileSync(CFG, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  log('已清空 machineId（原值 ' + hadMachineId + '）—— 避免多台机器 clientId 相同互踢');
} else {
  log('machineId 本就为空，无需处理');
}

// ---- 2) 清理运行期残留 ----
const removed = [];
let entries = [];
try { entries = fs.readdirSync(DATA_DIR); } catch (_e) { /* data/ 不存在也无妨 */ }
for (const f of entries) {
  if (KEEP_IN_DATA.includes(f)) continue;
  try { fs.rmSync(path.join(DATA_DIR, f), { force: true }); removed.push(f); } catch (_e) { /* noop */ }
}
// 打包产物目录里的旧运行期文件同样要清（防止上次 run 留下的被复用）
if (fs.existsSync(PACKED_DATA)) {
  for (const f of fs.readdirSync(PACKED_DATA)) {
    if (KEEP_IN_DATA.includes(f)) continue;
    try { fs.rmSync(path.join(PACKED_DATA, f), { force: true }); removed.push('dist/…/data/' + f); } catch (_e) { /* noop */ }
  }
}
log(removed.length ? '已清理运行期残留：' + removed.join('、') : '无运行期残留需要清理');

// ---- 3) 打包 ----
const args = process.argv.slice(2);
if (!args.length) args.push('--win', 'dir');
log('开始打包：electron-builder ' + args.join(' '));
let status = 1;
try {
  const r = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron-builder'].concat(args),
    { cwd: ROOT, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' },
  );
  status = r.status == null ? 1 : r.status;
} finally {
  // ---- 4) 无论成败都恢复工程文件 ----
  fs.writeFileSync(CFG, original, 'utf8');
  log('已恢复 app-config.json（machineId = ' + (hadMachineId || '空') + '）');
}

if (status !== 0) {
  console.error('[prepack] ✗ 打包失败（退出码 ' + status + '）');
  console.error('[prepack]   工程文件已恢复，无需手工处理。若是下载 Electron 超时/5xx，'
    + '重试即可；网络受限时可加镜像：'
    + 'ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run pack');
  process.exit(status);
}

// ---- 5) 校验产物：machineId 必须为空，否则多机部署会互踢 ----
const problems = verifyArtifacts();
if (problems.length) {
  problems.forEach((p) => console.error('[prepack] ✗ ' + p));
  console.error('[prepack] ✗ 产物校验未通过（' + problems.length + ' 项）。多机部署前务必修正。');
  process.exit(1);
}

log('✅ 打包完成，且产物已确认是「未初始化」状态（machineId 为空、无运行期数据）');
log('   产物：' + PACKED_APP);

