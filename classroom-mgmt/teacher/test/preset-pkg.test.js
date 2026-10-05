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

// ---- 6) v5.2 课时包：lessons 协议校验 + 导入落库 + 导出带出 + 开课快照 ----
// 桥接打桩：单测环境不开 MQTT（startSession 内 publishCommand 不触碰真实 broker）
const bridgeId = require.resolve('../src/mqtt/bridge');
require.cache[bridgeId] = {
  id: bridgeId, filename: bridgeId, loaded: true,
  exports: {
    publishCommand: async () => ({ delivered: false }), publishSync: async () => ({}), publish: async () => ({ delivered: false }),
    setMessageHandler() {}, setOnStateChange() {}, getState() { return { state: 'offline' }; }, isOnline: () => false,
    CMD_BROADCAST: 'siot/ict_cmd', STU_UP: 'siot/ict_up', STU_HB: 'siot/ict_hb', SYNC: 'siot/ict_sync',
  },
};
const sessionSvc = require('../src/services/session.service');

// 6a 协议：带 lessons 的班级通过校验；坏 lessons 被拒
const lsPkg = presetPkg.buildPackage({
  classes: [{
    presetId: 'CP-LS001', name: '课时测试班', totalSeats: 40, groupSize: 5, updatedAt: T0,
    lessons: [{ lessonId: 'L-AAA0001', name: '第1课 点亮LED', activityIds: ['AP-LSX1'],
      equipment: [{ eqId: 'LED', eqName: 'LED灯', category: '元件', preset: 2 }] }],
  }],
  activities: [{
    presetId: 'AP-LSX1', name: '点亮LED', updatedAt: T0,
    equipment: [{ eqId: 'LED', eqName: 'LED灯', category: '元件', preset: 1 }],
    taskTemplates: [{ title: '点亮第一颗灯', desc: '接面包板' }],
  }],
});
check('lessons: 带课时包通过校验', presetPkg.validatePackage(lsPkg).length === 0, JSON.stringify(presetPkg.validatePackage(lsPkg)));
const lsBad = { pkg: presetPkg.PKG_MARK, schemaVersion: 1,
  classes: [{ presetId: 'CP-LS002', name: 'x', totalSeats: 40, groupSize: 5, lessons: [{ name: '' }] }], activities: [] };
check('lessons: 空课时名被拒绝', presetPkg.validatePackage(lsBad).length > 0);

// 6b 导入落库：lessons 随班级写入
presetPkgSvc.commitImport(lsPkg);
const lsCls = presetSvc.getClass('CP-LS001');
check('lessons: 导入后班级含 1 课时', !!lsCls && lsCls.lessons.length === 1, JSON.stringify(lsCls && lsCls.lessons));
check('lessons: 课时结构完整（id/活动引用/器材）', !!lsCls && lsCls.lessons[0].lessonId === 'L-AAA0001'
  && lsCls.lessons[0].activityIds[0] === 'AP-LSX1' && lsCls.lessons[0].equipment[0].preset === 2);

// 6c 导出带出：教师端再导出不丢课时（对照 9/11 事故：lessons 曾被静默丢弃）
const lsExport = presetPkgSvc.exportPackage().classes.find((c) => c.presetId === 'CP-LS001');
check('lessons: 导出包携带课时', !!lsExport && lsExport.lessons && lsExport.lessons.length === 1);

// 6d 开课快照：lessonId → 器材合并 + 课时活动模板 + 会话快照
const started = sessionSvc.startSession({ teacher: '测试老师', classPresetId: 'CP-LS001', lessonId: 'L-AAA0001' });
check('开课：会话带课时快照', !!started.session.lesson && started.session.lesson.lessonId === 'L-AAA0001'
  && started.session.lesson.name === '第1课 点亮LED');
check('开课：课时器材并入下发清单', started.equipment.some((e) => e.eqId === 'LED' && e.preset === 2),
  JSON.stringify(started.equipment));
check('开课：任务模板来自课时活动', started.taskTemplates.length === 1 && started.taskTemplates[0].title === '点亮第一颗灯',
  JSON.stringify(started.taskTemplates));
check('开课：返回课时名', started.lessonName === '第1课 点亮LED');
// 6e 错误路径：班级下不存在该课时
try {
  sessionSvc.startSession({ teacher: '测试老师', classPresetId: 'CP-LS001', lessonId: 'L-NOPE' });
  check('开课：未知课时被拒绝', false, '未抛错');
} catch (e) {
  check('开课：未知课时被拒绝（E-NOTFOUND）', e.errorCode === 'E-NOTFOUND' || /E-NOTFOUND/.test(String(e.errorCode || e.message || e.code || '')), String(e.errorCode || e.message));
}

