'use strict';
// =============================================================================
// HTML 去重 / 单实例性检查（L3）：
// 大屏里若干弹窗（overlay-shell / overlay-help / overlay-stop / overlay-confirm 等）
// 必须有且仅有一份实例，避免 getElementById 取到首份而第二份成为死 DOM。
// 该测试是「DOM 卫生」的回归防线，今后任何合并冲突都应让它先报。
// =============================================================================
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'public', 'index.html');
const text = fs.readFileSync(HTML, 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}
function count(re) { const m = text.match(re) || []; return m.length; }
function idsOf(re) {
  const ids = [];
  let m;
  while ((m = re.exec(text)) !== null) ids.push(m[1]);
  return ids;
}

console.log('-- HTML 单实例性（L3 死 DOM 防线）');

const targets = ['overlay-shell', 'shell-title', 'sf-admin-save', 'sf-exit-save', 'sf-save-all', 'sf-apps', 'sf-msg'];
for (const id of targets) {
  const re = new RegExp('id="' + id + '"', 'g');
  const n = count(re);
  check(`#${id} 数量 = 1`, n === 1, '实际=' + n + '（>1 即死 DOM 重复；=0 即被误删）');
}

// 弹窗标题 aria-labelledby 与 shell-title 一一对应
const ariaIds = idsOf(/aria-labelledby="([^"]+)"/g);
check('aria-labelledby 引用的 id 全部存在', ariaIds.every((id) => count(new RegExp('id="' + id + '"', 'g')) >= 1), '引用的 id：' + ariaIds.join(','));

// data-close 关闭器指向 overlay-shell 也要唯一
const closes = idsOf(/data-close="([^"]+)"/g);
for (const id of closes) {
  const n = count(new RegExp('id="' + id + '"', 'g'));
  check(`data-close="${id}" 命中元素 = 1`, n === 1, '实际=' + n);
}

// script 顺序：admit/activity/manage/stream/shell-admin 都必须在 error-format 之后
const lastErrIdx = text.lastIndexOf('error-format.js');
const lateScripts = ['admit.js', 'activity.js', 'manage.js', 'stream.js', 'shell-admin.js'];
for (const s of lateScripts) {
  const idx = text.lastIndexOf(s);
  check('script 顺序：' + s + ' 在 error-format 之后', idx > lastErrIdx, 'errIdx=' + lastErrIdx + ' sIdx=' + idx);
}

console.log('-- HTML 单实例性 总结: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);