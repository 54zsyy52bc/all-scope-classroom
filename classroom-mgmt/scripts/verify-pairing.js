'use strict';
// =============================================================================
// 师生端交互闭环回归验证（v4.2.1 修复项）
// 不依赖任何第三方包（mqtt/better-sqlite3 以桩替身 + JSON 存储降级），
// 直接驱动真实 teacher 服务端逻辑，模拟两处断链缺陷的完整闭环：
//   S1 登记超范围座位（学生端原"登记未被接受"死锁）→ 教师端收告警 → 一键激活扩容 → 学生重提成功
//   S2 归还后仍需使用（学生端"还要用电脑请举手"死锁）→ 教师端撤销关机广播 → 学生端中止倒计时
// 另回归既有正常路径：登记/归还/幂等。
//
// 运行：node classroom-mgmt/scripts/verify-pairing.js
// =============================================================================
const path = require('path');
const os = require('os');
const assert = require('assert');

// 用临时 JSON 库，避免污染仓库 classroom.db
process.env.DB_PATH = path.join(os.tmpdir(), `cr-verify-${process.pid}.db`);
process.env.LOG_LEVEL = 'error';

const Module = require('module');
const origLoad = Module._load;
const topics = require(path.join(__dirname, '..', 'shared', 'topics'));

// ---- mqtt 桩：FakeClient 记录所有下行发布 ----
class FakeClient {
  constructor() { this.handlers = {}; this.calls = []; }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
  emit(ev, ...a) { (this.handlers[ev] || []).forEach((f) => f(...a)); }
  publish(topic, payload, opts, cb) { this.calls.push({ topic, payload }); if (cb) cb(null); return this; }
  subscribe() { return this; }
  end() { this.ended = true; }
}
const fakeClient = new FakeClient();
Module._load = function (request, parent, isMain) {
  if (request === 'mqtt') {
    return {
      connect: () => {
        // 模拟 broker 握手成功：等 bridge 挂好监听后再广播 connect
        setImmediate(() => fakeClient.emit('connect'));
        return fakeClient;
      },
    };
  }
  return origLoad.apply(this, arguments);
};

// ---- 装载真实服务端模块 ----
const db = require(path.join(__dirname, '..', 'teacher', 'src', 'db'));
const sse = require(path.join(__dirname, '..', 'teacher', 'src', 'sse'));
const bridge = require(path.join(__dirname, '..', 'teacher', 'src', 'mqtt', 'bridge'));
const handlers = require(path.join(__dirname, '..', 'teacher', 'src', 'mqtt', 'handlers'));
const commandSvc = require(path.join(__dirname, '..', 'teacher', 'src', 'services', 'command.service'));
const sessionSvc = require(path.join(__dirname, '..', 'teacher', 'src', 'services', 'session.service'));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed += 1; console.log('  PASS  ' + name); }
  else { failed += 1; console.log('  FAIL  ' + name); }
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function sseSeen(event, pred) {
  return new Promise((resolve) => {
    const bus = sse.bus;
    const h = (payload) => { if (!pred || pred(payload)) { bus.removeListener(event, h); resolve(payload); } };
    bus.on(event, h);
    setTimeout(() => { bus.removeListener(event, h); resolve(null); }, 800);
  });
}

function downlinkCalls() {
  return fakeClient.calls.map((c) => { try { return JSON.parse(c.payload); } catch (_e) { return null; } }).filter(Boolean);
}

function dispatchEnvelope(type, fields, msgId) {
  const env = topics.makeEnvelope(Object.assign({ type, msgId: msgId || topics.genId() }, fields));
  handlers.dispatch('siot/ict_up', Buffer.from(JSON.stringify(env)));
}

