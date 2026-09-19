'use strict';
// =============================================================================
// 锁定策略 sync 完整性 + 判定表回归（教师端）
//
// 现场事故（"发布活动后学生机无法解锁、大屏操作集体失效"）两个教师侧根因：
//   1) setPolicy 的"双保险"逐生下发仅 { policy } 的残缺 sync —— 学生端把 sync 当
//      完整权威状态，全班被打回待课页、登记被回滚。契约：双保险 sync 必须由
//      sync.service.buildSyncPayload 构造（全字段完整包，与 hello 应答同源）。
//   2) computePolicy 只认 timed+running —— 发布**非计时**活动后学生被锁死。
//      修复判定：未结束的非计时活动 / 计时 running|paused 都算"活动期间"。
// 运行：DB_PATH 自动指向临时库，真实 db 层 + 桩 bridge/sse。
// =============================================================================
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}

const DBP = path.join(os.tmpdir(), 'rt-policy-sync-' + Date.now() + '.db');
process.env.DB_PATH = DBP;
const db = require('../src/db');
db.init();
const bridge = require('../src/mqtt/bridge');
const sse = require('../src/sse');

// 桩：不真连 MQTT/SSE，只捕获
const syncs = [];
const cmds = [];
bridge.publishSync = async (seat, payload) => { syncs.push({ seat, payload }); return {}; };
bridge.publishCommand = (action, p) => { cmds.push({ action, p }); return { delivered: true }; };
sse.publish = () => {};

const policy = require('../src/services/policy.service');

const NOW = Date.now();
db.createSession({
  session_id: 's-pol', teacher: '张老师', class_name: '初二(3)班',
  start_time: NOW, end_time: null, phase: 'task', total_seats: 5,
  export_flag: 0, topic_plan: 'B', class_preset_id: null, activity_preset_id: null,
  activity_name: null, equipment_json: JSON.stringify([{ eqId: 'e1', eqName: '开发板', category: '主控' }]),
  terminal_count: null, group_members: null, policy_mode: 'activity',
});
db.upsertStudent({ sessionId: 's-pol', seat: '01', groupId: '1' });
db.upsertStudent({ sessionId: 's-pol', seat: '02', groupId: '1' });
db.recordCheckin({ sessionId: 's-pol', seat: '01', groupId: '1', name: '测试', studentNo: null,
  machineId: 'M-TEST', checkinTime: NOW, equipments: [], role: 'leader' });

function mkTask(taskId, timed, timerState, withClose) {
  db.createTask({
    sessionId: 's-pol', taskId, title: '活动' + taskId, desc: null, publishTime: NOW,
    source: 'custom', activityPresetId: null,
    timed: timed ? 1 : 0, durationSec: timed ? 600 : null,
    timerState: timed ? timerState : 'idle',
    timerStartedAt: timed ? NOW : null, timerPausedAt: null, timerRemainingMs: null,
  });
  if (withClose) db.closeTask(taskId, NOW);
}

const sess = () => db.getSession('s-pol');

console.log('-- 教师端 锁定策略判定表 policy-judge');

// ---- J. 判定表（activity 模式，task 阶段）----
mkTask('t-untimed', false, 'idle', false);
check('J1 发布非计时（开放中）活动 → 不锁（曾锁死，现场事故）',
  policy.computePolicy(sess()).locked === false,
  JSON.stringify(policy.computePolicy(sess())));

mkTask('t-run', true, 'running', false);
check('J2 计时活动进行中 → 不锁', policy.computePolicy(sess()).locked === false);

db.updateTaskTimer('t-run', { timer_state: 'paused', timer_remaining_ms: 60000 });
check('J3 计时活动暂停中 → 仍算活动期间，不锁', policy.computePolicy(sess()).locked === false);

db.updateTaskTimer('t-run', { timer_state: 'expired', timer_remaining_ms: 0 });
check('J4 当前活动已截止 → 锁（早前遗留的开放任务不算活动期间，smoke 7.6 语义）',
  policy.computePolicy(sess()).locked === true,
  JSON.stringify(policy.computePolicy(sess())));

mkTask('t-run2', true, 'running', false);
db.closeTask('t-run2', NOW);
check('J5 当前活动被结束后 → 锁（结束活动自动回锁）',
  policy.computePolicy(sess()).locked === true,
  JSON.stringify(policy.computePolicy(sess())));

// ---- S. setPolicy 双保险 sync 必须是全字段完整包 ----
const FULL_KEYS = ['sessionId', 'phase', 'currentTask', 'checkinDone', 'returnDone', 'equipment', 'policy'];
function completeness(p) { return { ok: FULL_KEYS.every((k) => k in p), missing: FULL_KEYS.filter((k) => !(k in p)) }; }

syncs.length = 0;
const ret = policy.setPolicy('s-pol', 'open');
check('S1 setPolicy 返回结构完整', ret && ret.mode === 'open' && ret.locked === false, JSON.stringify(ret));
check('S2 双保险 sync 逐生下发（01/02 各一条）',
  syncs.length === 2 && syncs.every((s) => ['01', '02'].includes(s.seat)),
  JSON.stringify(syncs.map((s) => s.seat)));
check('S3 双保险 sync 是全字段完整包（残缺包会把学生打回待课页）',
  syncs.every((s) => completeness(s.payload).ok),
  JSON.stringify(syncs.map((s) => completeness(s.payload).missing)));
check('S4 完整包携带权威业务字段（座位 01 已登记=true / 活动卡 / 器材清单）',
  syncs.every((s) => s.payload.phase === 'task'
    && (s.payload.seatMark = 1) !== null
    && syncs[0].payload.checkinDone === true
    && syncs[0].payload.equipment && syncs[0].payload.equipment.length === 1),
  JSON.stringify(syncs[0] && syncs[0].payload && syncs[0].payload.checkinDone));
check('S5 cmd policy 广播仍在（双保险之外的正式通道）',
  cmds.some((c) => c.action === 'policy' && c.p.locked === false), JSON.stringify(cmds));

// ---- R. 反向对照：残缺包必须被完整性检查器检出；源码禁止回归到 { policy } 直发 ----
{
  const old = { policy: { mode: 'open', locked: false } };
  check('R1 反向·旧残缺包 { policy } 被完整性检查器检出', !completeness(old).ok,
    JSON.stringify(completeness(old).missing));
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'policy.service.js'), 'utf8');
  check('R2 源码·setPolicy 双保险经 buildSyncPayload 构造（唯一真源）',
    /buildSyncPayload/.test(src) && !/publishSync\(st\.seat,\s*\{\s*policy\s*\}\)/.test(src));
  const bad = src.replace(/bridge\.publishSync\(st\.seat,\s*buildSyncPayload\(fresh, st\.seat\)\);/,
    'bridge.publishSync(st.seat, { policy });');
  check('R3 反向·成功把双保险改回残缺包', bad !== src);
  check('R4 反向·改回后被静态断言检出（复现现场事故写法）',
    /publishSync\(st\.seat,\s*\{\s*policy\s*\}\)/.test(bad));
}

try { fs.rmSync(DBP, { force: true }); fs.rmSync(DBP + '-wal', { force: true }); fs.rmSync(DBP + '-shm', { force: true }); } catch (_e) { /* noop */ }

console.log('-- 锁定策略判定表+sync完整性 总结: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
