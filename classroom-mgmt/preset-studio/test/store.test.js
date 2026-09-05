'use strict';
// Preset Studio 本地库单测（纯 Node 无头，不依赖 Electron）。
// 运行：node test/store.test.js
// 覆盖：CRUD / upsert 保留创建时间 / 器材字典 / 导出包 / 导入预演三态 / 提交合并 / 持久化 / 坏包
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/store');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (detail ? '  → ' + detail : '')); }
}

const DATA = path.join(os.tmpdir(), 'studio-test-' + Date.now() + '.json');
const store = createStore(DATA);
const T0 = Date.now() - 60000;

// ---- CRUD：班级 ----
const c1 = store.upsertClass({ preset_id: 'CP-TEST01', name: '初二(1)班', total_seats: 48, group_size: 6, note: '东机房' });
check('班级创建：字段落库', c1.name === '初二(1)班' && c1.total_seats === 48 && c1.group_size === 6);
check('班级创建：自动时间戳', !!c1.created_at && c1.created_at === c1.updated_at);
check('班级读取', store.getClass('CP-TEST01').name === '初二(1)班');
store.upsertClass({ preset_id: 'CP-TEST01', name: '初二(1)班(改)', total_seats: 50 });
const c1b = store.getClass('CP-TEST01');
check('班级更新：改名改座位', c1b.name === '初二(1)班(改)' && c1b.total_seats === 50);
check('班级更新：created_at 保留', c1b.created_at === c1.created_at, String(c1b.created_at));
check('班级列表计数', store.listClasses().length === 1);

// ---- v4.2：分组配置 + 上课器材（座位数联动 = 各组之和）----
const cGrp = store.upsertClass({
  preset_id: 'CP-GRP01', name: '分组测试班',
  groups: [{ groupId: '第一组', size: 6 }, { groupId: '第二组', size: 5 }],
  equipment: [{ eqId: 'SOLDER-KIT', eqName: '焊接套件', category: '焊接', preset: 1 }],
});
check('分组配置：组名自定义且落库', cGrp.groups.length === 2 && cGrp.groups[0].groupId === '第一组'
  && cGrp.groups[0].size === 6, JSON.stringify(cGrp.groups));
check('分组配置：座位数联动 = 各组之和(11)', cGrp.total_seats === 11, String(cGrp.total_seats));
check('上课器材：落库', cGrp.equipment.length === 1 && cGrp.equipment[0].eqId === 'SOLDER-KIT');
store.upsertClass({ preset_id: 'CP-GRP01', name: '分组测试班', groups: [] });
const cGrp2 = store.getClass('CP-GRP01');
check('清空分组：groups=[] 且不改原座位数', cGrp2.groups.length === 0 && cGrp2.total_seats === 11,
  JSON.stringify({ g: cGrp2.groups, s: cGrp2.total_seats }));
const pkgC = store.exportPackage({ classes: ['CP-GRP01'], activities: [] });
check('过滤导出：仅含目标班级', pkgC.classes.length === 1 && pkgC.activities.length === 0);
check('过滤导出：包内携带分组与上课器材', pkgC.classes[0].groups.length === 0
  && Array.isArray(pkgC.classes[0].equipment));
store.removeClass('CP-GRP01');

// ---- CRUD：活动（含计时 + 器材 + 模板）----
const a1 = store.upsertActivity({
  preset_id: 'AP-TEST01', name: '焊接入门', category: '焊接', timed: true, durationSec: 480,
  equipment: [{ eqId: 'DEV-BOARD', eqName: '开发板', category: '主控', preset: 1 }],
  taskTemplates: [{ title: '点亮 LED', desc: '第一关' }],
});
check('活动创建：计时字段', a1.timed === true && a1.durationSec === 480);
check('活动读取：器材与模板', store.getActivity('AP-TEST01').equipment[0].eqId === 'DEV-BOARD'
  && store.getActivity('AP-TEST01').taskTemplates[0].title === '点亮 LED');
