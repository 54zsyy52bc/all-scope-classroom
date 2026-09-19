'use strict';
// =============================================================================
// 学生端 sync 残缺包容错回归（"发布活动后无法解锁、大屏操作集体失效"学生侧根因）
//
// 现场事故：教师端策略"双保险"曾逐生下发仅 { policy } 的残缺 sync。旧 onSync 把
// sync 当完整权威状态：缺省 phase 当 idle（全班被打回待课页）、缺省 currentTask
// 当 null（活动卡清空）、缺省 checkinDone 当 false（登记被回滚 + 恐慌 toast）。
// 修复契约：sync 字段仅在报文**明确存在**（'字段' in payload）时才应用；
// 完整 sync（含显式 null）行为与旧版完全一致。
// =============================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'downlink.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}

function makeState() {
  return {
    seat: '01', phase: 'task',
    currentTask: { taskId: 't1', title: '闪灯电路', timed: false },
    taskStatus: 'doing', checkinDone: true, returnDone: false,
  };
}

function run(src) {
  const state = makeState();
  const calls = { policy: [], timer: [], toast: [], renderStage: 0 };
  const sandbox = {
    console, Date,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'downlink.js' });
  const dl = sandbox.Downlink.create({
    state,
    toast: (m) => calls.toast.push(m),
    renderStage: () => { calls.renderStage += 1; },
    bridge: () => null,
    log: () => {},
    pad2: (n) => String(n),
    audit: () => {},
    resetEquipQty: () => {},
    onEquipment: () => {},
    onTimer: (p) => calls.timer.push(p),
    onPolicy: (p) => calls.policy.push(p),
  });
  return { dl, state, calls };
}

const sync = (payload) => ({ type: 'sync', seat: '01', payload });

console.log('-- 学生端 sync 残缺包容错 downlink-partial');

// ---- P. 残缺包（仅 policy）：状态必须原样保留 ----
{
  const r = run(SRC);
  r.dl.onSync(sync({ policy: { mode: 'activity', locked: true } }));
  check('P1 残缺 sync 不改阶段（否则全班被打回待课页）', r.state.phase === 'task', r.state.phase);
  check('P2 残缺 sync 不清当前活动', r.state.currentTask && r.state.currentTask.taskId === 't1');
  check('P3 残缺 sync 不回滚登记状态', r.state.checkinDone === true, JSON.stringify(r.state.checkinDone));
  check('P4 残缺 sync 的 policy 仍要生效（锁屏恢复靠它）',
    r.calls.policy.length === 1 && r.calls.policy[0].locked === true, JSON.stringify(r.calls.policy));
  check('P5 残缺 sync 不弹"登记未被接受"恐慌 toast', r.calls.toast.length === 0, JSON.stringify(r.calls.toast));
}

// ---- F. 完整包（全字段，含显式 null）：行为与旧版一致 ----
{
  const r = run(SRC);
  r.dl.onSync(sync({ sessionId: 's1', phase: null, currentTask: null, checkinDone: false,
    returnDone: false, equipment: null, policy: null }));
  check('F1 完整包 phase=null（无进行中会话）→ 待课', r.state.phase === 'idle', r.state.phase);
  check('F2 完整包 currentTask=null → 清活动卡', r.state.currentTask === null);
  check('F3 完整包 checkinDone=false 显式回滚登记 + 提示',
    r.state.checkinDone === false && r.calls.toast.some((t) => /登记未被教师端接受/.test(t)),
    JSON.stringify(r.calls.toast));
}
{
  const r = run(SRC);
  r.dl.onSync(sync({ sessionId: 's1', phase: 'task', currentTask: { taskId: 't9', title: '新活动' },
    checkinDone: true, returnDone: false, equipment: null, policy: { mode: 'activity', locked: false } }));
  check('F4 完整包 phase=task + 活动照常恢复',
    r.state.phase === 'task' && r.state.currentTask.taskId === 't9');
  check('F5 完整包 checkinDone=true 不触发回滚 toast', r.calls.toast.length === 0);
}

// ---- R. 反向对照：把容错改回旧的无条件应用，必须复现"全班被打回待课页" ----
{
  const bad = SRC.replace("if ('phase' in p) setPhase(p.phase || 'idle');",
    "setPhase(p.phase || 'idle');")
    .replace("if ('checkinDone' in p && state.checkinDone && !p.checkinDone) {",
      "if (state.checkinDone && !p.checkinDone) {");
  check('R1 反向·成功把容错改回旧的无条件应用', bad !== SRC);
  const rb = run(bad);
  rb.dl.onSync(sync({ policy: { mode: 'activity', locked: true } }));
  check('R2 反向·旧代码吃残缺包后被踢回待课页（复现现场事故）', rb.state.phase === 'idle', rb.state.phase);
  check('R3 反向·旧代码吃残缺包后登记被回滚', rb.state.checkinDone === false);
}

console.log('-- sync 残缺包容错 总结: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
