'use strict';
// =============================================================================
// 报文契约测试：用学生端真实的信封工厂（shared/topics.js）造包，灌进教师端真实的
// handlers.dispatch()，验证「学生发出去的每一个字节教师端都能吃下去」。
//
// 做法：用 Module._load 拦截把 handlers.js 的 db / sse / bridge / command.service /
// config 换成桩（utils 用真的，HMAC 必须逐字对齐），业务解析逻辑一行不改。
// 这样教师端改了解析规则，这个测试会直接红，而不是等到 40 台机器联调才发现。
//
// 不需要 broker，任何时候都能跑：node student/test/protocol.test.js
// =============================================================================
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..', '..');
const TEACHER_SRC = path.join(ROOT, 'teacher', 'src');
const TOPICS = require(path.join(ROOT, 'shared', 'topics.js'));

const MACHINE_ID = 'M-1a2b3c4d';
const SESSION = { session_id: 'S-20260831-TEST0001', phase: 'checkin' };
const SECRET = 'unit-test-secret';

const calls = [];
function spy(name, ret) {
  return function () {
    calls.push({ name, args: Array.prototype.slice.call(arguments) });
    return typeof ret === 'function' ? ret.apply(null, arguments) : ret;
  };
}
function callsOf(name) {
  return calls.filter((c) => c.name === name);
}
function lastOf(name) {
  const list = callsOf(name);
  return list.length ? list[list.length - 1].args : null;
}

// ---------------------------------------------------------------------------
// 桩：按 handlers.js 的实际 require 路径替换
// ---------------------------------------------------------------------------
const dbStub = {
  // handlers 把「事件标记 + 业务写入」包进事务，这里用立即执行模拟提交
  transaction: (fn) => fn(),
  getCurrentSession: () => SESSION,
  // 外键守卫：任务必须真实存在且属于当前会话（handlers 的 E-REF-01 分支）
  getTask: (taskId) => (taskId === 'T-ABC12345'
    ? { task_id: taskId, session_id: SESSION.session_id }
    : null),
  insertEvent: spy('insertEvent', () => ({ inserted: true, id: 1 })),
  recordCheckin: spy('recordCheckin'),
  upsertTaskStatus: spy('upsertTaskStatus'),
  recordReturn: spy('recordReturn'),
  touchSeat: spy('touchSeat'),
  upsertConflict: () => ({ isConflict: false }),
  queryConflicts: () => [],
  queryStudents: () => ({ items: [] }),
  queryEquipment: () => [],
  listTasks: () => [],
  listTaskStatuses: () => [],
  getStudent: () => null,
};
const sseStub = { publish: spy('sse.publish') };
const bridgeStub = { publishSync: spy('bridge.publishSync'), CMD_BROADCAST: TOPICS.CMD_BROADCAST };
const commandStub = { autoShutdown: spy('autoShutdown', () => Promise.resolve()) };
const configStub = { GROUP_SIZE: 5, OFFLINE_THRESHOLD_MS: 45000, HMAC_SECRET: SECRET, HMAC_WINDOW_MS: 60000 };

function resolveFrom(request, parentDir) {
  const base = path.resolve(parentDir, request);
  const cands = [base, base + '.js', path.join(base, 'index.js')];
  for (const c of cands) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

const STUBS = new Map();
STUBS.set(path.join(TEACHER_SRC, 'db', 'index.js'), dbStub);
STUBS.set(path.join(TEACHER_SRC, 'sse.js'), sseStub);
STUBS.set(path.join(TEACHER_SRC, 'mqtt', 'bridge.js'), bridgeStub);
STUBS.set(path.join(TEACHER_SRC, 'services', 'command.service.js'), commandStub);
STUBS.set(path.join(TEACHER_SRC, 'config.js'), configStub);
// teacher/src/utils.js 故意不桩：HMAC 必须用真实实现比对

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename) {
    const resolved = resolveFrom(request, path.dirname(parent.filename));
    if (resolved && STUBS.has(resolved)) return STUBS.get(resolved);
  }
  return origLoad.apply(this, arguments);
};

const handlers = require(path.join(TEACHER_SRC, 'mqtt', 'handlers.js'));
const utils = require(path.join(TEACHER_SRC, 'utils.js'));

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    // eslint-disable-next-line no-console
    console.log('  PASS  ' + name);
  } catch (e) {
    failures.push({ name, message: e.message });
    // eslint-disable-next-line no-console
    console.log('  FAIL  ' + name + ' -> ' + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）');
  }
}

// 学生端 app.js 里 sendUp() 的等价构造（参数顺序与取值必须与 app.js 保持一致）
function up(type, payload, seat) {
  return TOPICS.makeEnvelope({
    type,
    seat: seat || '07',
    group: '*',
    machineId: MACHINE_ID,
    payload: payload || {},
  });
}
function dispatchUp(env) {
  return handlers.dispatch(TOPICS.STU_UP, Buffer.from(JSON.stringify(env)));
}

// eslint-disable-next-line no-console
console.log('\n[1] 上行报文契约（学生 -> 教师）');

