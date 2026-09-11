'use strict';
// CSV 公式注入净化单测：覆盖 sanitizeCell 与 csvOf（保留 UTF-8 BOM）。
// 运行：node test/export-sanitize.test.js
const { sanitizeCell, csvOf } = require('../src/services/export.service');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? (' -> ' + extra) : '')); }
}

// ---------- sanitizeCell 单元 ----------
check('=1+1 前置单引号', sanitizeCell('=1+1') === "'=1+1", sanitizeCell('=1+1'));
check('@sum 前置单引号', sanitizeCell('@sum') === "'@sum", sanitizeCell('@sum'));
check('-2+3 前置单引号', sanitizeCell('-2+3') === "'-2+3", sanitizeCell('-2+3'));
check('+1 前置单引号', sanitizeCell('+1') === "'+1", sanitizeCell('+1'));
check('中文姓名不受影响', sanitizeCell('张三') === '张三', sanitizeCell('张三'));
check('普通文本不变', sanitizeCell('hello world') === 'hello world', sanitizeCell('hello world'));
check('数字类型不被误改', sanitizeCell(123) === 123 && sanitizeCell(0) === 0);
check('空字符串不变', sanitizeCell('') === '');

// ---------- csvOf 集成：保留 BOM + 净化生效 ----------
const csv = csvOf(['name', 'note'], [['张三', '=1+1'], [42, '@sum']]);
check('csvOf 保留 UTF-8 BOM', csv.charCodeAt(0) === 0xFEFF, csv.charCodeAt(0).toString(16));
check('csvOf 公式单元格被净化', csv.includes("'=1+1") && csv.includes("'@sum"), csv);
check('csvOf 中文与数字不受影响', csv.includes('张三') && csv.includes('42'));

console.log('\nCSV 净化验证：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
