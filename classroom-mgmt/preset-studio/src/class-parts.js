'use strict';
// =============================================================================
// Preset Studio · 班级包结构扩展（信息包 / 学生包 / 课时包）的数据标准化。
// 依据脑图：班级包 = 课堂包(*课时包 → *活动包 + *器材包) + 学生包(基本信息+分组) + 信息包。
// 带 * 的数据（课时/活动/器材）支持后期单独替换添加 —— lessons 与 activities 解耦（按 id 引用）。
// 教师端导入预设包时忽略这些扩展字段（normClass 只取已知键），完全向后兼容。
// 纯函数、无副作用，供 store.js 复用，可无头单测。
// =============================================================================

// 信息包：班级的元信息（选填，展示/导出用）
function normInfo(input) {
  if (input === undefined) return {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { info: null };
  const r = {};
  const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
  if (input.grade !== undefined) r.grade = clean(input.grade, 20) || null;
  if (input.room !== undefined) r.room = clean(input.room, 30) || null;
  if (input.teacher !== undefined) r.teacher = clean(input.teacher, 20) || null;
  if (input.semester !== undefined) r.semester = clean(input.semester, 30) || null;
  // 全字段皆空 → 信息包整体归 null（避免存空壳对象）
  if (!Object.values(r).some((v) => v)) return { info: null };
  return { info: r };
}

// 学生包：学生基本信息 + 分组归属（分组名可空 = 未分组）
function normStudents(input) {
  if (input === undefined) return {};
  const list = (Array.isArray(input) ? input : [])
    .map((s) => ({
      studentNo: s && s.studentNo != null ? String(s.studentNo).trim().slice(0, 20) : '',
      name: s && s.name ? String(s.name).trim().slice(0, 30) : '',
      group: s && s.group ? String(s.group).trim().slice(0, 20) : '',
      seat: s && Number.isInteger(Number(s.seat)) && Number(s.seat) > 0 ? Number(s.seat) : 0,
    }))
    .filter((s) => s.name)
    // seat 未提供时按保留行的顺序回填（先过滤再编号，避免剔除行导致序号断档）
    .map((s, i) => (s.seat ? s : Object.assign(s, { seat: i + 1 })));
  return { students: list };
}

// 从学生名单推导分组（保持首次出现顺序）：group 名 → { groupId, size }
// 无分组学生不计入任何组（仍占座位数）。返回 null 表示名单为空/全未分组。
function groupsFromStudents(students) {
  const list = Array.isArray(students) ? students : [];
  const order = [];
  const count = {};
  for (const s of list) {
    if (!s.group) continue;
    if (!(s.group in count)) { count[s.group] = 0; order.push(s.group); }
    count[s.group] += 1;
  }
  if (!order.length) return null;
  return order.map((g) => ({ groupId: g, size: count[g] }));
}

// 课时包：名称 + 引用的活动包（activityIds）+ 本课时器材（*器材包，结构同活动器材）。
// activityIds 只保留字符串；器材行四字段，缺编号自动补 EQ-n。
function normLessons(input) {
  if (input === undefined) return {};
  const list = Array.isArray(input)
    ? input.map((l, li) => ({
      lessonId: l && l.lessonId ? String(l.lessonId).trim().slice(0, 30) : 'L' + (li + 1),
      name: l && l.name ? String(l.name).trim().slice(0, 40) : '',
      activityIds: l && Array.isArray(l.activityIds) ? l.activityIds.map((x) => String(x)) : [],
      equipment: l && Array.isArray(l.equipment)
        ? l.equipment.map((e, i) => ({
          eqId: String((e && e.eqId) || ('EQ-' + (i + 1))).trim(),
          eqName: String((e && e.eqName) || '').trim() || '器材' + (i + 1),
          category: e && e.category ? String(e.category).trim() : '其他',
          preset: Number.isInteger(Number(e && e.preset)) && Number(e.preset) >= 0 ? Number(e.preset) : 1,
        })).filter((e) => e.eqId || e.eqName !== '器材' + '')
        : [],
      note: l && l.note ? String(l.note).trim().slice(0, 60) : null,
    })).filter((l) => l.name)
    : [];
  return { lessons: list };
}

// 学生名单文本（CSV / TSV，Excel 另存为 CSV 或直接复制粘贴）→ { students, groups }。
// 每行：学号,姓名,分组（分组可空）。自动跳过表头（首行含"姓名"字样时）与空行。
// 支持半角/全角逗号、Tab 分隔。解析失败/无有效行抛错（ errorCode 由调用方包装）。
function parseRosterText(text) {
  const raw = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const lines = raw.split(/\r\n|\n|\r/).map((l) => l.trim()).filter((l) => l);
  if (!lines.length) { const e = new Error('名单为空'); e.errorCode = 'E-VAL-01'; throw e; }
  const splitRow = (l) => l.split(/\t|,|，/).map((c) => c.trim().replace(/^"|"$/g, ''));
  let start = 0;
  const head = splitRow(lines[0]);
  if (head.some((c) => /姓名|name|学生/.test(c))) start = 1; // 表头行
  const students = [];
  for (let i = start; i < lines.length; i += 1) {
    const cols = splitRow(lines[i]);
    const name = cols[1] || '';
    if (!name) continue; // 无姓名的行丢弃（避免把合计行当学生）
    students.push({
      studentNo: cols[0] || '',
      name: name.slice(0, 30),
      group: cols[2] || '',
      seat: students.length + 1,
    });
  }
  if (!students.length) { const e = new Error('没有解析到有效学生（每行需含姓名列）'); e.errorCode = 'E-VAL-01'; throw e; }
  return { students, groups: groupsFromStudents(students) };
}

module.exports = { normInfo, normStudents, normLessons, groupsFromStudents, parseRosterText };