check('checkin：姓名/座位/器材被教师端完整接收', () => {
  calls.length = 0;
  const env = up('checkin', {
    name: '陈书瑶',
    studentNo: '2024070312',
    equipments: [{ eqId: 'DEV-BOARD', qty: 1 }, { eqId: 'DUPONT', qty: 5 }],
  });
  eq(env.seat, '07', '座位号未补零成两位');
  eq(env.machineId, MACHINE_ID, 'machineId 未写到信封顶层');
  eq(env.payload.machineId, MACHINE_ID, 'machineId 未同步写入 payload');
  dispatchUp(env);
  const a = lastOf('recordCheckin');
  assert(a, 'recordCheckin 未被调用');
  eq(a[0].seat, '07', '座位号错');
  eq(a[0].name, '陈书瑶', '姓名错');
  eq(a[0].machineId, MACHINE_ID, 'machineId 丢失');
  eq(a[0].equipments.length, 2, '器材条目数错');
  eq(a[0].equipments[1].qty, 5, '器材数量错');
});

check('task：doing / done / help 三种状态都能入库', () => {
  for (const status of ['doing', 'done', 'help']) {
    calls.length = 0;
    dispatchUp(up('task', { taskId: 'T-ABC12345', status }));
    const a = lastOf('upsertTaskStatus');
    assert(a, status + ' 未调用 upsertTaskStatus');
    eq(a[0].status, status, '状态错');
    eq(a[0].seat, '07', '座位号错');
    eq(a[0].taskId, 'T-ABC12345', 'taskId 错');
  }
});

check('task：非法 status 被教师端拒绝（E-VAL-01 不写库）', () => {
  calls.length = 0;
  dispatchUp(up('task', { taskId: 'T-ABC12345', status: 'almost' }));
  eq(callsOf('upsertTaskStatus').length, 0, '非法状态竟然入库了');
});

check('task：缺 taskId 被拒绝', () => {
  calls.length = 0;
  dispatchUp(up('task', { status: 'done' }));
  eq(callsOf('upsertTaskStatus').length, 0, '缺 taskId 竟然入库了');
});

check('task：任务不存在 / 不属于当前会话被拒绝（E-REF-01）', () => {
  calls.length = 0;
  dispatchUp(up('task', { taskId: 'T-幽灵任务', status: 'done' }));
  eq(callsOf('upsertTaskStatus').length, 0, '不存在的任务竟然入库了');
  eq(callsOf('insertEvent').length, 0, '非法报文不该占用 msg_id');
});

check('return：归还记录入库并触发自动关机检查', () => {
  calls.length = 0;
  dispatchUp(up('return', { note: '开发板 USB 口松动', allReturned: true }));
  assert(lastOf('recordReturn'), 'recordReturn 未被调用');
  eq(callsOf('autoShutdown').length, 1, '未触发 autoShutdown');
});

check('hello：教师端回 sync 且回包 seat 与本座位一致', () => {
  calls.length = 0;
  dispatchUp(up('hello', { phase: 'checkin' }));
  const a = lastOf('bridge.publishSync');
  assert(a, 'publishSync 未被调用');
  eq(a[0], '07', 'sync 回包座位号错（学生端靠这个过滤非自己的广播）');
});

check('status 心跳：刷新 last_seen_at（教师端据此判在线）', () => {
  calls.length = 0;
  const env = up('status', { online: true, phase: 'task' });
  handlers.dispatch(TOPICS.STU_HB, Buffer.from(JSON.stringify(env)));
  const a = lastOf('touchSeat');
  assert(a, 'touchSeat 未被调用');
  eq(a[0], SESSION.session_id, 'sessionId 错');
  eq(a[1], '07', '座位号错');
});

check('重复 msgId 被幂等忽略（重连重发不产生脏数据）', () => {
  calls.length = 0;
  dbStub.insertEvent = () => ({ inserted: false });
  dispatchUp(up('checkin', { name: '重复提交' }));
  eq(callsOf('recordCheckin').length, 0, '重复 msgId 竟然写了库');
  dbStub.insertEvent = spy('insertEvent', () => ({ inserted: true, id: 1 }));
});

// eslint-disable-next-line no-console
console.log('\n[2] 下行指令解析（教师 -> 学生，按 command.service 的实际输出）');

check('shutdown 票据：教师端签名 == 学生端主进程校验算法', () => {
  const sessionId = SESSION.session_id;
  const ts = Date.now();
  const teacherToken = utils.signToken(SECRET, sessionId, ts);
  // 学生端 main.js hmac() 的等价实现（必须逐字一致，否则永远校验不过）
  const studentToken = crypto.createHmac('sha256', SECRET)
    .update(`${sessionId}:${ts}`).digest('hex');
  eq(studentToken, teacherToken, 'HMAC 算法不一致，关机指令会被全部判为非法');
  assert(utils.verifyToken(SECRET, teacherToken, sessionId, ts, 60000), '票据在窗口内却校验失败');
});

