'use strict';
// 单元自检：幂等、HMAC 关机令牌、座位号规范化、仓储读写、参照完整性与事务回滚。
// 不依赖 SIoT / 网络，直接在临时存储上跑。运行：npm run selfcheck
const os = require('os');
const path = require('path');

// 用临时库，避免污染项目目录
process.env.DB_PATH = path.join(os.tmpdir(), `selfcheck-${Date.now()}.db`);

const db = require('../src/db');
const { signToken, verifyToken, seatNum } = require('../src/utils');
const { BusinessError } = require('../src/errors');

let pass = 0;
let failCount = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`[PASS] ${name}`); }
  else { failCount += 1; console.log(`[FAIL] ${name}${extra ? ' -> ' + extra : ''}`); }
}

// 断言抛出的是带 errorCode 的业务错误，而不是原生 SQLite 异常
function expectRefError(name, fn) {
  try {
    fn();
    check(name, false, '未抛异常');
    return null;
  } catch (e) {
    check(name, e instanceof BusinessError && e.errorCode === 'E-REF-01',
      `实际: ${e.name}/${e.errorCode || e.code || ''} ${e.message}`);
    return e;
  }
}

const init = db.init();
console.log(`存储模式: ${init.mode}${init.reason ? ' (' + init.reason + ')' : ''}\n`);

const SESSION = 'S-SELFCHECK';

// 1) 幂等：同一 msg_id 第二次写入应被忽略
const msgId = 'test-msg-001';
const r1 = db.insertEvent({ session_id: SESSION, ts: Date.now(), type: 'checkin', seat: '01', msg_id: msgId, detail: '{}' });
const r2 = db.insertEvent({ session_id: SESSION, ts: Date.now(), type: 'checkin', seat: '01', msg_id: msgId, detail: '{}' });
check('idempotency: 首次写入成功', r1.inserted === true);
check('idempotency: 重复 msg_id 被忽略', r2.inserted === false && r2.dup === true);

// 2) HMAC 关机令牌
const secret = 'test-secret';
const sessionId = 'S-20260830-01';
const ts = Date.now();
const token = signToken(secret, sessionId, ts);
check('hmac: 正确令牌通过校验', verifyToken(secret, token, sessionId, ts, 60000) === true);
check('hmac: 篡改令牌拒绝', verifyToken(secret, token + 'x', sessionId, ts, 60000) === false);
check('hmac: 错误密钥拒绝', verifyToken('wrong', token, sessionId, ts, 60000) === false);
check('hmac: 超出 60s 时间窗拒绝', verifyToken(secret, token, sessionId, ts - 120000, 60000) === false);

// 3) 座位号规范化
check('seatNum: 数字 7 -> "07"', seatNum(7) === '07');
check('seatNum: 字符串 "7" -> "07"', seatNum('7') === '07');
check('seatNum: "07" 保持不变', seatNum('07') === '07');

// 4) 仓储基本读写（外键目标必须先存在——正确的使用方式）
db.createSession({
  session_id: SESSION, teacher: '张老师', class_name: '初二(3)班',
  start_time: Date.now(), end_time: null, phase: 'checkin',
  total_seats: 50, export_flag: 0, topic_plan: 'B',
});
db.upsertStudent({ sessionId: SESSION, seat: '02', groupId: 'G1', patch: { name: '李四', checkin_status: 'done' } });
const stu = db.getStudent(SESSION, '02');
check('repo: 学生写入可读回', stu && stu.name === '李四' && stu.checkin_status === 'done');

// 5) 参照完整性：孤儿 session / 孤儿 taskId 必须抛业务错误 E-REF-01，
//    而不是原生 SQLITE_CONSTRAINT_FOREIGNKEY（后者会穿透到路由层变成 500）
expectRefError('ref: 孤儿 sessionId 写入抛 E-REF-01', () => {
  db.upsertStudent({ sessionId: 'S-NOT-EXIST', seat: '03', groupId: 'G1', patch: { name: '王五' } });
});
expectRefError('ref: 孤儿 taskId 写 t_task_status 抛 E-REF-01', () => {
  db.upsertTaskStatus({ taskId: 'T-NOT-EXIST', seat: '01', groupId: 'G1', status: 'done', ts: Date.now() });
});

// 6) 事务回滚 / 毒丸防护：业务写入失败时，同一事务内已插入的事件标记必须一并回滚，
//    否则 msg_id 被占用，MQTT 重投后消息会被幂等逻辑永久丢弃。
const poisonMsgId = 'poison-msg-001';
let rollbackOk = false;
try {
  db.transaction(() => {
    db.insertEvent({ session_id: SESSION, ts: Date.now(), type: 'task', seat: '01', msg_id: poisonMsgId });
    db.upsertTaskStatus({ taskId: 'T-NOT-EXIST', seat: '01', groupId: 'G1', status: 'done', ts: Date.now() });
  });
} catch (e) {
  rollbackOk = e instanceof BusinessError && e.errorCode === 'E-REF-01';
}
check('tx: 失败事务抛出 E-REF-01', rollbackOk);
const retry = db.insertEvent({ session_id: SESSION, ts: Date.now(), type: 'task', seat: '01', msg_id: poisonMsgId });
check('tx: msg_id 未被毒丸占用（重投可成功）', retry.inserted === true);

// 7) 回归：publishTask 必须返回可见的任务（曾因键名不匹配导致 task_id 落库为 NULL）
const taskSvc = require('../src/services/task.service');
const pub = taskSvc.publishTask({ sessionId: SESSION, title: '焊接练习', desc: '第一关' });
check('task: publishTask 返回非空任务', !!pub.task && !!pub.task.taskId);
check('task: 任务可按 sessionId 列出', db.listTasks(SESSION).length === 1);
check('task: 任务可按 taskId 读回', !!db.getTask(pub.task && pub.task.taskId));
check('task: task_id 与 session_id 未落库为 NULL',
  db.listTasks(SESSION).every((t) => t.task_id && t.session_id === SESSION));

// 8) 座位冲突判定：单 machineId 不算冲突，同一座位出现第二个 machineId 才算。
//    回归：曾按"冲突记录行是否存在"判定，导致每个上报过 machineId 的座位都被误标为冲突。
db.upsertConflict({ seat: '09', machineId: 'PC-A', ts: Date.now() });
const cf1 = db.queryConflicts().find((c) => c.seat === '09');
check('conflict: 单个 machineId 不判为冲突', cf1 && cf1.machineIds.length === 1);
db.upsertConflict({ seat: '09', machineId: 'PC-B', ts: Date.now() });
const cf2 = db.queryConflicts().find((c) => c.seat === '09');
check('conflict: 同座位第二个 machineId 判为冲突', cf2 && cf2.machineIds.length === 2);

db.close();
console.log(`\n自检完成：${pass} 通过, ${failCount} 失败`);
process.exit(failCount > 0 ? 1 : 0);
