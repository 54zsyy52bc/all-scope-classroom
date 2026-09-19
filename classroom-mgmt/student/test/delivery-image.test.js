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

// =============================================================================
// 第二段：安装脚本 + main.js 同步 —— 针对「覆盖了但没生效 / 双击打不开」
//   现场事故：安装脚本先 taskkill 再 xcopy，但①不校验 taskkill 是否真的杀掉了
//   （学生端是管理员运行、脚本自己没提权时 taskkill 会拒绝访问）②不校验 xcopy 结果
//   （xcopy 失败只打印报错就返回）→ 文件被占用、拷成半旧半新，脚本却照样打印
//   「[5/5] 完成！」，老师以为更新了，实际跑的还是旧代码。
//   另一处：「双击没反应」来自 main.js 拿不到单实例锁时静默 app.quit()，
//   既无窗口也无日志（audit.log 里一条都不留），现场完全无法排查。
// =============================================================================
const INSTALL_CMD = pickFile([
  path.join(DELIV, '交付包_v4课堂管理系统', '5_部署工具', '一键安装学生端(右键以管理员运行).cmd'),
]);

// ---- 可复用判定函数（正向与反向对照共用同一实现，避免断言漂移）----
function bufHasBOM(buf) { return buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF; }
function isCrlfOnly(buf) {
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0A && (i === 0 || buf[i - 1] !== 0x0D)) return false;
  return true;
}
function hasChcpLine(txt) { return /^[ \t]*chcp([ \t]|$)/im.test(txt); }
function hasRemMetachar(txt) { return /^[ \t]*rem.*[|&<>^]/im.test(txt); }
function guardsKill(txt) { return txt.includes('findstr') && txt.includes('exit /b 2'); }
function guardsCopy(txt) { return txt.includes(':cs_verify') && txt.includes('exit /b 3'); }
function norm(s) { return s.replace(/\r\n/g, '\n'); }
function lockIsLoud(txt) { return txt.includes('showErrorBox'); }

if (!INSTALL_CMD) {
  console.log('[SKIP] 未找到交付包安装脚本，跳过其编码/防静默失败门禁');
} else {
  const raw = fs.readFileSync(INSTALL_CMD);
  check('e 安装脚本无 UTF-8 BOM（含中文的 .cmd 必须 GBK）', !bufHasBOM(raw));
  check('f 安装脚本只有 CRLF（不得有裸 LF）', isCrlfOnly(raw));

  let txt = null;
  try { txt = new TextDecoder('gbk').decode(raw); } catch (_e) { txt = null; }
  if (txt === null) {
    console.log('    [SKIP] 本机 Node 无 GBK 解码能力（small-icu），跳过文本级断言');
  } else {
    check('g 安装脚本不得出现 chcp（cmd 会按错误字节偏移续读）', !hasChcpLine(txt));
    check('h rem 行不得含 | & < > ^（会被当分隔符执行）', !hasRemMetachar(txt));
    check('i 杀进程后有复检：杀不掉必须中止（不是继续 xcopy）', guardsKill(txt));
    check('j 复制后有抽检：覆盖不完整必须报错退出', guardsCopy(txt));
    check('k 脚本确实声明了 GBK 编码约定（防后人改回 UTF-8）', /GBK/i.test(txt));

    // ---- 反向对照：把每种坏味道注入一份内存副本，断言必须翻转 ----
    const bad1 = 'chcp 65001\n' + txt;
    const bad2 = txt.replace(/^rem /m, 'rem a | b ');
    // 注意不能用 ':cs_verify_removed' 之类做替换——它仍包含 ':cs_verify' 子串，断言不会翻转
    const bad3 = txt.replace(/:cs_verify/g, ':COPYCHECK').replace(/exit \/b 3/g, 'exit /b 0');
    check('反向·注入 chcp 后断言 g 翻转', !hasChcpLine(txt) && hasChcpLine(bad1));
    check('反向·rem 注入 | 后断言 h 翻转', !hasRemMetachar(txt) && hasRemMetachar(bad2));
    check('反向·删掉抽检后断言 j 翻转', guardsCopy(txt) && !guardsCopy(bad3));
    check('反向·删掉杀进程复检后断言 i 翻转',
      guardsKill(txt) && !guardsKill(txt.replace(/findstr/g, 'NOFIND').replace(/exit \/b 2/g, 'exit /b 0')));
    const lfBye = Buffer.from(txt.replace(/\r\n/g, '\n'), 'latin1');
    check('反向·改成裸 LF 后断言 f 翻转', isCrlfOnly(raw) && !isCrlfOnly(lfBye));
  }
}

// =============================================================================
// 第三段：整目录代码同步（原只校验 main.js，不够）
//   本次「覆盖了但没生效」的教训：任何一份主进程/渲染层代码漏同步，现场都表现为
//   「改了没用」。故对 resources/app 下所有代码文件做逐字节比对，只放过两个
//   配置类文件（app-config.json 出厂态 / desktop-config.json 母盘策略，单独断言）。
// =============================================================================
const APP_DIR = path.join(DELIV, '交付包_v4课堂管理系统', '3_学生端', 'resources', 'app');
const SRC_DIR = path.join(ROOT, 'student');
const EXCLUDE = new Set(['app-config.json', 'desktop-config.json']);

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), rel, out);
    else out.push(rel);
  }
  return out;
}
const driftOf = (rows) => rows.filter((r) => norm(r.src) !== norm(r.deliv)).map((r) => r.rel);