check('shutdown 票据：超 60 秒窗口应判非法', () => {
  const sessionId = SESSION.session_id;
  const ts = Date.now() - 120000;
  const token = utils.signToken(SECRET, sessionId, ts);
  eq(utils.verifyToken(SECRET, token, sessionId, ts, 60000), false, '过期票据竟然通过了');
});

check('shutdown 票据：sessionId 不匹配应判非法', () => {
  const ts = Date.now();
  const token = utils.signToken(SECRET, SESSION.session_id, ts);
  eq(utils.verifyToken(SECRET, token, 'S-00000000-OTHER', ts, 60000), false, '跨会话票据竟然通过了');
});

check('reset 指令：payload.seat 为两位数字字符串，学生端按座位比对', () => {
  const env = TOPICS.makeCommand({ action: 'reset', payload: { seat: '07' } });
  eq(env.type, 'cmd', 'type 错');
  eq(env.payload.action, 'reset', 'action 错');
  eq(env.payload.seat, '07', 'seat 错');
});

check('task 指令：payload.task 结构含 taskId / title / desc', () => {
  const env = TOPICS.makeCommand({
    action: 'task',
    payload: { task: { taskId: 'T-ABC12345', title: '点亮第一颗 LED', desc: '' } },
  });
  eq(env.payload.action, 'task', 'action 错');
  eq(env.payload.task.taskId, 'T-ABC12345', 'taskId 错');
  eq(env.payload.task.title, '点亮第一颗 LED', 'title 错');
});

check('sync 回包：phase / currentTask / checkinDone / returnDone 四字段齐全', () => {
  const env = TOPICS.makeSync({
    seat: '07',
    sessionId: SESSION.session_id,
    phase: 'task',
    currentTask: { taskId: 'T-ABC12345', title: '点亮第一颗 LED' },
    checkinDone: true,
    returnDone: false,
  });
  eq(env.type, 'sync', 'type 错');
  eq(env.seat, '07', 'seat 错（学生端靠它过滤）');
  eq(env.payload.phase, 'task', 'phase 错');
  eq(env.payload.checkinDone, true, 'checkinDone 错');
  eq(env.payload.returnDone, false, 'returnDone 错');
  eq(env.payload.currentTask.taskId, 'T-ABC12345', 'currentTask.taskId 错');
});

check('sync 回包：equipment 清单透传（迟到/重连学生恢复登记页）', () => {
  const env = TOPICS.makeSync({
    seat: '07',
    phase: 'checkin',
    equipment: [{ eqId: 'EQ-A', eqName: '特制模块', category: '主控', preset: 2 }],
  });
  eq(Array.isArray(env.payload.equipment), true, 'equipment 应为数组');
  eq(env.payload.equipment[0].eqId, 'EQ-A', 'eqId 错');
  eq(env.payload.equipment[0].preset, 2, 'preset 错');
});

check('cmd equipment：教师端下发器材清单信封', () => {
  const env = TOPICS.makeCommand({
    action: 'equipment',
    payload: {
      equipment: [{ eqId: 'EQ-A', eqName: '特制模块', category: '主控', preset: 2 }],
      activityName: '焊接入门',
    },
  });
  eq(env.payload.action, 'equipment', 'action 错');
  eq(env.payload.activityName, '焊接入门', 'activityName 错');
  eq(env.payload.equipment.length, 1, 'equipment 长度错');
  eq(env.payload.equipment[0].eqName, '特制模块', 'eqName 错');
});

check('cmd task_timer：计时控制信封（timerAction 不覆盖命令 action）', () => {
  const env = TOPICS.makeCommand({
    action: 'task_timer',
    payload: { taskId: 'T-X', timerAction: 'pause', remainingMs: 90000 },
  });
  eq(env.payload.action, 'task_timer', '命令 action 被覆盖（timerAction 冲突 bug 回归）');
  eq(env.payload.timerAction, 'pause', 'timerAction 错');
  eq(env.payload.remainingMs, 90000, 'remainingMs 错');
});

check('cmd policy：锁定策略信封', () => {
  const env = TOPICS.makeCommand({
    action: 'policy',
    payload: { mode: 'activity', locked: true, phase: 'task', reason: 'no-activity' },
  });
  eq(env.payload.action, 'policy', 'action 错');
  eq(env.payload.mode, 'activity', 'mode 错');
  eq(env.payload.locked, true, 'locked 错');
});

check('sync 回包：policy 透传（迟到/重连恢复锁定）', () => {
  const env = TOPICS.makeSync({
    seat: '07', phase: 'task',
    policy: { mode: 'activity', locked: true, phase: 'task', reason: 'no-activity' },
  });
  eq(env.payload.policy.locked, true, 'policy.locked 错');
  eq(env.payload.policy.mode, 'activity', 'policy.mode 错');
});

// eslint-disable-next-line no-console
console.log('\n结果：' + passed + ' 通过 / ' + failures.length + ' 失败');
if (failures.length) {
  for (const f of failures) {
    // eslint-disable-next-line no-console
    console.log('  - ' + f.name + ' : ' + f.message);
  }
  process.exit(1);
}
