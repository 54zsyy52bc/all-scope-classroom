'use strict';
// =============================================================================
// 渲染层「错误格式化」单测：错误码 → 中文；绝不返回 E-XXX-NN 或服务端英文原语。
//
// 加载方式：纯 Node + vm sandbox，把 public/error-format.js 当 IIFE 跑一遍，
// 不依赖 jsdom；这是同类渲染层工具（icons.js 等）的小规模、低成本测试模式。
// =============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'error-format.js'), 'utf8');

let pass = 0;
let fail = 0;
const warns = [];
const sandbox = {
  window: {},
  console: Object.assign({}, console, { warn: (msg) => warns.push(String(msg)) }),
};
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'public/error-format.js' });
const ErrorFmt = sandbox.window.ErrorFmt;

function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}
function hasAscii(s) { return /[A-Za-z]{2,}/.test(s); } // 至少 2 个连续 ASCII = 英文原语嫌疑
function hasErrorCode(s) { return /E-[A-Z]+-\d+/.test(s); }

console.log('-- 错误格式化（U-3）');

// 全仓枚举的 14 个错误码必须各有中文标题 + 下一步建议
const EXPECTED = [
  'E-VAL-01','E-AUTH-01','E-CONN-01','E-SESSION-01','E-SESSION-02',
  'E-PHASE-01','E-OFF-01','E-RETURN-01','E-NOTFOUND','E-INTERNAL',
  'E-DUP-01','E-REF-01','E-TIMER-01','E-PKG-01',
];
for (const code of EXPECTED) {
  const r = ErrorFmt.format({ code: 999, errorCode: code, message: 'synthetic english-only message' });
  check(`映射存在: ${code}`, !!r, JSON.stringify(r));
  check(`  · 中文标题: ${code}`, r && /[\u4e00-\u9fff]/.test(r.title));
  check(`  · 包含下一步: ${code}`, r && r.hint && /[\u4e00-\u9fff]/.test(r.hint));
  check(`  · 不暴露错误码: ${code}`, r && !hasErrorCode(r.title) && !hasErrorCode(r.hint));
  check(`  · 不暴露英文原语: ${code}`, r && !hasAscii(r.title) && !hasAscii(r.hint));
}

// 成功路径：code===0 必须返回 null（不返错误信息）
const ok = ErrorFmt.format({ code: 0, data: { anything: 1 } });
check('成功路径返回 null', ok === null);

// 兜底：未知 errorCode / 无 errorCode 都不能给英文
const noErr = ErrorFmt.format({ code: 500, errorCode: 'E-UNKNOWN-99', message: 'whatever' });
check('未知错误码兜底中文', noErr && /[\u4e00-\u9fff]/.test(noErr.title));
check('兜底无英文', noErr && !hasAscii(noErr.title));
const nullish = ErrorFmt.format({ code: 500, errorCode: null, message: null });
check('空错误码也兜底', nullish && /[\u4e00-\u9fff]/.test(nullish.title));
const broken = ErrorFmt.format(null);
check('空响应也兜底', broken && /[\u4e00-\u9fff]/.test(broken.title));

// toastFormatted 一行调用：title + hint 拼接，不含错误码/英文
warns.length = 0;
let toastText = null;
const ret = ErrorFmt.toastFormatted({ code: 50301, errorCode: 'E-CONN-01', message: 'service down' }, (t) => { toastText = t; });
check('toastFormatted 返回 true', ret === true);
check('toastFormatted 调用回调', /教师服务暂不可用/.test(toastText || ''));
check('toast 文本无错误码', toastText && !hasErrorCode(toastText));
check('toast 文本无英文原语', toastText && !hasAscii(toastText));
check('调试输出到 console.warn', warns.length >= 1);

// success path 上不调 toast、不写 warn
warns.length = 0;
let toastCalled = false;
const ret2 = ErrorFmt.toastFormatted({ code: 0 }, () => { toastCalled = true; });
check('成功不调 toast', toastCalled === false);
check('成功返回 false', ret2 === false);
check('成功不写 warn', warns.length === 0);

// 反向：拿 server 原始 message 走一遍 format，绝不能把 "service down" 漏到 title/hint
const stripped = ErrorFmt.format({ code: 500, errorCode: 'E-INTERNAL', message: 'Cannot read property X of undefined at file.js:42' });
check('服务端 stack trace 不外露', stripped && !/Cannot read property/.test(stripped.title + stripped.hint));

console.log('-- 错误格式化 总结: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);