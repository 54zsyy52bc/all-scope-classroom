'use strict';
// class-parts 无头单测：信息包 / 学生包 / 课时包标准化 + 名单解析。
// 运行：node test/class-parts.test.js
const {
  normInfo, normStudents, normLessons, groupsFromStudents, parseRosterText,
} = require('../src/class-parts');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

// ---- 信息包 ----
check('信息包：四字段截断清洗', (() => {
  const r = normInfo({ grade: '  初二 '.repeat(3), room: '东机房'.repeat(12), teacher: ' 张老师 ', semester: '2026 秋' });
  return r.info.grade === '初二   初二   初二'.slice(0, 20) && r.info.grade.length <= 20
    && r.info.room.length <= 30 && r.info.teacher === '张老师' && r.info.semester === '2026 秋';
})());
check('信息包：空串/纯空白归 null', normInfo({ grade: '', room: '  ' }).info === null);
check('信息包：undefined 不动原字段', normInfo(undefined).info === undefined);
check('信息包：非法类型归 null', normInfo('junk').info === null && normInfo(['x']).info === null);

// ---- 学生包 ----
const stu = normStudents([
  { studentNo: ' 2026001 ', name: ' 张三 ', group: '1组', seat: 'x' },
  { studentNo: 7, name: '', group: '垃圾行' },
  { name: '李四' },
]);
check('学生包：清洗 + 剔除无名行 + seat 回退序号', stu.students.length === 2
  && stu.students[0].studentNo === '2026001' && stu.students[0].name === '张三'
  && stu.students[0].group === '1组' && stu.students[0].seat === 1
  && stu.students[1].name === '李四' && stu.students[1].seat === 2
  && stu.students[1].studentNo === '');
check('学生包：非数组归空', normStudents('junk').students.length === 0 && normStudents(undefined).students === undefined);

// ---- 分组推导 ----
const g = groupsFromStudents(stu.students);
check('分组推导：按首次出现顺序聚合', g && g.length === 1 && g[0].groupId === '1组' && g[0].size === 1);
check('分组推导：全未分组返回 null', groupsFromStudents([{ name: '王五', group: '' }]) === null);

// ---- 课时包 ----
const les = normLessons([
  { name: ' 第1课 点亮LED ', activityIds: ['AP-1', 42], equipment: [{ eqName: 'LED' }, { eqId: 'R1', preset: 0 }] },
  { activityIds: [], equipment: [] },
  { name: '第2课', lessonId: 'L-CUSTOM' },
]);
check('课时包：清洗 + activityIds 转字符串 + 缺编号补 EQ-n', les.lessons.length === 2
  && les.lessons[0].name === '第1课 点亮LED'
  && les.lessons[0].activityIds[0] === 'AP-1' && les.lessons[0].activityIds[1] === '42'
  && les.lessons[0].equipment[0].eqId === 'EQ-1' && les.lessons[0].equipment[1].preset === 0);
check('课时包：缺 lessonId 补 L-n / 保留自定义', les.lessons[0].lessonId === 'L1' && les.lessons[1].lessonId === 'L-CUSTOM');
check('课时包：无名课时剔除', !les.lessons.some((l) => !l.name));

// ---- 名单解析 ----
const r1 = parseRosterText('学号,姓名,分组\n2026001,张三,1组\n2026002,李四,1组\n2026003,王五,2组\n');
check('名单：表头跳过 + 三列解析 + 分组推导', r1.students.length === 3
  && r1.students[0].studentNo === '2026001' && r1.students[2].group === '2组'
  && r1.groups.length === 2 && r1.groups[0].groupId === '1组' && r1.groups[0].size === 2);
const r2 = parseRosterText('\uFEFF2026001\t张三\t1组\r\n2026002\t李四\r\n');
check('名单：BOM/Tab/CRLF/缺分组列', r2.students.length === 2 && r2.students[0].group === '1组' && r2.students[1].group === '');
const r3 = parseRosterText('2026001，张三，1组');
check('名单：全角逗号 + 无表头', r3.students.length === 1 && r3.students[0].name === '张三');
const r4 = parseRosterText('NAME,Name,学生\n01,Ada\n');
check('名单：英文表头识别', r4.students.length === 1 && r4.students[0].studentNo === '01');
let threw1 = false; try { parseRosterText(''); } catch (e) { threw1 = e.errorCode === 'E-VAL-01'; }
let threw2 = false; try { parseRosterText('只有学号\n'); } catch (e) { threw2 = e.errorCode === 'E-VAL-01'; }
check('名单：空文本/无有效行抛 E-VAL-01', threw1 && threw2);
const r5 = parseRosterText('01,张三\n\n  \n02,李四\n合计,\n');
check('名单：空行与无姓名行丢弃', r5.students.length === 2);

console.log('\nclass-parts 验证：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
