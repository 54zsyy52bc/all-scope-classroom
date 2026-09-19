'use strict';
// =============================================================================
// 「退出课堂」教师端回归：exit 落库 + exited 标记 + sync 待课空态 + 自动回归
//
// 学生端浮窗「退出课堂」上行 exit 报文后：
//   * 教师端落 t_event_log（msg_id 幂等）+ t_student.exited=1 + SSE student.exited；
//   * 该座位之后的 sync（hello 应答/策略双保险共用 buildSyncPayload）一律回
//     「待课空态」：phase=idle、无活动、登记/归还=false、policy=open ——
//     否则双保险 sync 会把已退出的学生立刻拽回课中（退出形同虚设）；
//   * 回归路径：重新 hello（重进课堂页）/ 重新登记 / 上报任务状态 → 自动清标记。
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

const DBP = path.join(os.tmpdir(), 'rt-exit-sync-' + Date.now() + '.db');
process.env.DB_PATH = DBP;
const db = require('../src/db');
db.init();
const bridge = require('../src/mqtt/bridge');
const sse = require('../src/sse');

const syncs = [];
const events = [];
bridge.publishSync = async (seat, payload) => { syncs.push({ seat, payload }); return {}; };
bridge.publishCommand = () => ({ delivered: true });
sse.publish = (ev, p) => { events.push({ ev, p }); };

const handlers = require('../src/mqtt/handlers');
const { buildSyncPayload } = require('../src/services/sync.service');

const NOW = Date.now();
db.createSession({
  session_id: 's-exit', teacher: '张老师', class_name: '初二(3)班',
  start_time: NOW, end_time: null, phase: 'task', total_seats: 5,
  export_flag: 0, topic_plan: 'B', class_preset_id: null, activity_preset_id: null,
  activity_name: null, equipment_json: null, terminal_count: null, group_members: null,
  policy_mode: 'activity',
});
db.upsertStudent({ sessionId: 's-exit', seat: '01', groupId: '1' });
db.upsertStudent({ sessionId: 's-exit', seat: '02', groupId: '1' });
db.recordCheckin({ sessionId: 's-exit', seat: '01', groupId: '1', name: '甲', studentNo: null,
  machineId: 'M-A', checkinTime: NOW, equipments: [], role: 'leader' });
db.createTask({ sessionId: 's-exit', taskId: 't1', title: '闪灯电路', desc: null, publishTime: NOW,
  source: 'custom', activityPresetId: null, timed: 0, durationSec: null,
  timerState: 'idle', timerStartedAt: null, timerPausedAt: null, timerRemainingMs: null });

function dispatch(env) { return handlers.dispatch('siot/ict_up', Buffer.from(JSON.stringify(env))); }
const stu = (seat) => db.getStudent('s-exit', seat);

console.log('-- 教师端 退出课堂 exit-sync');

// ---- X. exit 落库 + 标记 + SSE ----
dispatch({ type: 'exit', seat: '01', machineId: 'M-A', msgId: 'm-exit-1', ts: NOW + 1, payload: { reason: 'student' } });
check('X1 exit 落库并置 exited=1', stu('01') && stu('01').exited === 1, JSON.stringify(stu('01')));
check('X2 SSE 广播 student.exited（大屏据此显示「已退出」）',
  events.some((e) => e.ev === 'student.exited' && e.p.seat === '01' && e.p.exited === true),
  JSON.stringify(events.map((e) => e.ev)));
dispatch({ type: 'exit', seat: '01', machineId: 'M-A', msgId: 'm-exit-1', ts: NOW + 2, payload: { reason: 'student' } });
check('X3 同 msgId 重复投递被幂等忽略（不重复记事件）',
  db.queryEvents('s-exit', {}).items.filter((e) => e.type === 'exit').length === 1);

// ---- Y. 已退出座位的 sync 必须是待课空态 ----
// 否则：老师课中切一次锁定策略 → 双保险全量 sync → 刚退出的学生被拽回课中。
{
  const p = buildSyncPayload(db.getSession('s-exit'), '01');
  check('Y1 已退出座位 sync：phase=idle', p.phase === 'idle', JSON.stringify(p));
  check('Y2 已退出座位 sync：不带活动（教师发新活动才回归）', p.currentTask === null);
  check('Y3 已退出座位 sync：登记/归都不算已完成', p.checkinDone === false && p.returnDone === false);
  check('Y4 已退出座位 sync：policy=open（activity 模式也不锁待课机）', p.policy === 'open', String(p.policy));
  check('Y5 未退出座位 sync：仍是课中正常态（退出只影响自己）', (() => {
    const q = buildSyncPayload(db.getSession('s-exit'), '02');
    return q.phase === 'task' && q.currentTask && q.currentTask.taskId === 't1';
  })(), JSON.stringify(buildSyncPayload(db.getSession('s-exit'), '02')));
}