// ---- 7) v5.6 应用包：独立应用清单，校验 + 导入落库 + 导出带出 + 开课快照 + sync appNames ----
const appSetSvc = require('../src/services/appset.service');
const syncSvc = require('../src/services/sync.service');

// 7a 协议：带 appSets 的包通过校验；坏 appSets（空名 / 非数组 / 空应用项）被拒
const asPkg = presetPkg.buildPackage({
  classes: [],
  activities: [],
  appSets: [{ appSetId: 'AS-TEST0001', name: '焊接课套件', apps: ['Arduino IDE', '串口调试助手'], updatedAt: T0 }],
});
check('appsets: 纯应用包通过校验', presetPkg.validatePackage(asPkg).length === 0, JSON.stringify(presetPkg.validatePackage(asPkg)));
const asBad1 = { pkg: presetPkg.PKG_MARK, schemaVersion: 1, classes: [], activities: [],
  appSets: [{ appSetId: 'AS-BAD1', name: '', apps: ['X'] }] };
check('appsets: 空包名被拒绝', presetPkg.validatePackage(asBad1).length > 0);
const asBad2 = { pkg: presetPkg.PKG_MARK, schemaVersion: 1, classes: [], activities: [],
  appSets: [{ appSetId: 'AS-BAD2', name: 'x', apps: ['OK', '  '] }] };
check('appsets: 空应用名被拒绝', presetPkg.validatePackage(asBad2).length > 0);
const asBad3 = { pkg: presetPkg.PKG_MARK, schemaVersion: 1, classes: [], activities: [], appSets: [{ appSetId: 'AS-BAD3', name: 'x' }] };
check('appsets: 缺 apps 字段不拒绝（导入侧再校验）', presetPkg.validatePackage(asBad3).length === 0);

// 7b 导入落库 + 服务侧校验
presetPkgSvc.commitImport(asPkg);
const asGot = appSetSvc.listAppSets().find((s) => s.appSetId === 'AS-TEST0001');
check('appsets: 导入后可查询且应用名完整', !!asGot && asGot.apps.length === 2 && asGot.apps[0] === 'Arduino IDE',
  JSON.stringify(asGot));
try {
  appSetSvc.upsertAppSets([{ appSetId: 'AS-BADVAL', name: '坏包', apps: [] }]);
  check('appsets: 服务侧拒绝空应用清单', false, '未抛错');
} catch (e) {
  check('appsets: 服务侧拒绝空应用清单（E-VAL-01）', /E-VAL-01/.test(String(e.errorCode || e.message)), String(e.errorCode || e.message));
}

// 7c 导出带出：教师端再导出不丢应用包
const asExport = presetPkgSvc.exportPackage().appSets || [];
check('appsets: 导出包携带应用包', asExport.some((s) => s.appSetId === 'AS-TEST0001' && s.apps.length === 2));

// 7d 开课快照：appSetId → 会话快照 + sync 下发 appNames
const startedAs = sessionSvc.startSession({ teacher: '测试老师', appSetId: 'AS-TEST0001' });
check('开课：会话带应用包快照', !!startedAs.session.appSet && startedAs.session.appSet.appSetId === 'AS-TEST0001'
  && startedAs.session.appSet.apps.length === 2, JSON.stringify(startedAs.session.appSet));
check('开课：返回应用包名', startedAs.appSetName === '焊接课套件');
const syncPayload = syncSvc.buildSyncPayload(db.getSession(startedAs.session.sessionId), '01');
check('sync：payload 含 appNames 且为应用名列表', Array.isArray(syncPayload.appNames)
  && syncPayload.appNames.length === 2 && syncPayload.appNames[0] === 'Arduino IDE',
  JSON.stringify(syncPayload.appNames));

// 7e 错误路径：未知 appSetId
try {
  sessionSvc.startSession({ teacher: '测试老师', appSetId: 'AS-NOPE' });
  check('开课：未知应用包被拒绝', false, '未抛错');
} catch (e) {
  check('开课：未知应用包被拒绝（E-NOTFOUND）', e.errorCode === 'E-NOTFOUND' || /E-NOTFOUND/.test(String(e.errorCode || e.message || e.code || '')), String(e.errorCode || e.message));
}

// ---- 清理测试数据 ----
presetSvc.removeClass(c1.presetId); presetSvc.removeClass(c2.presetId);
presetSvc.removeClass('CP-NEW001'); presetSvc.removeClass('CP-LS001');
presetSvc.removeActivity(a1.presetId); presetSvc.removeActivity(a2.presetId); presetSvc.removeActivity('AP-NEW001');
presetSvc.removeActivity('AP-LSX1');
db.S().remove('t_app_set', {}); // v5.6 应用包测试数据一并清理
db.close();

console.log('\n预设包协议验证：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
