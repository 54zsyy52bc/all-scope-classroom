'use strict';
// 活动计时重启恢复单测：库中有 running 计时（已过期 / 进行中 / 极短）时，restoreTimers 应能
// 立即置过期、重挂未到期定时器、并让极短计时到期触发 expireTask。
// 运行：node test/timer-restore.test.js
const os = require('os');
const path = require('path');

// 用临时库，避免污染项目目录
process.env.DB_PATH = path.join(os.tmpdir(), `timer-restore-${Date.now()}.db`);

const db = require('../src/db');
const activitySvc = require('../src/services/activity.service');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? (' -> ' + extra) : '')); }
}

db.init();

const SID = 'S-RESTORE';
db.createSession({
  session_id: SID, teacher: '张老师', class_name: '初二(3)班',
  start_time: Date.now(), end_time: null, phase: 'task',
  total_seats: 50, export_flag: 0, topic_plan: 'B',
});

const now = Date.now();

// 1) 已过期：startedAt 在过去很久、时长 1s → remaining<=0 → 立即 expired
const expiredId = 'T-EXPIRED';
db.createTask({
  sessionId: SID, taskId: expiredId, title: '已过期', desc: null, publishTime: now - 20000,
  source: 'custom', timed: 1, durationSec: 1, timerState: 'running',
  timerStartedAt: now - 20000, timerPausedAt: null, timerRemainingMs: null,
});

// 2) 进行中：startedAt 过去 5s、时长 600s → remaining>0 → 重挂
const runningId = 'T-RUNNING';
db.createTask({
  sessionId: SID, taskId: runningId, title: '进行中', desc: null, publishTime: now - 5000,
  source: 'custom', timed: 1, durationSec: 600, timerState: 'running',
  timerStartedAt: now - 5000, timerPausedAt: null, timerRemainingMs: null,
});

const r = activitySvc.restoreTimers();
check('restoreTimers 立即到期计数=1', r.expired === 1, JSON.stringify(r));
check('restoreTimers 重挂计数=1', r.restored === 1, JSON.stringify(r));

const exp = db.getTask(expiredId);
check('过期任务被置为 expired', !!exp && exp.timer_state === 'expired', exp && exp.timer_state);
check('过期任务剩余归零', !!exp && exp.timer_remaining_ms === 0);

const run = db.getTask(runningId);
check('进行中任务仍为 running', !!run && run.timer_state === 'running', run && run.timer_state);

// 3) 极短计时：startedAt 过去 500ms、时长 1s → remaining≈500ms → 重挂后到期触发
const shortId = 'T-SHORT';
db.createTask({
  sessionId: SID, taskId: shortId, title: '短任务', desc: null, publishTime: now,
  source: 'custom', timed: 1, durationSec: 1, timerState: 'running',
  timerStartedAt: now - 500, timerPausedAt: null, timerRemainingMs: null,
});
activitySvc.restoreTimers(); // 捕获短任务并重挂

setTimeout(() => {
  const s = db.getTask(shortId);
  check('重挂的极短计时到期触发 expired', !!s && s.timer_state === 'expired', s && s.timer_state);
  db.close();
  console.log('\n计时恢复验证：' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail > 0 ? 1 : 0);
}, 1500);
