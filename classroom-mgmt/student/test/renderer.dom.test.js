'use strict';
// =============================================================================
// 学生端渲染层无头验证（DOM 桩 + MQTT 桩）
//
// 目的：验证 app.js 拆分（downlink.js / actions.js）后，三阶段业务流程语义不变。
// 方式：在 Node 里以全局作用域 eval 加载渲染层脚本（模拟浏览器 classic script），
//       用桩 DOM / 桩 mqtt 驱动完整课堂流程，断言状态迁移与上下行报文。
// 运行：node test/renderer.dom.test.js
// =============================================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SHR = path.join(__dirname, '..', '..', 'shared'); // classroom-mgmt/shared
const R = (...p) => path.join(ROOT, ...p);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [PASS] ' + name); }
  else { fail += 1; console.log('  [FAIL] ' + name + (extra ? ' -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 桩：DOM ----------
const elsMap = {};
function makeEl(id) {
  return {
    id, value: '', textContent: '', innerHTML: '', hidden: true,
    dataset: {}, tagName: 'DIV', _listeners: {},
    addEventListener(ev, fn) { this._listeners[ev] = fn; },
    querySelector() { return null; },
    replaceWith() {},
    closest() { return null; },
  };
}
const documentStub = {
  readyState: 'complete',
  addEventListener() {},
  getElementById(id) {
    if (!elsMap[id]) elsMap[id] = makeEl(id);
    return elsMap[id];
  },
  createElement(tag) { return makeEl(tag); },
};
const localStorageStub = {
  _d: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
};

// ---------- 桩：MQTT 客户端 ----------
let lastClient = null;
function fakeConnect() {
  const handlers = {};
  const client = {
    published: [],
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit(ev) {
      const args = [].slice.call(arguments, 1);
      (handlers[ev] || []).forEach((f) => f.apply(null, args));
    },
    subscribe(t, o, cb) { if (cb) cb(null); },
    publish(topic, payload, o, cb) {
      let parsed = null;
      try { parsed = JSON.parse(payload.toString()); } catch (_e) { parsed = payload.toString(); }
      client.published.push({ topic, payload: parsed });
      if (cb) cb();
    },
    removeAllListeners() {},
    end() {},
  };
  lastClient = client;
  return client;
}

// ---------- 加载渲染层（模拟浏览器 script 顺序）----------
globalThis.window = globalThis;
globalThis.document = documentStub;
globalThis.localStorage = localStorageStub;
globalThis.mqtt = { connect: fakeConnect };
function loadGlobal(p) { (0, eval)(fs.readFileSync(p, 'utf8')); }
loadGlobal(path.join(SHR, 'topics.js'));
loadGlobal(path.join(SHR, 'icons.js'));
loadGlobal(R('renderer/equipment.js'));
loadGlobal(R('renderer/net.js'));
loadGlobal(R('renderer/views.js'));
loadGlobal(R('renderer/downlink.js'));
loadGlobal(R('renderer/actions.js'));
loadGlobal(R('renderer/control.js'));
loadGlobal(R('renderer/app.js'));

// ---------- 辅助：注入下行指令 / 触发界面动作 ----------
const T = globalThis.ClassroomTopics;
const stage = documentStub.getElementById('stage');
function injectCmd(action, payload) {
  lastClient.emit('message', T.CMD_BROADCAST, Buffer.from(JSON.stringify(
    T.makeCommand({ action: action, payload: payload || {} })
  )));
}
function injectSync(env) {
  lastClient.emit('message', T.SYNC, Buffer.from(JSON.stringify(env)));
}
function clickAct(act, data) {
  const el = { dataset: Object.assign({ act: act }, data || {}) };
  const evt = { target: { closest: (sel) => (sel === '[data-act]' ? el : null) } };
  (stage._listeners.click || function () {})(evt);
}
function input(id, v) { documentStub.getElementById(id).value = v; }

// ---------- 主流程 ----------
async function main() {
  // 0) 上线（桩客户端自动 connected：模拟 broker connect 事件）
  lastClient.emit('connect');
  await sleep(10);
  check('连上后发 hello（无座位则不发，未抛错）', true);

  // 1) 教师开始上课
  injectCmd('start');
  check('收到 start -> 阶段 checkin', (() => {
    // 阶段体现在渲染输出上：登记页应包含"姓名"输入
    return stage.innerHTML.includes('f-name') || stage.innerHTML.includes('姓名');
  })(), stage.innerHTML.slice(0, 80));

  // 2) 学生登记
  input('f-name', '张三');
  input('f-seat', '7');
  input('f-no', '20260307');
  clickAct('checkin-submit');
  const chk = lastClient.published.filter((p) => p.payload.type === 'checkin').pop();
  check('登记上行 type=checkin', !!chk);
  check('座位补零 7 -> 07', chk && chk.payload.seat === '07', chk && chk.payload.seat);
  check('登记携带姓名/学号', chk && chk.payload.payload.name === '张三' && chk.payload.payload.studentNo === '20260307');
  check('默认器材（preset=1）随登记上报', chk && chk.payload.payload.equipments.some((e) => e.eqId === 'DEV-BOARD'));

  // 3) sync 服务端真值校正：登记后教师端未确认 -> 回滚 + 提示（同阶段内，不触发迁移）
  injectSync(T.makeSync({ seat: '07', phase: 'checkin', checkinDone: false, returnDone: false }));
  await sleep(10);
  const toast = documentStub.getElementById('toast');
  check('sync 校正：登记被回滚并提示', toast.textContent.includes('未被教师端确认'), toast.textContent);

  // 3.5) 教师下发器材清单（活动预设）：原地替换 + 登记页重渲染
  injectCmd('equipment', { equipment: [{ eqId: 'EQ-A', eqName: '特制模块', category: '主控', preset: 2 }], activityName: '焊接入门' });
  await sleep(10);
  check('cmd equipment：EQUIPMENT 被动态替换', globalThis.EQUIPMENT.length === 1 && globalThis.EQUIPMENT[0].eqId === 'EQ-A', JSON.stringify(globalThis.EQUIPMENT));
  check('cmd equipment：登记页显示新器材', stage.innerHTML.includes('特制模块'), stage.innerHTML.slice(0, 80));

  // 3.6) sync 携带器材（迟到/重连场景）：以 sync 清单为准恢复
  injectSync(T.makeSync({
    seat: '07', phase: 'checkin', checkinDone: false, returnDone: false,
    equipment: [{ eqId: 'EQ-B', eqName: '备份模块', category: '其他', preset: 1 }],
  }));
  await sleep(10);
  check('sync equipment：清单更新生效', globalThis.EQUIPMENT.length === 1 && globalThis.EQUIPMENT[0].eqId === 'EQ-B', JSON.stringify(globalThis.EQUIPMENT));
  check('sync equipment：重渲染含新器材', stage.innerHTML.includes('备份模块'));

  // 4) 教师发布任务
  injectCmd('task', { task: { taskId: 'T-001', title: '焊接练习', desc: '第一关' } });
  check('收到 task -> 阶段 task', stage.innerHTML.includes('焊接练习'), stage.innerHTML.slice(0, 60));

  // 5) 学生报任务状态
  clickAct('task-status', { status: 'done' });
  const tk = lastClient.published.filter((p) => p.payload.type === 'task').pop();
  check('任务状态上行 type=task', !!tk);
  check('状态报文携带 taskId/status', tk && tk.payload.payload.taskId === 'T-001' && tk.payload.payload.status === 'done');

  // 6) 教师下课
  injectCmd('end');
  check('收到 end -> 阶段 return', stage.innerHTML.includes('归还'), stage.innerHTML.slice(0, 60));

  // 7) 学生确认归还（先全选再提交）
  clickAct('return-toggle-all');
  clickAct('return-submit');
  const rt = lastClient.published.filter((p) => p.payload.type === 'return').pop();
  check('归还上行 type=return', !!rt);
  check('归还报文 allReturned=true', rt && rt.payload.payload.allReturned === true);

  // 7) sync 服务端真值校正：登记未被教师端确认 -> 回滚 + 提示
  input('f-name', '李四');
  input('f-seat', '7');
  clickAct('checkin-submit');
  injectSync(T.makeSync({ seat: '07', phase: 'return', checkinDone: false, returnDone: false }));
  await sleep(10);
  const toast2 = documentStub.getElementById('toast');
  check('sync 校正：登记被回滚并提示', toast2.textContent.includes('未被教师端确认'), toast2.textContent);

  // 8) 计时活动发布：任务卡显示计时器
  injectCmd('task', { task: { taskId: 'T-T1', title: '焊接计时', desc: '', timed: true, durationSec: 120, timerState: 'running', remainingMs: 120000 } });
  check('计时活动：任务卡显示计时器', stage.innerHTML.includes('02:00'), stage.innerHTML.slice(0, 80));

  // 9) 计时控制：暂停 → 灰显暂停
  injectCmd('task_timer', { taskId: 'T-T1', timerAction: 'pause', remainingMs: 90000 });
  await sleep(10);
  check('暂停：计时器显示 01:30 且标记暂停', stage.innerHTML.includes('01:30') && stage.innerHTML.includes('已暂停'), stage.innerHTML.slice(0, 120));

  // 10) 计时控制：继续 → 恢复倒数
  injectCmd('task_timer', { taskId: 'T-T1', timerAction: 'resume', remainingMs: 90000 });
  await sleep(10);
  check('继续：计时器恢复进行中', stage.innerHTML.includes('活动进行中'));

  // 11) 截止：双方提醒（学生端 toast + 计时器变红）
  injectCmd('task_timer', { taskId: 'T-T1', timerAction: 'expired' });
  await sleep(10);
  const toast3 = documentStub.getElementById('toast');
  check('截止：toast 提醒', toast3.textContent.includes('活动已截止'), toast3.textContent);
  check('截止：计时器标记 expired', stage.innerHTML.includes('活动已截止'), stage.innerHTML.slice(0, 120));

  // 12) 锁定策略：activity 模式非活动时间 → 全屏锁定
  injectCmd('policy', { mode: 'activity', locked: true, phase: 'task', reason: 'no-activity' });
  await sleep(10);
  const lock = documentStub.getElementById('lock-overlay');
  check('锁定：遮罩显示', lock.hidden === false);
  check('锁定：toast 提示锁定', documentStub.getElementById('toast').textContent.includes('锁定'), documentStub.getElementById('toast').textContent);

  // 13) 解锁
  injectCmd('policy', { mode: 'activity', locked: false, phase: 'task', reason: 'activity-running' });
  await sleep(10);
  check('解锁：遮罩隐藏', lock.hidden === true);

  // 14) 关机指令（无主进程桥接 -> 演练倒计时，不真关机）
  injectCmd('shutdown', { delaySec: 60 });
  await sleep(10);
  const sd = documentStub.getElementById('shutdown');
  const sdText = documentStub.getElementById('shutdown-text');
  check('shutdown 弹层显示', sd.hidden === false);
  check('演练模式标记 dry=true', sd.dataset.dry === 'true', sd.dataset.dry);
  check('倒计时文案为演练提示', sdText.textContent.includes('演练'), sdText.textContent);

  console.log('\n渲染层流程验证：' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常:', e && e.stack || e);
  process.exit(1);
});