// ---- Z. 回归路径：hello / 重新登记 / 上报任务状态 → 清标记 ----
syncs.length = 0;
dispatch({ type: 'hello', seat: '01', machineId: 'M-A', msgId: 'm-hello-1', ts: NOW + 3, payload: { phase: 'idle' } });
setTimeout(() => {
  check('Z1 重新 hello → 清除退出标记（学生重进课堂页即回归）', stu('01').exited === 0, String(stu('01').exited));
  check('Z2 hello 应答 sync 恢复正常课中态（含活动卡）',
    syncs.length === 1 && syncs[0].seat === '01' && syncs[0].payload.phase === 'task'
      && syncs[0].payload.currentTask && syncs[0].payload.currentTask.taskId === 't1',
    JSON.stringify(syncs[0] && syncs[0].payload));
  check('Z3 回归 SSE student.rejoined 已发', events.some((e) => e.ev === 'student.rejoined' && e.p.seat === '01'));

  // 再次退出 → 重新登记清标记（recordCheckin 内置 exited:0）
  dispatch({ type: 'exit', seat: '01', machineId: 'M-A', msgId: 'm-exit-2', ts: NOW + 4, payload: {} });
  check('Z4 再次退出置标记', stu('01').exited === 1);
  db.recordCheckin({ sessionId: 's-exit', seat: '01', groupId: '1', name: '甲', studentNo: null,
    machineId: 'M-A', checkinTime: NOW + 5, equipments: [], role: 'leader' });
  check('Z5 重新登记自动清标记（recordCheckin 内置回归）', stu('01').exited === 0, String(stu('01').exited));

  // 上报任务状态清标记
  dispatch({ type: 'exit', seat: '02', machineId: 'M-B', msgId: 'm-exit-3', ts: NOW + 6, payload: {} });
  dispatch({ type: 'task', seat: '02', machineId: 'M-B', msgId: 'm-task-1', ts: NOW + 7,
    payload: { taskId: 't1', status: 'doing' } });
  check('Z6 退出后上报任务状态也自动清标记', stu('02').exited === 0, String(stu('02').exited));

  // ---- R. 反向对照：sync.service 的 exited 分支被移除后必须被静态检查器检出 ----
  const syncSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'sync.service.js'), 'utf8');
  check('R1 sync.service 含 exited 待课空态分支', /st\.exited/.test(syncSrc));
  const bad = syncSrc.replace(/if \(st && st\.exited\) \{[\s\S]*?\n    \}/, '');
  check('R2 反向·成功删除 exited 分支', !/st\.exited/.test(bad));
  // 删除分支后 buildSyncPayload（新加载的模块）对已退出座位回课中态 —— 复现"退出被拽回"
  {
    const fs2 = require('fs');
    const p2 = path.join(__dirname, '..', 'src', 'services', 'sync.service.js');
    const MOD_PATH = require.resolve('../src/services/sync.service.js');
    fs2.writeFileSync(p2, bad, 'utf8');
    try {
      delete require.cache[MOD_PATH];
      const badMod = require(p2);
      const pb = badMod.buildSyncPayload(db.getSession('s-exit'), '01');
      check('R3 反向·无 exited 分支时已退出座位被 sync 拽回课中（复现缺陷）',
        pb.phase === 'task' && pb.currentTask && pb.currentTask.taskId === 't1', JSON.stringify(pb));
    } finally {
      fs2.writeFileSync(p2, syncSrc, 'utf8'); // 无论断言成败都还原源码
      delete require.cache[MOD_PATH];
      require(p2);
    }
  }

  // 大屏快照带 exited 字段
  const dash = require('../src/services/dashboard.service');
  const seat01 = dash.getSnapshot().seats.find((s) => s.seat === '01');
  const seat02 = dash.getSnapshot().seats.find((s) => s.seat === '02');
  check('R4 大屏快照座位含 exited 字段（01 未退出=false）', seat01 && seat01.exited === false);
  dispatch({ type: 'exit', seat: '01', machineId: 'M-A', msgId: 'm-exit-4', ts: NOW + 8, payload: {} });
  const seat01b = dash.getSnapshot().seats.find((s) => s.seat === '01');
  check('R5 退出后大屏快照 exited=true', seat01b.exited === true, JSON.stringify(seat01b));

  try { fs.rmSync(DBP, { force: true }); fs.rmSync(DBP + '-wal', { force: true }); fs.rmSync(DBP + '-shm', { force: true }); } catch (_e) { /* noop */ }
  console.log('-- 退出课堂 exit-sync 总结: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail === 0 ? 0 : 1);
}, 50); // handleHello 异步 publishSync（桩内同步 push，留一拍事件循环）