// 源码侧"应该被打进交付包"的运行时文件清单。
// 交付包实际发布的只有这几个目录 + 顶层脚本；test/、scripts/、node_modules/ 等是本机开发用的。
// 用"发布目录 + 顶层脚本后缀"而不是硬编码文件名，新增文件才能自动被这条门禁覆盖。
const SHIPPED_DIRS = new Set(['renderer', 'shared', 'vendor']);
const SHIPPED_TOP = /\.(js|ps1)$/;
function sourceRuntimeRels() {
  const out = [];
  (function walkShipped(dir, base) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (base === '' && !SHIPPED_DIRS.has(e.name)) continue; // 顶层只下潜进发布目录
        walkShipped(path.join(dir, e.name), rel);
      } else if (base !== '' || SHIPPED_TOP.test(e.name)) out.push(rel);
    }
  }(SRC_DIR, ''));
  return out;
}

if (!fs.existsSync(APP_DIR)) {
  console.log('[SKIP] 未找到交付包学生端 app 目录，跳过整目录同步门禁');
} else {
  const rels = walk(APP_DIR, '', []).filter((f) => !EXCLUDE.has(f));
  const rows = rels.map((rel) => ({ rel, src: fs.existsSync(path.join(SRC_DIR, rel))
    ? fs.readFileSync(path.join(SRC_DIR, rel), 'utf8') : null,
  deliv: fs.readFileSync(path.join(APP_DIR, rel), 'utf8') }));
  const missing = rows.filter((r) => r.src === null).map((r) => r.rel);
  const drift = driftOf(rows);
  check('l 交付包 app 全部代码文件与源码一致（共 ' + rels.length + ' 个）',
    missing.length === 0 && drift.length === 0,
    '源码缺=' + missing.join(',') + ' 内容漂移=' + drift.join(','));

  // 反向方向：源码里新增/改名的运行时文件必须真的进了交付包。
  // 只从交付包往源码查（上面那条 l）永远抓不到「源码有、交付包没有」——
  // 而「新功能文件忘了同步」正是最典型的翻车方式（本次新增 activity-panel.js / tiles.js）。
  const srcRuntime = sourceRuntimeRels();
  const notShipped = srcRuntime.filter((rel) => !rels.includes(rel));
  check('l2 源码里的运行时文件都已打进交付包（共 ' + srcRuntime.length + ' 个，防"新文件忘了同步"）',
    notShipped.length === 0, '交付包缺=' + notShipped.join(','));
  const dropped = rels.filter((r) => r !== 'renderer/activity-panel.js');
  const notShipped2 = srcRuntime.filter((rel) => !dropped.includes(rel));
  check('反向·模拟"新文件没同步进交付包"后断言 l2 翻转',
    notShipped2.length === 1 && notShipped2[0] === 'renderer/activity-panel.js', notShipped2.join(','));

  const REPO_MAIN = path.join(SRC_DIR, 'main.js');
  const repo = fs.readFileSync(REPO_MAIN, 'utf8');
  check('m main.js 保留单实例锁的可见提示（不再静默 quit）', lockIsLoud(repo));
  // 与 run-tests.sh 的 wc -l 口径一致（split('\n') 会把文件末尾换行多算一行，恰好 300 行时误报）
  check('n main.js 仍在 300 行门禁内', repo.replace(/\n$/, '').split('\n').length <= 300);
  check('反向·删掉提示后断言 m 翻转', lockIsLoud(repo) && !lockIsLoud(repo.replace(/showErrorBox/g, 'noop')));

  // 反向对照：在内存里把交付包侧的 main-guard.js 回退成旧门禁，断言 l 必须翻转
  const mg = rows.find((r) => r.rel === 'main-guard.js');
  check('反向·交付包确实含本文件（否则反向对照无意义）', !!mg);
  if (mg) {
    const ctrl = mg.deliv.replace('hasApps || denyList.length || minimizeOthers',
      'hasApps || denyList.length');
    check('反向·成功把交付包侧门禁改回旧写法', ctrl !== mg.deliv);
    const drift2 = driftOf([{ rel: 'main-guard.js', src: mg.src, deliv: ctrl }]);
    // 注意：这里**不能**再要求 drift.length === 0。反向对照要证明的是"检测器对这次变异有反应"，
    // 把"当前交付包恰好是干净的"当前置条件，会让交付包一有未同步就假失败（这个坑踩过）。
    check('反向·模拟"交付包漏同步"后断言 l 会检出该文件（证明不是橡皮图章）',
      drift2.length === 1 && drift2[0] === 'main-guard.js', drift2.join(','));
  }
  const loud = rows.find((r) => r.rel === 'main-guard.js');
  check('o 交付包守卫门禁已含最小化触发项（母盘最小化配置真实生效）',
    !!loud && /denyList\.length \|\| minimizeOthers/.test(loud.deliv));
}

console.log('-- 交付包 母盘配置门禁 delivery-image 总结: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