store.upsertActivity({ preset_id: 'AP-TEST01', name: '焊接入门 v2', timed: false });
const a1b = store.getActivity('AP-TEST01');
check('活动更新：保留器材清单（部分更新合并）', a1b.equipment.length === 1, String(a1b.equipment.length));
check('活动更新：计时关闭时长置空', a1b.timed === false && a1b.durationSec === null);
check('活动更新：created_at 保留', a1b.created_at === a1.created_at);

// ---- 器材字典 ----
check('字典种子非空', store.listDict().length >= 8);
store.upsertDictItem({ eqId: 'TEST-CMP', eqName: '测试元件', category: '测试' });
check('字典新增', store.listDict().some((d) => d.eqId === 'TEST-CMP'));
store.removeDictItem('TEST-CMP');
check('字典删除', !store.listDict().some((d) => d.eqId === 'TEST-CMP'));
try { store.upsertDictItem({ eqId: '' }); check('字典空 eqId 拒绝', false); }
catch (e) { check('字典空 eqId 拒绝', /E-VAL-01/.test(String(e.message))); }

// ---- 导出包 ----
const pkg = store.exportPackage();
check('导出包：标记与版本', pkg.pkg === 'kct-preset-package' && pkg.schemaVersion === 1);
check('导出包：含 1 班级 1 活动', pkg.classes.length === 1 && pkg.activities.length === 1);
check('导出包：来源 preset-studio', pkg.source === 'preset-studio');
check('导出包：活动含计时配置', pkg.activities[0].timed === false && pkg.activities[0].durationSec === null);

// ---- 导入预演：本地较新跳过 / 新条目新增 / 包内更新覆盖 ----
store.upsertClass({ preset_id: 'CP-TEST01', name: '本地新版本', updated_at: Date.now() + 10000 });
const pkg2 = {
  pkg: 'kct-preset-package', schemaVersion: 1, exportedAt: T0,
  classes: [
    { presetId: 'CP-TEST01', name: '包内旧版本', totalSeats: 46, groupSize: 5, updatedAt: T0 }, // 本地较新 → skipped
    { presetId: 'CP-NEW001', name: '初二(3)班', totalSeats: 46, groupSize: 5, updatedAt: T0 },  // 新增
  ],
  activities: [
    { presetId: 'AP-TEST01', name: '包内更新活动', category: null, equipment: [], taskTemplates: [], timed: false, updatedAt: Date.now() + 5000 }, // 覆盖
  ],
};
const prev = store.previewImport(pkg2);
check('预演：本地较新 → skipped', prev.items.find((i) => i.presetId === 'CP-TEST01').action === 'skipped');
check('预演：新班级 → added', prev.items.find((i) => i.presetId === 'CP-NEW001').action === 'added');
check('预演：活动 → updated', prev.items.find((i) => i.presetId === 'AP-TEST01').action === 'updated');
check('预演：不落库', !store.getClass('CP-NEW001'));
const ret = store.commitImport(pkg2);
check('提交：摘要正确', ret.added === 1 && ret.updated === 1 && ret.skipped === 1);
check('提交：本地较新班级未被覆盖', store.getClass('CP-TEST01').name === '本地新版本');
check('提交：新班级已入库', store.getClass('CP-NEW001').name === '初二(3)班');
check('提交：活动被包内版本覆盖', store.getActivity('AP-TEST01').name === '包内更新活动');
const createdKeep = store.getClass('CP-NEW001').created_at;
store.upsertClass({ preset_id: 'CP-NEW001', name: '初二(3)班', updated_at: T0 });
check('提交：created_at 保留', store.getClass('CP-NEW001').created_at === createdKeep);

// ---- 坏包 ----
try { store.previewImport({ pkg: 'junk' }); check('坏包拒绝', false); }
catch (e) { check('坏包拒绝（E-PKG-01）', /E-PKG-01/.test(String(e.message))); }

// ---- 持久化 ----
const store2 = createStore(DATA);
check('持久化：重开文件数据仍在', store2.getClass('CP-NEW001') !== null && store2.listClasses().length === 2);

fs.unlinkSync(DATA);
console.log('\nPreset Studio 本地库验证：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
