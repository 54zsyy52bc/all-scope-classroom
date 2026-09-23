'use strict';
// =============================================================================
// 「教师通知」回归：sendNotice 指令服务 + /commands/notice 路由 + 三端配对
//
// 教师机置顶浮窗「发送通知」按钮走 POST /api/v1/commands/notice：
//   * 全体广播（seat 留空）→ payload 仅含 message；
//   * 定向提醒（给座位号）→ payload 含 seat（学生端 downlink applyNotice 只对
//     对应座位弹 toast，其余座位静默忽略）；
//   * 校验：空内容 E-VAL-01、非法座位 E-VAL-01、超长截断 200；
//   * SSE command.sent 通知大屏流。
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

const DBP = path.join(os.tmpdir(), 'rt-cmd-notice-' + Date.now() + '.db');
process.env.DB_PATH = DBP;
const db = require('../src/db');
db.init();
const bridge = require('../src/mqtt/bridge');
const sse = require('../src/sse');

const cmds = [];
const events = [];
bridge.publishCommand = async (action, payload) => {
  cmds.push({ action, payload });
  return { delivered: true, msgId: 'm-' + cmds.length };
};
sse.publish = (ev, p) => { events.push({ ev, p }); };

const svc = require('../src/services/command.service');
const { fail: apiFail } = require('../src/errors');

const NOW = Date.now();
db.createSession({
  session_id: 's-notice', teacher: '张老师', class_name: '初二(3)班',
  start_time: NOW, end_time: null, phase: 'task', total_seats: 5,
  export_flag: 0, topic_plan: 'B', class_preset_id: null, activity_preset_id: null,
  activity_name: null, equipment_json: null, terminal_count: null, group_members: null,
  policy_mode: 'activity',
});

console.log('-- 教师端 通知指令 command-notice');

// ---- N. 基本行为 ----
(async () => {
  const r1 = await svc.sendNotice({ message: '请保持安静' });
  check('N1 全体广播：cmd notice 下发', cmds.length === 1 && cmds[0].action === 'notice', JSON.stringify(cmds));
  check('N2 全体广播：payload 仅含 message（不带 seat）',
    cmds[0].payload.message === '请保持安静' && cmds[0].payload.seat === undefined, JSON.stringify(cmds[0].payload));
  check('N3 SSE command.sent（seat=null 表示全体）',
    events.some((e) => e.ev === 'command.sent' && e.p.action === 'notice' && e.p.seat === null),
    JSON.stringify(events.map((e) => e.p)));
  check('N4 返回值含 message/seat/broadcast', r1.message === '请保持安静' && r1.seat === null && !!r1.broadcast);

  const r2 = await svc.sendNotice({ message: '请坐好', seat: '07' });
  check('N5 定向提醒：payload 带 seat', r2.seat === '07' && cmds[1].payload.seat === '07', JSON.stringify(cmds[1].payload));

  // ---- V. 校验 ----
  let threw = null;
  try { await svc.sendNotice({ message: '   ' }); } catch (e) { threw = e; }
  check('V1 空内容拒绝（E-VAL-01）', threw && threw.errorCode === 'E-VAL-01', String(threw && threw.errorCode));
  threw = null;
  try { await svc.sendNotice({ message: 'hi', seat: 'abc' }); } catch (e) { threw = e; }
  check('V2 非法座位拒绝（E-VAL-01）', threw && threw.errorCode === 'E-VAL-01', String(threw && threw.errorCode));
  const r3 = await svc.sendNotice({ message: 'x'.repeat(300) });
  check('V3 超长内容截断到 200 字', r3.message.length === 200, String(r3.message.length));

  // ---- W. 路由静态接线（浮窗数据面） ----
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'command.js'), 'utf8');
  check('W1 路由含 POST /commands/notice', /router\.post\('\/commands\/notice'/.test(routeSrc));
  const svcSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'command.service.js'), 'utf8');
  check('W2 sendNotice 已导出（module.exports）', /module\.exports\s*=\s*\{[^}]*sendNotice/.test(svcSrc));

  // ---- X. 学生端配对（downlink applyNotice 定向过滤） ----
  const dlSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'student', 'renderer', 'downlink.js'), 'utf8');
  check('X1 学生端 downlink 处理 notice 指令', /p\.action === 'notice'\s*\)?\s*return applyNotice\(p\)/.test(dlSrc));
  check('X2 applyNotice 座位过滤（非本座静默忽略）', /p\.seat != null && pad2\(p\.seat\) !== state\.seat/.test(dlSrc));

  // ---- F. 教师浮窗脚本静态闸门（存在、引用通知接口、二次确认、置顶） ----
  const floatSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'teacher-float.ps1'), 'utf8');
  check('F1 浮窗脚本存在且轮询 dashboard/snapshot', /\/dashboard\/snapshot/.test(floatSrc));
  check('F2 浮窗脚本调用 /commands/notice', /\/commands\/notice/.test(floatSrc));
  check('F3 浮窗脚本具备二次确认（防误触）', /再点一次确认/.test(floatSrc) && /Request-Confirm/.test(floatSrc));
  check('F4 浮窗脚本窗口置顶（Topmost=True）', /Topmost="True"/.test(floatSrc));
  check('F5 浮窗脚本调用结束活动与锁定策略接口',
    /activities\/\$\(\$script:currentTaskId\)\/end/.test(floatSrc) && /\/policy/.test(floatSrc));
  check('F6 apiFail 为错误构造器（防误改名）', typeof apiFail === 'function');

  try { fs.rmSync(DBP, { force: true }); fs.rmSync(DBP + '-wal', { force: true }); fs.rmSync(DBP + '-shm', { force: true }); } catch (_e) { /* noop */ }
  console.log('-- 通知指令 command-notice 总结: ' + pass + ' pass / ' + fail + ' fail');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