(async function main() {
  console.log('\n=== 师生端交互闭环回归（v4.2.1）===\n');
  const init = db.init();
  check('存储初始化（JSON 降级可用）', init.mode === 'json' || init.mode === 'sqlite');

  // 造一个 30 座的课堂
  const started = sessionSvc.startSession({ teacher: '王老师', className: '初二1班', totalSeats: 30 });
  const sid = started.session.sessionId;
  check('开课：30 座会话创建', started.session && started.session.totalSeats === 30);

  bridge.connect();
  await sleep(60); // 等 FakeClient 'connect' 事件把状态置 online
  check('MQTT 桥接（桩）在线', bridge.isOnline());

  // ---------- 场景 S1：登记超范围座位 → 教师告警 → 激活 → 重提成功 ----------
  console.log('\n[S1] 座位超范围登记闭环');
  const s1Alert = sseSeen('seat.outofrange', (p) => p.seat === '35');
  dispatchEnvelope('checkin', { seat: '35', machineId: 'M-STU-35', payload: { name: '李雷', equipments: [{ eqId: 'LED', qty: 2 }] } });
  const alert = await s1Alert;
  check('教师端收到 seat.outofrange 告警（座位35）', !!(alert && alert.seat === '35'));
  check('超范围登记不落库（seat35 无学生行）', db.getStudent(sid, '35') == null);

  const notice = downlinkCalls().find((c) => c.payload && c.payload.action === 'notice' && String(c.payload.seat) === '35');
  check('学生端收到定向 notice（提示请老师激活）', !!(notice && /激活/.test(notice.payload.message)));

  const admitted = await commandSvc.sendAdmit({ seat: '35' });
  check('教师一键激活：扩容至 35 座', !!(admitted && admitted.admitted === true && admitted.totalSeats === 35));
  check('扩容后补种了座位 35（待登记）', !!(db.getStudent(sid, '35') && db.getStudent(sid, '35').checkin_status === 'pending'));

  const s1Ok = sseSeen('student.checkin', (p) => p.seat === '35');
  dispatchEnvelope('checkin', { seat: '35', machineId: 'M-STU-35', payload: { name: '李雷', equipments: [{ eqId: 'LED', qty: 2 }] } });
  await s1Ok;
  const st35 = db.getStudent(sid, '35');
  check('学生重提成功：座位35 登记完成', !!(st35 && st35.checkin_status === 'done' && st35.name === '李雷'));

  // ---------- 场景 S2：归还后继续使用 → 教师撤销关机 ----------
  console.log('\n[S2] 归还后继续使用闭环');
  dispatchEnvelope('checkin', { seat: '07', machineId: 'M-STU-07', payload: { name: '韩梅梅' } });
  await sleep(60);
  dispatchEnvelope('return', { seat: '07', machineId: 'M-STU-07', payload: { allReturned: true } });
  await sleep(80);
  check('正常归还：座位07 return_status=done', (db.getStudent(sid, '07') || {}).return_status === 'done');

  const cancel = await commandSvc.cancelShutdown();
  check('教师端撤销关机：广播 delivered', !!(cancel && cancel.broadcast && cancel.broadcast.delivered === true));
  const cancelCmd = downlinkCalls().find((c) => c.payload && c.payload.action === 'shutdown_cancel');
  check('学生端收到 shutdown_cancel 指令（中止倒计时）', !!cancelCmd);
  const evt = db.queryEvents(sid, { type: 'shutdown_cancel', limit: 10 }).items;
  check('撤销关机事件已落库审计', evt.length >= 1);

  // ---------- 回归：既有正常路径 / 幂等 ----------
  console.log('\n[回归] 正常路径与幂等');
  // 同一 msgId 重复上报：第二次必须被幂等忽略（用干净座位 09 验证，姓名不被覆盖）
  const DUP = 'dup-checkin-09';
  dispatchEnvelope('checkin', { seat: '09', machineId: 'M-STU-09', payload: { name: '甲同学' } }, DUP);
  await sleep(60);
  dispatchEnvelope('checkin', { seat: '09', machineId: 'M-STU-09', payload: { name: 'Z冒牌' } }, DUP);
  await sleep(60);
  const st09 = db.getStudent(sid, '09');
  const dupRows = db.S().find('t_event_log', { msg_id: DUP });
  check('同一 msgId 重复登记被幂等忽略（姓名不被覆盖，事件仅 1 条）', !!(st09 && st09.name === '甲同学' && dupRows.length === 1));
  const conflicts = db.queryConflicts();
  const badConflicts = conflicts.filter((c) => (c.seat === '35' || c.seat === '07' || c.seat === '09') && (c.machineIds || []).length > 1);
  check('冲突表无异常（各座位单机不误报冲突）', badConflicts.length === 0);

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('验证脚本异常:', e);
  process.exit(1);
});
