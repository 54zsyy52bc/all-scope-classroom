'use strict';
// 预设包协议 + 导入/导出单测（v4：办公端 Studio ↔ 教室大屏 数据流转）。
// 运行：node test/preset-pkg.test.js   （需要 DB_PATH 指向临时库或自动隔离）
// 覆盖：组包结构 / 整包校验 / 导入预演三态 / 提交合并（保留本地较新、created_at 保留）/ 坏包拒绝
const path = require('node:path');

// ---- 隔离存储：用临时库跑（不污染 classroom.db）----
process.env.DB_PATH = path.join(require('node:os').tmpdir(), 'rt-preset-pkg-' + Date.now() + '.db');

const db = require('../src/db');
const presetSvc = require('../src/services/preset.service');
const presetPkgSvc = require('../src/services/preset-pkg.service');
const presetPkg = require('../../shared/preset-package');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

db.init();
const T0 = Date.now() - 60000;

// ---- 预置：两个班级 + 两个活动（模拟办公端已编辑好的库）----
const c1 = presetSvc.createClass({ name: '初二(1)班', totalSeats: 48, groupSize: 6 });
const c2 = presetSvc.createClass({ name: '初二(2)班', totalSeats: 50, groupSize: 5 });
const a1 = presetSvc.createActivity({
  name: '焊接入门', category: '焊接', timed: true, durationSec: 480,
  equipment: [{ eqId: 'DEV-BOARD', eqName: '开发板', category: '主控', preset: 1 }],
  taskTemplates: [{ title: '点亮 LED', desc: '第一关' }],
});
const a2 = presetSvc.createActivity({ name: '传感器', equipment: [] });

// ---- 1) 导出组包 ----
const pkg = presetPkgSvc.exportPackage();
check('exportPackage: pkg 标记正确', pkg.pkg === presetPkg.PKG_MARK, pkg.pkg);
check('exportPackage: schemaVersion=1', pkg.schemaVersion === 1, String(pkg.schemaVersion));
check('exportPackage: 含 2 班级 2 活动', pkg.classes.length === 2 && pkg.activities.length === 2,
  pkg.classes.length + '/' + pkg.activities.length);
check('exportPackage: 活动条目含计时配置', pkg.activities.find((a) => a.presetId === a1.presetId).timed === true);
check('exportPackage: exportedAt 为时间戳', typeof pkg.exportedAt === 'number' && pkg.exportedAt > T0);

// ---- 2) 整包校验 ----
const okPkg = JSON.parse(JSON.stringify(pkg));
check('validatePackage: 合法包零错误', presetPkg.validatePackage(okPkg).length === 0);
const bad1 = { pkg: 'not-a-package', schemaVersion: 1, classes: [], activities: [] };
check('validatePackage: 拒绝坏标记', presetPkg.validatePackage(bad1).length > 0);
const bad2 = { pkg: 'kct-preset-package', schemaVersion: 1, classes: [{ name: '' }], activities: [] };
check('validatePackage: 拒绝空名称条目', presetPkg.validatePackage(bad2).length > 0);
const bad3 = { pkg: 'kct-preset-package', schemaVersion: 1, classes: [], activities: [] };
check('validatePackage: 拒绝空包', presetPkg.validatePackage(bad3).length > 0);
const bad4 = { pkg: 'kct-preset-package', schemaVersion: 1, classes: [], activities: [{ name: 'x', timed: true, durationSec: 1 }] };
check('validatePackage: 拒绝时长越界计时活动', presetPkg.validatePackage(bad4).length > 0);

// ---- 3) 导入预演：本库已有 c1/c2/a1/a2；c1 本地较新 → skipped，新条目 → added ----
const localFresh = Date.now();
const pkgNewer = Date.now() + 5000; // 比库中任何 updated_at 都新 → updated
db.upsertClassPreset({ preset_id: c1.presetId, name: c1.name, total_seats: 48, group_size: 6, note: null, created_at: T0, updated_at: localFresh });
const addC = { presetId: 'CP-NEW001', name: '初二(3)班', totalSeats: 46, groupSize: 5, updatedAt: T0 };
const addA = {
  presetId: 'AP-NEW001', name: '光控小车', category: '综合', timed: false,
  equipment: [{ eqId: 'CAR', eqName: '小车套件', category: '套件', preset: 1 }],
  taskTemplates: [], updatedAt: T0,
};
const importPkg = presetPkg.buildPackage({
  classes: [{ presetId: c1.presetId, name: c1.name, totalSeats: 48, groupSize: 6, updatedAt: T0 }, addC],
  activities: [{ presetId: a2.presetId, name: a2.name, updatedAt: pkgNewer }, addA],
  source: 'test',
});
const prev = presetPkgSvc.previewImport(importPkg);
check('previewImport: c1 本地较新 → skipped', prev.items.find((i) => i.presetId === c1.presetId).action === 'skipped');
check('previewImport: 新班级 → added', prev.items.find((i) => i.presetId === 'CP-NEW001').action === 'added');
check('previewImport: 包内更新 → updated', prev.items.find((i) => i.presetId === a2.presetId).action === 'updated');
check('previewImport: 新活动 → added', prev.items.find((i) => i.presetId === 'AP-NEW001').action === 'added');
check('previewImport: 汇总计数', prev.added === 2 && prev.updated === 1 && prev.skipped === 1,
  prev.added + '/' + prev.updated + '/' + prev.skipped);
check('previewImport: 不落库', !db.getClassPreset('CP-NEW001') && !db.getActivityPreset('AP-NEW001'));

// ---- 4) 提交导入 ----
const ret = presetPkgSvc.commitImport(importPkg);
check('commitImport: 返回预演摘要', ret.added === 2 && ret.skipped === 1, JSON.stringify({ a: ret.added, s: ret.skipped }));
const newC = presetSvc.getClass('CP-NEW001');
check('commitImport: 新班级已入库', !!newC && newC.name === '初二(3)班' && newC.totalSeats === 46);
const c1After = presetSvc.getClass(c1.presetId);
check('commitImport: 本地较新的 c1 未被覆盖', c1After.updatedAt === localFresh, String(c1After.updatedAt));
const newA = presetSvc.getActivity('AP-NEW001');
check('commitImport: 新活动已入库（含器材）', !!newA && newA.equipment.length === 1 && newA.equipment[0].eqId === 'CAR');
const a2After = presetSvc.getActivity(a2.presetId);
check('commitImport: updatedAt 以包内为准', a2After.updatedAt === pkgNewer, String(a2After.updatedAt));
const c1b = presetSvc.getClass(c1.presetId);
check('commitImport: created_at 保留本地原值', c1b.createdAt === T0, String(c1b.createdAt));

// ---- 5) 坏包拒绝 ----
try {
  presetPkgSvc.commitImport({ pkg: 'junk' });
  check('commitImport: 坏包被拒绝', false, '未抛错');
} catch (e) {
  check('commitImport: 坏包被拒绝（E-PKG-01）', e.errorCode === 'E-PKG-01' || /E-PKG-01/.test(String(e.message || e.code || '')), String(e.errorCode || e.message));
}

// ---- 清理测试数据 ----
presetSvc.removeClass(c1.presetId); presetSvc.removeClass(c2.presetId);
presetSvc.removeClass('CP-NEW001');
presetSvc.removeActivity(a1.presetId); presetSvc.removeActivity(a2.presetId); presetSvc.removeActivity('AP-NEW001');
db.close();

console.log('\n预设包协议验证：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
