'use strict';
// =============================================================================
// 三端文案术语锁（U-6~U-11 收尾）：
//   1) 三端用户可见文案不应出现「裸」上课（不带「开始 / 已 / 中 / 时 / 模式 / 登记 / 器材」修饰）。
//      这是审查标准总纲 §7.6 的回归防线——「同实体全端统一用词」。
//   2) 关键规范串必须出现：开始上课 / 下课 / 上课登记 / 上课模式 / 上课器材。
//   3) 「上课器材」（preset-studio 字段名 / 按钮名）是合法产品术语，保留。
//
// 三端根目录支持两种布局（自动探测，找不到则明确 SKIP，不误报 FAIL）：
//   A. 开发仓库：<classroom-mgmt>/teacher|student|preset-studio
//   B. 交付包  ：交付包/2_教师机/teacher + 交付包/3_学生端/resources/app + 交付包/1_PresetStudio/resources/app
//   B 布局使本用例在交付包内也能真正校验三端文案（否则会因找不到同级目录而整体报红）。
// =============================================================================
const fs = require('fs');
const path = require('path');

function pickRoot(candidates) {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const DELIV = path.join(__dirname, '..', '..', '..'); // 交付包根（仅 B 布局存在）
const ROOTS = {
  teacher: pickRoot([path.join(__dirname, '..', 'public')]),
  student: pickRoot([
    path.join(__dirname, '..', '..', 'student', 'renderer'),
    path.join(DELIV, '3_学生端', 'resources', 'app', 'renderer'),
  ]),
  preset: pickRoot([
    path.join(__dirname, '..', '..', 'preset-studio', 'renderer'),
    path.join(DELIV, '1_PresetStudio', 'resources', 'app', 'renderer'),
  ]),
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
let skip = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}
function skipCheck(name, why) {
  skip += 1;
  console.log('  [SKIP] ' + name + ' -> ' + why);
}
function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; }
}
// 反向断言专用：文件必须存在，否则「不含 X」的断言会因空串而恒真（假绿）
function absentIn(root, rel, pattern) {
  if (!ROOTS[root]) { skipCheck(`${root}/${rel} 不再有 ${pattern}`, `未找到 ${root} 根目录`); return; }
  const txt = readSafe(path.join(ROOTS[root], rel));
  if (txt == null) { check(`${root}/${rel} 不再有 ${pattern}`, false, '文件不存在，断言无法生效'); return; }
  check(`${root}/${rel} 不再有 ${pattern}`, !pattern.test(txt));
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

// 0) 根目录探测结果（布局 B / 根缺失时给出明确提示，便于定位环境问题）
for (const key of ['teacher', 'student', 'preset']) {
  if (ROOTS[key]) console.log(`  [root] ${key}: ${ROOTS[key]}`);
  else console.log(`  [root] ${key}: 未找到（该端的检查将跳过）`);
}

// 1) 不应出现「裸」上课
for (const [root, rel] of FILES) {
  if (!ROOTS[root]) continue; // 整端缺失：已在 root 行说明，且第 2 步会给出 SKIP
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

// 2) 关键规范串必须存在（按三端分别查；整端缺失 → SKIP 而非 FAIL）
function joined(root, files) {
  if (!ROOTS[root]) return null;
  return files.map((f) => readSafe(path.join(ROOTS[root], f)) || '').join('\n');
}
const teacherText = joined('teacher', ['index.html', 'app.js', 'presets.js']);
const studentText = joined('student', ['desktop.html', 'shell.html', 'desktop.js', 'views.js', 'downlink.js']);
const presetText = joined('preset', ['index.html', 'app.js', 'preset-class-ui.js']);

if (teacherText == null) skipCheck('教师端规范串', '未找到 teacher 根目录');
else {
  check('教师端：按钮"开始上课"出现', /id="btn-start"[^>]*>开始上课</.test(teacherText) || />开始上课</.test(teacherText));
  check('教师端：按钮"下课"出现', /id="btn-end"[^>]*>下课</.test(teacherText) || /确认下课/.test(teacherText));
}
if (studentText == null) skipCheck('学生端规范串', '未找到 student 根目录');
else {
  check('学生端："上课登记"按钮存在', /上课登记/.test(studentText));
  check('学生端："上课模式"按钮存在', /上课模式/.test(studentText));
  check('学生端："等待老师开始上课"出现', /等待老师开始上课/.test(studentText));
}
if (presetText == null) skipCheck('预设端规范串', '未找到 preset 根目录');
else check('预设端："上课器材"按钮存在', /上课器材/.test(presetText));

// 3) 反向：原「裸上课」反模式 4 处都不应再出现（见 04 区 U-6~U-11 修复记录）
absentIn('teacher', 'presets.js', /随上课下发/);
absentIn('teacher', 'index.html', /随上课下发/);
absentIn('student', 'desktop.html', /登记上课在下方/);

console.log('-- 三端术语锁 总结: ' + pass + ' pass / ' + fail + ' fail / ' + skip + ' skip');
process.exit(fail === 0 ? 0 : 1);
