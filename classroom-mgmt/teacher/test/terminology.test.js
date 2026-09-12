'use strict';
// =============================================================================
// 三端文案术语锁（U-6~U-11 收尾）：
//   1) 三端用户可见文案不应出现「裸」上课（不带「开始 / 已 / 中 / 时 / 模式 / 登记 / 器材」修饰）。
//      这是审查标准总纲 §7.6 的回归防线——「同实体全端统一用词」。
//   2) 关键规范串必须出现：开始上课 / 下课 / 上课登记 / 上课模式。
//   3) 「上课器材」（preset-studio 字段名 / 按钮名）是合法产品术语，保留。
// =============================================================================
const fs = require('fs');
const path = require('path');

const ROOTS = {
  teacher: path.join(__dirname, '..', 'public'),
  student: path.join(__dirname, '..', '..', 'student', 'renderer'),
  preset:  path.join(__dirname, '..', '..', 'preset-studio', 'renderer'),
};

// 跳过：js 注释 / 已规范化字符串 / 产品术语「上课器材」
const ALLOW_BARE = /开始上课|已上课|上课中|上课时|上课模式|上课登记|上课器材/;

const FILES = [
  // teacher
  ['teacher', 'index.html'], ['teacher', 'app.js'], ['teacher', 'presets.js'],
  ['teacher', 'activity.js'], ['teacher', 'admit.js'], ['teacher', 'manage.js'],
  ['teacher', 'stream.js'], ['teacher', 'shell-admin.js'], ['teacher', 'error-format.js'],
  ['teacher', 'dialog.js'], ['teacher', 'term-ui.js'], ['teacher', 'help-alert.js'],
  // student
  ['student', 'index.html'], ['student', 'desktop.html'], ['student', 'shell.html'],
  ['student', 'app.js'], ['student', 'desktop.js'], ['student', 'downlink.js'],
  ['student', 'views.js'], ['student', 'actions.js'], ['student', 'equipment.js'],
  ['student', 'shell.js'], ['student', 'net.js'], ['student', 'app-dock.js'],
  ['student', 'control.js'],
  // preset-studio
  ['preset', 'index.html'], ['preset', 'app.js'], ['preset', 'presets.js'],
  ['preset', 'preset-class-ui.js'], ['preset', 'dialog.js'],
];

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}
function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; }
}
// 抽掉所有 js 行注释 //...，避免源码注释误伤（注释里的「上课」是给开发看的，不是用户可见）
function stripLineComments(text) {
  return text.split('\n').map((line) => {
    // 仅当 // 不在字符串内时移除（粗略：用「//」+ 行末）
    const idx = line.indexOf('//');
    if (idx < 0) return line;
    // 跳过 URL、'http://' 之类
    if (idx > 0 && line[idx - 1] === ':') return line;
    return line.slice(0, idx);
  }).join('\n');
}

console.log('-- 三端术语锁（U-6~U-11 收尾）');

// 1) 不应出现「裸」上课
for (const [root, rel] of FILES) {
  const fp = path.join(ROOTS[root], rel);
  const raw = readSafe(fp);
  if (raw == null) continue; // 文件不存在跳过
  const txt = stripLineComments(raw);
  const lines = txt.split('\n');
  let bareCount = 0;
  const hits = [];
  lines.forEach((line, i) => {
    if (!line.includes('上课')) return;
    if (ALLOW_BARE.test(line)) return;
    // 豁免：HTML 注释 <!-- --> 内的内容不算用户可见
    if (/<!--/.test(line) && /-->/.test(line)) return;
    // 豁免：CSS 选择器 / id / data-*
    if (/[\.\#\[]/.test(line.split('上课')[0].slice(-1))) return;
    bareCount += 1;
    hits.push((i + 1) + ': ' + line.trim().slice(0, 80));
  });
  check(`${root}/${rel} 无裸「上课」`, bareCount === 0, bareCount ? '首条：' + hits[0] : '');
}

// 2) 关键规范串必须存在（按三端分别查）
const teacherText = ['index.html', 'app.js', 'presets.js'].map((f) => readSafe(path.join(ROOTS.teacher, f)) || '').join('\n');
const studentText = ['desktop.html', 'shell.html', 'desktop.js', 'views.js', 'downlink.js'].map((f) => readSafe(path.join(ROOTS.student, f)) || '').join('\n');
const presetText  = ['index.html', 'app.js', 'preset-class-ui.js'].map((f) => readSafe(path.join(ROOTS.preset, f)) || '').join('\n');

check('教师端：按钮"开始上课"出现', /id="btn-start"[^>]*>开始上课</.test(teacherText) || />开始上课</.test(teacherText));
check('教师端：按钮"下课"出现', /id="btn-end"[^>]*>下课</.test(teacherText) || /确认下课/.test(teacherText));
check('学生端："上课登记"按钮存在', /上课登记/.test(studentText));
check('学生端："上课模式"按钮存在', /上课模式/.test(studentText));
check('学生端："等待老师开始上课"出现', /等待老师开始上课/.test(studentText));
check('预设端："上课器材"按钮存在', /上课器材/.test(presetText));

// 3) 反向：原「裸上课」反模式 4 处都不应再出现（见 04 区 U-6~U-11 修复记录）
check('teacher/presets.js 不再有"随上课下发"', !/随上课下发/.test(readSafe(path.join(ROOTS.teacher, 'presets.js')) || ''));
check('teacher/index.html 不再有"随上课下发"', !/随上课下发/.test(readSafe(path.join(ROOTS.teacher, 'index.html')) || ''));
check('student/desktop.html 不再有"登记上课在下方"', !/登记上课在下方/.test(readSafe(path.join(ROOTS.student, 'desktop.html')) || ''));

console.log('-- 三端术语锁 总结: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);