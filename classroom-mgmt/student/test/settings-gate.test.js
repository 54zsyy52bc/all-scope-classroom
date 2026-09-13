'use strict';
// =============================================================================
// 设置口令闸门回归防线：openSettings / askPwd 在「口令未通过」或「IPC 读取失败」时，
// 必须给出「可见提示」，绝不能再静默无反应（旧缺陷：点了设置/课程应用管理打不开）。
//
// 做法：把 renderer/desktop.js 当纯文本读入，按索引切片定位后做结构化断言，
// 不依赖脆弱的多行正则。关键的「反向对照」：在内存里删掉被断言的 floatToast / 30000，
// 再跑一遍同样断言，必须翻转成 FAIL——证明断言不是橡皮图章。
// 改坏的字符串只存在内存（MUT_*），绝不写回仓库。
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
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('-- 设置口令闸门 settings-gate');

const SRC = read('renderer/desktop.js');

// 切片：openSettings 函数体（到下一个顶层函数 askPwd 之前）
function openBlock(src) {
  const s = src.indexOf('async function openSettings()');
  const e = src.indexOf('function askPwd()', s < 0 ? 0 : s);
  return s < 0 ? '' : src.slice(s, e < 0 ? src.length : e);
}
// 切片：askPwd 函数体（到下一个顶层函数 saveSet 之前）
function askBlock(src) {
  const s = src.indexOf('function askPwd()');
  const e = src.indexOf('async function saveSet()', s < 0 ? 0 : s);
  return s < 0 ? '' : src.slice(s, e < 0 ? src.length : e);
}

// (a) openSettings 内：口令闸门未通过的分支里，必须有可见 floatToast 提示
//     定位 if (!ok) 的 { … } 体，断言其中含 floatToast(（而不是代码里别的 floatToast）
function assertA(src) {
  const b = openBlock(src);
  const iNotOk = b.indexOf('if (!ok)');
  if (iNotOk < 0) return false;
  const iBodyStart = b.indexOf('{', iNotOk);   // if 体的 '{'
  const iBodyEnd = b.indexOf('}', iBodyStart); // if 体的 '}'
  const iFloat = b.indexOf('floatToast(', iBodyStart);
  return iFloat > iBodyStart && iFloat < iBodyEnd;
}

// (b) askPwd 内：failCount 自增 + 30000 毫秒锁定 + 锁定/剩余次数文案
function assertB(src) {
  const b = askBlock(src);
  return b.indexOf('failCount') >= 0
      && b.indexOf('failCount +=') >= 0
      && b.indexOf('30000') >= 0
      && b.indexOf('口令错误，已锁定 30 秒') >= 0
      && b.indexOf('口令错误，还可尝试') >= 0;
}

// (c) openSettings 内：包住 getShellConfig 的 catch 块里必须有可见 floatToast
function assertC(src) {
  const b = openBlock(src);
  const iGet = b.indexOf('getShellConfig()');
  if (iGet < 0) return false;
  const iCatch = b.indexOf('catch (', iGet);
  if (iCatch < 0) return false;
  const iCatchEnd = b.indexOf('}', iCatch);    // catch 体的 '}'
  const iFloat = b.indexOf('floatToast(', iCatch);
  return iFloat > iCatch && iFloat < iCatchEnd;
}

// ---- 第一轮：原始源码，期望全部 PASS ----
const a0 = assertA(SRC);
const b0 = assertB(SRC);
const c0 = assertC(SRC);
check('a openSettings 失败分支含可见 floatToast 提示', a0);
check('b askPwd 含 failCount 自增与 30000 锁定', b0);
check('c 包住 getShellConfig 的 catch 块含 floatToast 提示', c0);

// ---- 反向对照 1：删掉 openSettings 失败分支的 floatToast（仅内存）----
const MUT_A = SRC.split("floatToast('已取消：需要管理员口令才能打开设置', true)").join('');
const a1 = assertA(MUT_A);
check('反向·删 openSettings 失败分支 floatToast 后断言 a 翻转(转 FAIL)', a0 === true && a1 === false);
check('反向特异性·仅删 a 时 b、c 仍为 PASS', assertB(MUT_A) && assertC(MUT_A));
console.log('    [反向对照] 断言 a: 原始=' + a0 + ' / 删除后=' + a1 + ' (预期 true→false)');

// ---- 反向对照 2：删掉 catch 块的 floatToast（仅内存）----
const MUT_C = SRC.split("floatToast('读取口令配置失败，已按无口令进入', true)").join('');
const c1 = assertC(MUT_C);
check('反向·删 catch 块 floatToast 后断言 c 翻转(转 FAIL)', c0 === true && c1 === false);
check('反向特异性·仅删 c 时 a、b 仍为 PASS', assertA(MUT_C) && assertB(MUT_C));
console.log('    [反向对照] 断言 c: 原始=' + c0 + ' / 删除后=' + c1 + ' (预期 true→false)');

// ---- 反向对照 3：删掉 askPwd 的 30000 锁定毫秒（仅内存）----
const MUT_B = SRC.split('30000').join('');
const b1 = assertB(MUT_B);
check('反向·删 askPwd 的 30000 后断言 b 翻转(转 FAIL)', b0 === true && b1 === false);
check('反向特异性·仅删 b 时 a、c 仍为 PASS', assertA(MUT_B) && assertC(MUT_B));
console.log('    [反向对照] 断言 b: 原始=' + b0 + ' / 删除后=' + b1 + ' (预期 true→false)');

console.log('-- 设置口令闸门 settings-gate 总结: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
