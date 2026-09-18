'use strict';
// =============================================================================
// 渲染层全局引用契约（裸 global 防回归）
//
// 缺陷现场（"课堂登记崩了"真凶）：app.js 的 IIFE 是无参的 `(function () {...})()`，
// 里面写了裸 `global.StageFx` / `global.classroom`。渲染层（contextIsolation）没有
// global 变量 → renderStage() 抛 ReferenceError → boot() 中断 → connect() 永不执行
// → MQTT 永连不上 → 教师端开课后学生端永远收不到切页指令。
// 单元测试全绿也拦不住它：只有真实浏览器 boot 链路才会炸 —— 所以必须静态契约兜底。
//
// 契约 1：文件里出现 `global.` 前提是该文件用 `(function (global) {...})(window)`
//         绑定了形参（views/control/actions/fx/downlink 即此模式）；无绑定的文件
//         （app/desktop/shell/net/...）一律禁止裸 global.，必须写 window.。
// 契约 2：index.html 内联脚本里 getElementById('X') 引用的 id 必须真实存在
//         （brand-mark 曾把 class 当 id 查 → null.innerHTML 崩掉后续图标注入）。
// =============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const SHARED = path.join(ROOT, '..', 'shared');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}

console.log('-- 学生端 渲染层全局引用契约 renderer-global');

// ---- 契约 1：裸 global. 扫描 ----
const jsFiles = [];
for (const dir of [RENDERER, SHARED]) {
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.js')) jsFiles.push(path.join(dir, f));
  }
}
const offenders = [];
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  if (!/\bglobal\./.test(src)) continue;
  const bound = /\(\s*function\s*\(\s*global\s*[,)]/.test(src); // (function (global) / (function (global, x)
  if (!bound) offenders.push(path.relative(ROOT, f));
}
check('G1 所有含 global. 的渲染层/共享文件都绑定了 (function (global) 形参',
  offenders.length === 0, offenders.join(', ') || '(无)');
check('G2 app.js 不再含裸 global.（本次缺陷点）',
  !/\bglobal\./.test(fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8')));
check('G3 app.js 的 StageFx 调用走 window.StageFx',
  /window\.StageFx/.test(fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8')));

// 反向对照：往 app.js 注入裸 global 引用，G 系断言必须能检出（否则是橡皮图章）
{
  const injected = '/*inject*/ if (global.Foo) { console.log(1); }\n';
  const badSrc = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8') + injected;
  const badBound = /\(\s*function\s*\(\s*global\s*[,)]/.test(badSrc);
  const badOffender = (!badBound && /\bglobal\./.test(badSrc));
  check('G4 反向·注入裸 global 后扫描必须检出（证明 G1 不是橡皮图章）', badOffender);
}

// ---- 契约 2：index.html 内联 getElementById 引用的 id 必须存在 ----
{
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const ids = new Set(Array.from(html.matchAll(/id="([^"]+)"/g), (m) => m[1]));
  const refs = Array.from(html.matchAll(/getElementById\('([^']+)'\)/g), (m) => m[1]);
  const missing = refs.filter((r) => !ids.has(r));
  check('G5 index.html 内联脚本引用的 id 全部存在', missing.length === 0,
    '缺失=' + missing.join(','));
  check('G6 index.html 不再把 class 当 id 查（brand-mark 事故点）', !missing.includes('brand-mark'));
  // 反向对照：注入一个不存在的 id 引用，必须检出（追加到文件尾，不依赖行尾格式）
  const bad = html + "<script>document.getElementById('no-such-el').innerHTML = '';</script>";
  const badMissing = Array.from(bad.matchAll(/getElementById\('([^']+)'\)/g), (m) => m[1])
    .filter((r) => !new Set(Array.from(bad.matchAll(/id="([^"]+)"/g), (m) => m[1])).has(r));
  check('G7 反向·注入不存在 id 后必须检出（证明 G5 不是橡皮图章）',
    badMissing.includes('no-such-el'));
}

console.log('-- 渲染层全局引用契约 总结: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
