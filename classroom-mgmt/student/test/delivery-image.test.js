'use strict';
// =============================================================================
// 母盘（交付包）配置防回归门禁：本次现场报障根因是交付包学生端母盘
//   交付包_v4课堂管理系统/3_学生端/resources/app/app-config.json
// 残留了开发机的 "shell" 段（admin.enabled=true），导致点「设置」被管理员验证挡住，
// 而文档承诺「首次默认无口令直接进入」。另：machineId/seat/name/studentNo 应为空
// （实物曾带 M-d0d44063/02/1，手工拷贝会撞机器号）。
//
// 本门禁把上述约定固化成自动断言。交付包目录是 gitignored 的，别的机器上可能
// 不存在——此时优雅 SKIP（退出码 0），绝不因包缺失而报红。
//
// 反向对照（防橡皮图章）：在内存给解析对象塞回 shell 段并把 machineId 改成 M-x，
// 用同样断言函数跑第二遍，断言 a/b 必须翻转成 FAIL；变异只存在于内存，不落盘。
// =============================================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..'); // classroom-mgmt

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}

// 双布局探测：交付包只在固定布局下存在，找到即用，找不到返回 null
function pickFile(candidates) {
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}
const DELIV = path.join(__dirname, '..', '..', '..'); // classroom-mgmt 的上级（交付包根）
const APP_CFG = pickFile([
  path.join(DELIV, '交付包_v4课堂管理系统', '3_学生端', 'resources', 'app', 'app-config.json'),
]);

// 文件不存在 → 优雅跳过，退出码 0（交付包 gitignored，别的机器可能没有）
if (!APP_CFG) {
  console.log('[SKIP] 交付包不在本机，跳过母盘配置门禁');
  process.exit(0);
}

console.log('-- 交付包 母盘配置门禁 delivery-image');

// 读取原始字节，检查 UTF-8 BOM（BOM 会让某些读取路径上的 JSON.parse 出问题）
const buf = fs.readFileSync(APP_CFG);
const hasBOM = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
const cfg = JSON.parse(hasBOM ? buf.slice(3).toString('utf8') : buf.toString('utf8'));

// 断言函数（对传入对象做判定，便于反向对照复用，避免重复实现漂移）
function assertNoShell(o) { return o && !('shell' in o); }
function assertEmptyIdentity(o) {
  return o && o.machineId === '' && o.seat === '' && o.name === '' && o.studentNo === '';
}
function assertDryRun(o) { return o && o.dryRun === true; }

// ---- 第一轮：母盘真实配置，期望全部 PASS ----
const a0 = assertNoShell(cfg);
const b0 = assertEmptyIdentity(cfg);
const c0 = assertDryRun(cfg);
check('a 母盘不含 "shell" 段（无口令直进约定）', a0);
check('b machineId/seat/name/studentNo 均为空字符串', b0);
check('c dryRun 仍为 true（安全设计不被顺手改掉）', c0);
check('d 文件为 UTF-8 无 BOM', !hasBOM);

// ---- 反向对照：内存塞回 shell 段 + 改 machineId，断言 a/b 翻转（变异不落盘）----
const bad = JSON.parse(JSON.stringify(cfg)); // 深拷贝，避免污染原始 cfg
bad.shell = { admin: { enabled: true, pwd: 'x' } };
bad.machineId = 'M-x';
const a1 = assertNoShell(bad);
const b1 = assertEmptyIdentity(bad);
check('反向·塞回 shell 段后断言 a 翻转(转 FAIL)', a0 === true && a1 === false);
check('反向·改 machineId 后断言 b 翻转(转 FAIL)', b0 === true && b1 === false);
check('反向特异性·仅变异 a/b 相关字段时 c 仍为 PASS', assertDryRun(bad));
console.log('    [反向对照] 断言 a: 原始=' + a0 + ' / 变异后=' + a1 + ' (预期 true→false)');
console.log('    [反向对照] 断言 b: 原始=' + b0 + ' / 变异后=' + b1 + ' (预期 true→false)');

console.log('-- 交付包 母盘配置门禁 delivery-image 总结: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
