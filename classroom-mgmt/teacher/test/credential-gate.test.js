'use strict';
// 凭据闸门单测（v5.2 S-4：占位默认凭据需有强制闸门，且并入质量门禁）。
//
// 分两层验证：
//   1) 非阻断层：默认配置下必须产出「占位凭据 / 空令牌」告警（现场能看见）；
//   2) 阻断层：STRICT_CREDENTIALS=1（或 NODE_ENV=production）时必须拒绝启动（退出码 1）。
// 阻断层用子进程验证——enforceStrictCredentials 内部直接 process.exit(1)，无法在当前进程内断言。
// 运行：node test/credential-gate.test.js
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const cfg = require('../src/config');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra !== undefined ? (' -> ' + extra) : '')); }
}

const PLACEHOLDER = 'change-me-before-deploy';
const isPlaceholder = cfg.HMAC_SECRET === PLACEHOLDER;
const warnings = Array.isArray(cfg.credentialWarnings) ? cfg.credentialWarnings.join(' | ') : '';

// ---------- 1. 非阻断层：告警必须可见 ----------
if (isPlaceholder) {
  check('占位 HMAC_SECRET 产生告警', warnings.indexOf('HMAC_SECRET') >= 0, warnings);
} else {
  console.log('  [SKIP] HMAC_SECRET 已非占位值，跳过占位告警用例');
}
if (cfg.ENABLE_AUTH === true && !cfg.TEACHER_TOKEN) {
  check('开启鉴权但令牌为空产生告警', warnings.indexOf('TEACHER_TOKEN') >= 0, warnings);
}
if (cfg.HTTP_HOST === '0.0.0.0' && cfg.ENABLE_AUTH !== true) {
  check('全网卡监听且未开鉴权产生告警', warnings.indexOf('0.0.0.0') >= 0, warnings);
} else {
  check('已开鉴权时不再对 0.0.0.0 无谓告警', warnings.indexOf('未开启 ENABLE_AUTH') < 0, warnings);
}

// ---------- 2. 阻断层：严格模式下必须拒绝启动 ----------
{
  const tmpDb = path.join(os.tmpdir(), 'cred-gate-' + process.pid + '.db');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      STRICT_CREDENTIALS: '1', HTTP_PORT: '13999', DB_PATH: tmpDb, LOG_LEVEL: 'error',
    }),
    encoding: 'utf8',
    timeout: 20000,
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  if (isPlaceholder) {
    check('STRICT_CREDENTIALS=1 且占位凭据时拒绝启动（退出码 1）', r.status === 1, 'status=' + r.status);
    check('拒绝启动时打印可操作的中文原因', out.indexOf('启动被拒绝') >= 0, out.slice(0, 300));
  } else {
    console.log('  [SKIP] HMAC_SECRET 已非占位值，严格模式不会拒绝启动，跳过阻断层用例');
  }
}

console.log('\n凭据闸门验证：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
