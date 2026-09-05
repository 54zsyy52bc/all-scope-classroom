'use strict';
// 端到端冒烟：真实 MQTT 报文 + 真实 HTTP/SSE，覆盖一节课完整链路。
// 前置：SIoT2 broker 已监听 1883，teacher server 已启动（见 package.json 的 smoke 脚本）。
// 运行：node test/smoke.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const topics = require('../../shared/topics');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
const BROKER = process.env.SMOKE_BROKER || 'mqtt://127.0.0.1:1883';
const SEAT_COUNT = Number(process.env.SEAT_COUNT || 50);
const SEAT = '07';

let pass = 0;
let failCount = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}`); }
  else { failCount += 1; console.log(`  [FAIL] ${name}${extra ? ' -> ' + extra : ''}`); }
}
function step(t) { console.log(`\n--- ${t} ---`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) { /* 非 JSON（如文件流） */ }
  return { status: res.status, json, text, headers: res.headers };
}

// ---------- SSE 收集 ----------
function startSse() {
  const events = [];
  const req = http.get(BASE + '/api/v1/dashboard/stream', { headers: { Accept: 'text/event-stream' } }, (res) => {
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = (/^event:[ ]?(.*)$/m.exec(frame) || [])[1];
        const dt = (/^data:[ ]?(.*)$/m.exec(frame) || [])[1];
        if (ev && dt) {
          try { events.push({ event: ev, payload: JSON.parse(dt) }); } catch (_e) { /* ignore */ }
        }
      }
    });
  });
  req.on('error', () => { /* ignore */ });
  return { events, close: () => req.destroy() };
}

async function waitFor(list, predicate, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = list.find(predicate);
    if (hit) return hit;
    await sleep(80);
  }
  return null;
}

// ---------- 模拟学生机 ----------
function connectStudent() {
  const received = [];
  const client = mqtt.connect(BROKER, {
    clientId: `smoke-stu-${Date.now()}`,
    username: 'siot',
    password: 'dfrobot',
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 8000,
  });
  let connected = false;
  client.on('connect', () => {
    connected = true;
    client.subscribe(topics.CMD_BROADCAST, { qos: 1 }, () => {});
    client.subscribe(topics.SYNC, { qos: 1 }, () => {});
  });
  client.on('message', (t, p) => {
    try { received.push({ topic: t, env: JSON.parse(p.toString()) }); } catch (_e) { /* ignore */ }
  });
  return {
    client,
    received,
    isConnected: () => connected,
    up: (env) => client.publish(topics.STU_UP, JSON.stringify(env), { qos: 1 }, () => {}),
  };
}

async function waitForStu(list, predicate, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = list.find(predicate);
    if (hit) return hit;
    await sleep(80);
  }
  return null;
}

async function main() {
  console.log(`SMOKE  base=${BASE}  broker=${BROKER}  seats=${SEAT_COUNT}`);

  step('1. 健康检查 /api/v1/system/health');
  let health = null;
  for (let i = 0; i < 40; i += 1) {
    const r = await api('GET', '/api/v1/system/health');
    if (r.status === 200) { health = r.json; break; }
    await sleep(500);
  }
  check('health 返回 200', !!health, health ? '' : '服务未就绪');
  if (!health) { console.log('教师端未就绪，终止'); process.exit(1); }
  console.log('  health =', JSON.stringify(health.data || health));
  const mqttState = (health.data || health).mqtt || {};
  check('health.mqtt.state = online', mqttState.state === 'online', `实际 ${mqttState.state}`);
  check('health.db.mode = sqlite', ((health.data || health).db || {}).mode === 'sqlite');
  check('统一信封 code=0', (health.data || health).code === 0 || health.code === 0);

  step('2. 静态资源 public/');
  const idx = await api('GET', '/');
  check('GET / 返回 200', idx.status === 200, `实际 ${idx.status}`);
  check('GET / 返回大屏 HTML', /<html|<!doctype/i.test(idx.text));

  step('3. 学生机上线 hello -> 教师回 sync');
  const stu = connectStudent();
  for (let i = 0; i < 40 && !stu.isConnected(); i += 1) await sleep(250);
  check('学生机已连上 broker', stu.isConnected());
  stu.up(topics.makeEnvelope({ type: 'hello', seat: SEAT, payload: { machineId: 'PC-SMOKE-07' } }));
  const syncEv = await waitForStu(stu.received, (m) => m.topic === topics.SYNC && m.env.seat === SEAT);
  check('收到 sync 应答', !!syncEv);
  if (syncEv) console.log('  sync =', JSON.stringify(syncEv.env));
  check('sync 阶段为 null（未开课）', syncEv && syncEv.env.payload.phase === null,
    syncEv ? String(syncEv.env.payload.phase) : 'n/a');

  step('4. 教师开始上课（携带班级/活动预设）');
  const sse = startSse();
  await sleep(400);
  // 3.5) 先建预设（放在 step4 内执行，保持步骤编号稳定）
  const cp = await api('POST', '/api/v1/presets/classes', { name: '初二(3)班', totalSeats: SEAT_COUNT, groupSize: 5 });
  check('创建班级预设 201', cp.status === 201, `实际 ${cp.status}`);
  const classPresetId = cp.json && cp.json.data && cp.json.data.presetId;
  const ap = await api('POST', '/api/v1/presets/activities', {
    name: '焊接入门', category: '焊接',
    equipment: [
      { eqId: 'DEV-BOARD', eqName: '开发板', category: '主控', preset: 1 },
      { eqId: 'LED', eqName: 'LED 灯', category: '元件', preset: 5 },
    ],
    taskTemplates: [{ title: '点亮 LED', desc: '第一关' }],
  });
  check('创建活动预设 201', ap.status === 201, `实际 ${ap.status}`);
  const activityPresetId = ap.json && ap.json.data && ap.json.data.presetId;

  const started = await api('POST', '/api/v1/sessions', { teacher: '张老师', classPresetId, activityPresetId });
  check('POST /api/v1/sessions 返回 201', started.status === 201, `实际 ${started.status}`);
  const sessionId = started.json && started.json.data && started.json.data.session.sessionId;
  check('返回 sessionId', !!sessionId, String(sessionId));
  console.log('  sessionId =', sessionId, ' phase =',
    started.json && started.json.data && started.json.data.session.phase);
  if (started.json && started.json.data) {
    check('上课返回活动名', started.json.data.activityName === '焊接入门', String(started.json.data.activityName));
    check('上课返回器材清单（2 件）', Array.isArray(started.json.data.equipment) && started.json.data.equipment.length === 2);
    check('上课返回任务模板（1 个）', Array.isArray(started.json.data.taskTemplates) && started.json.data.taskTemplates.length === 1);
    check('会话记录班级来自预设', started.json.data.session.className === '初二(3)班', String(started.json.data.session.className));
  }
  const phaseEv = await waitFor(sse.events, (e) => e.event === 'phase.changed');
  check('SSE 收到 phase.changed', !!phaseEv, '未收到');
  if (phaseEv) console.log('  SSE phase.changed =', JSON.stringify(phaseEv.payload.payload));

  // 学生机收到器材清单下发
  const cmdEquip = await waitForStu(stu.received, (m) => m.env.type === 'cmd' && m.env.payload.action === 'equipment');
  check('学生机收到 equipment 指令', !!cmdEquip);
  if (cmdEquip) {
    console.log('  cmd.equipment =', JSON.stringify(cmdEquip.env.payload));
    check('equipment 带活动名', cmdEquip.env.payload.activityName === '焊接入门');
    check('equipment 含预设器材（LED preset=5）', (cmdEquip.env.payload.equipment || []).some((e) => e.eqId === 'LED' && e.preset === 5));
  }

  // 重连 hello -> sync 携带器材清单（迟到/掉线恢复）
  stu.up(topics.makeEnvelope({ type: 'hello', seat: SEAT, payload: { machineId: 'PC-SMOKE-07' } }));
  const sync2 = await waitForStu(stu.received,
    (m) => m.topic === topics.SYNC && m.env.seat === SEAT && m.env.payload.phase === 'checkin');
  check('重连 hello -> sync 携带器材清单', !!sync2 && Array.isArray(sync2.env.payload.equipment) && sync2.env.payload.equipment.length >= 1,
    sync2 ? JSON.stringify(sync2.env.payload) : '未收到');
  if (sync2) console.log('  sync2.equipment =', JSON.stringify(sync2.env.payload.equipment));

  step('5. 学生登记 checkin -> SSE + HTTP 可查');
  stu.up(topics.makeEnvelope({
    type: 'checkin', seat: SEAT, group: 'G2',
    payload: {
      name: '张三', studentNo: '20260307',
      equipments: [{ eqId: 'DEV-BOARD', qty: 1 }, { eqId: 'LED', qty: 5 }],
    },
    machineId: 'PC-SMOKE-07',
  }));
  const checkinEv = await waitFor(sse.events, (e) => e.event === 'student.checkin');
  check('SSE 收到 student.checkin', !!checkinEv);
  if (checkinEv) console.log('  SSE student.checkin =', JSON.stringify(checkinEv.payload.payload));
  const students = await api('GET', `/api/v1/sessions/${sessionId}/students?status=done`);
  const list = (students.json && students.json.data && students.json.data.items) || [];
  const s07 = list.find((x) => x.seat === SEAT);
  check('HTTP 查询到座位 07 已登记', !!s07 && s07.name === '张三',
    s07 ? JSON.stringify(s07) : `共 ${list.length} 条`);
  if (s07) console.log('  学生 =', JSON.stringify(s07));
  const borrows = await api('GET', `/api/v1/sessions/${sessionId}/borrows`);
  const bRows = (borrows.json && borrows.json.data && borrows.json.data.items) || [];
  check('登记携带的器材已入库', bRows.some((b) => b.seat === SEAT), `共 ${bRows.length} 条`);

  step('6. 发布任务 -> 学生收到 task 指令');
  const taskRes = await api('POST', `/api/v1/sessions/${sessionId}/tasks`, { title: '焊接练习', desc: '第一关' });
  check('POST 发布任务 返回 201', taskRes.status === 201, `实际 ${taskRes.status}`);
  const taskId = taskRes.json && taskRes.json.data && taskRes.json.data.task && taskRes.json.data.task.taskId;
  check('返回非空 taskId', !!taskId, String(taskId));
  console.log('  taskId =', taskId);
  const cmdTask = await waitForStu(stu.received, (m) => m.env.type === 'cmd' && m.env.payload.action === 'task');
  check('学生机收到 task 广播', !!cmdTask);
  if (cmdTask) console.log('  cmd.task =', JSON.stringify(cmdTask.env.payload));

  step('7. 学生上报任务状态 -> 可查询');
  stu.up(topics.makeEnvelope({ type: 'task', seat: SEAT, group: 'G2', payload: { taskId, status: 'done' } }));
  const taskEv = await waitFor(sse.events, (e) => e.event === 'task.status');
  check('SSE 收到 task.status', !!taskEv);
  if (taskEv) console.log('  SSE task.status =', JSON.stringify(taskEv.payload.payload));
  const tasks = await api('GET', `/api/v1/sessions/${sessionId}/tasks`);
  const tRow = ((tasks.json && tasks.json.data) || []).find((t) => t.taskId === taskId);
  check('任务统计 done >= 1', !!tRow && tRow.stats.done >= 1,
    tRow ? JSON.stringify(tRow.stats) : '未找到任务');
  if (tRow) console.log('  任务统计 =', JSON.stringify(tRow.stats));

  step('7.5 计时活动：发布（6 秒）→ 暂停 → 继续 → 重计时 → 截止（双方提醒）');
  const actRes = await api('POST', `/api/v1/sessions/${sessionId}/activities`, { title: '计时焊接', timed: true, durationSec: 6 });
  check('发布计时活动 201', actRes.status === 201, `实际 ${actRes.status}`);
  const actTaskId = actRes.json && actRes.json.data && actRes.json.data.task && actRes.json.data.task.taskId;
  check('计时活动返回 taskId', !!actTaskId, String(actTaskId));
  if (actRes.json && actRes.json.data && actRes.json.data.task) {
    check('活动 timed=true / timerState=running', actRes.json.data.task.timed === true && actRes.json.data.task.timerState === 'running');
  }
  const cmdAct = await waitForStu(stu.received, (m) => m.env.type === 'cmd' && m.env.payload.action === 'task' && m.env.payload.task && m.env.payload.task.timed === true);
  check('学生机收到计时活动广播', !!cmdAct);
  if (cmdAct) console.log('  cmd.task(timed) =', JSON.stringify(cmdAct.env.payload.task));

  // 暂停
  const pause = await api('POST', `/api/v1/sessions/${sessionId}/activities/${actTaskId}/timer`, { action: 'pause' });
  check('暂停计时 200', pause.status === 200, `实际 ${pause.status}`);
  const cmdPause = await waitForStu(stu.received, (m) => m.env.type === 'cmd' && m.env.payload.action === 'task_timer' && m.env.payload.timerAction === 'pause');
  check('学生机收到暂停指令（带剩余时间）', !!cmdPause && cmdPause.env.payload.remainingMs > 0, cmdPause ? JSON.stringify(cmdPause.env.payload) : '');

  // 继续
  const resume = await api('POST', `/api/v1/sessions/${sessionId}/activities/${actTaskId}/timer`, { action: 'resume' });
  check('继续计时 200', resume.status === 200);
  const cmdResume = await waitForStu(stu.received, (m) => m.env.type === 'cmd' && m.env.payload.action === 'task_timer' && m.env.payload.timerAction === 'resume');
  check('学生机收到继续指令', !!cmdResume);

  // 重计时
  const restart = await api('POST', `/api/v1/sessions/${sessionId}/activities/${actTaskId}/timer`, { action: 'restart' });
  check('重新计时 200', restart.status === 200);
  const cmdRestart = await waitForStu(stu.received, (m) => m.env.type === 'cmd' && m.env.payload.action === 'task_timer' && m.env.payload.timerAction === 'restart');
  check('学生机收到重新计时指令', !!cmdRestart);

  // 等待自然截止（6 秒）→ 双方提醒
  const timerEv = await waitFor(sse.events, (e) => e.event === 'activity.timer' && e.payload.payload.taskId === actTaskId && e.payload.payload.state === 'expired', 20000);
  check('SSE 收到 activity.timer(expired)（教师端提醒）', !!timerEv, '20s 内未截止');
  const cmdExpired = await waitForStu(stu.received, (m) => m.env.type === 'cmd' && m.env.payload.action === 'task_timer' && m.env.payload.timerAction === 'expired', 20000);
  check('学生机收到截止提醒', !!cmdExpired);

  step('7.6 锁定策略联动（activity 模式）');
  const polSet = await api('POST', `/api/v1/sessions/${sessionId}/policy`, { mode: 'activity' });
  check('设置策略 activity 200', polSet.status === 200, `实际 ${polSet.status}`);
  // 截止后无 running 活动 → 应下发锁定
  const polLock = await waitForStu(stu.received, (m) => m.env.type === 'cmd' && m.env.payload.action === 'policy' && m.env.payload.locked === true, 8000);
  check('无活动 → 学生机收到锁定指令', !!polLock);
  if (polLock) console.log('  cmd.policy(lock) =', JSON.stringify(polLock.env.payload));
  // 发布新计时活动 → 解锁
  const act2 = await api('POST', `/api/v1/sessions/${sessionId}/activities`, { title: '策略活动', timed: true, durationSec: 60 });
  check('发布第二个活动 201', act2.status === 201);
  const polUnlock = await waitForStu(stu.received, (m) => m.env.type === 'cmd' && m.env.payload.action === 'policy' && m.env.payload.locked === false && m.env.payload.reason === 'activity-running', 8000);
  check('有运行活动 → 学生机收到解锁指令', !!polUnlock);
  // 停止该活动 → 重新锁定
  const act2Id = act2.json && act2.json.data && act2.json.data.task && act2.json.data.task.taskId;
  await api('POST', `/api/v1/sessions/${sessionId}/activities/${act2Id}/timer`, { action: 'stop' });
  const polLock2 = await waitForStu(stu.received, (m) => m.env.type === 'cmd' && m.env.payload.action === 'policy' && m.env.payload.locked === true, 8000);
  check('活动结束 → 学生机重新锁定', !!polLock2);
  const polGet = await api('GET', `/api/v1/sessions/${sessionId}/policy`);
  check('查询策略 200', polGet.status === 200 && polGet.json.data.mode === 'activity');
  // 恢复 open 模式，避免干扰后续归还流程
  await api('POST', `/api/v1/sessions/${sessionId}/policy`, { mode: 'open' });

  step('8. 非法报文不得产生孤儿写入（E-REF-01 防护）');
  const before = (await api('GET', `/api/v1/sessions/${sessionId}/tasks`)).json.data.length;
  stu.up(topics.makeEnvelope({
    type: 'task', seat: SEAT, group: 'G2',
    payload: { taskId: 'T-DOES-NOT-EXIST', status: 'done' },
  }));
  await sleep(1200);
  const after = (await api('GET', `/api/v1/sessions/${sessionId}/tasks`)).json.data.length;
  check('孤儿 taskId 不产生新任务', before === after, `${before} -> ${after}`);
  const healthAfter = await api('GET', '/api/v1/system/health');
  check('教师端仍存活（坏消息未打断消息流）', healthAfter.status === 200, `实际 ${healthAfter.status}`);

  step('9. 下课 -> 全部归还 -> 自动关机（dry-run，不真关机）');
  const phase = await api('POST', `/api/v1/sessions/${sessionId}/phase`, { phase: 'return' });
  check('阶段流转到 return', phase.status === 200 && phase.json.data.session.phase === 'return',
    `实际 ${phase.status}`);
  for (let i = 1; i <= SEAT_COUNT; i += 1) {
    const seat = String(i).padStart(2, '0');
    stu.up(topics.makeEnvelope({ type: 'return', seat, group: 'G1', payload: { allReturned: i === SEAT_COUNT } }));
    await sleep(15);
  }
  const shutdownEv = await waitFor(sse.events, (e) => e.event === 'command.sent' && e.payload.payload.action === 'shutdown');
  check('SSE 收到 command.sent(shutdown)', !!shutdownEv);
  const cmdShutdown = await waitForStu(stu.received, (m) => m.env.type === 'cmd' && m.env.payload.action === 'shutdown');
  check('学生机收到 shutdown 指令', !!cmdShutdown);
  if (cmdShutdown) {
    console.log('  cmd.shutdown =', JSON.stringify(cmdShutdown.env.payload));
    check('shutdown 携带 HMAC token', !!cmdShutdown.env.payload.token);
  }
  console.log('  （dry-run：仅校验指令下发，未执行任何关机动作）');

  step('10. 导出 xlsx / csv 并落盘');
  const exp = await api('POST', `/api/v1/sessions/${sessionId}/exports`, { formats: ['xlsx', 'csv'] });
  check('POST 导出返回 201', exp.status === 201, `实际 ${exp.status}`);
  const manifest = exp.json && exp.json.data;
  check('返回导出清单', !!manifest && Array.isArray(manifest.files), '');
  if (manifest) {
    console.log('  exportId =', manifest.exportId);
    for (const f of manifest.files) console.log(`  文件: ${f.fileName}  ${f.format}  ${f.sizeBytes} bytes`);
    check('生成 xlsx 文件', manifest.files.some((f) => f.format === 'xlsx'));
    check('生成 csv 文件', manifest.files.some((f) => f.format === 'csv'));
    // 实际下载校验字节数
    for (const f of manifest.files) {
      const dl = await api('GET', `/api/v1/exports/${manifest.exportId}/files/${encodeURIComponent(f.fileName)}`);
      check(`下载 ${f.fileName} 返回 200`, dl.status === 200, `实际 ${dl.status}`);
    }
    // 落盘校验
    const dir = path.join(__dirname, '..', 'exports', manifest.exportId);
    const onDisk = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    console.log('  落盘目录 =', dir);
    console.log('  磁盘文件 =', JSON.stringify(onDisk));
    check('导出目录已落盘', onDisk.length > 0);
    check('xlsx 落盘且非空', onDisk.some((n) => n.endsWith('.xlsx')
      && fs.statSync(path.join(dir, n)).size > 0));
    check('csv 落盘且非空', onDisk.some((n) => n.endsWith('.csv')
      && fs.statSync(path.join(dir, n)).size > 0));
  }

  step('11. 看板快照');
  const snap = await api('GET', '/api/v1/dashboard/snapshot');
  check('GET /api/v1/dashboard/snapshot 返回 200', snap.status === 200, `实际 ${snap.status}`);
  if (snap.json && snap.json.data) {
    const d = snap.json.data;
    console.log('  快照 keys =', JSON.stringify(Object.keys(d)));
    check('快照 session 含活动名', d.session && d.session.activityName === '焊接入门');
  }

  step('11.5 预设包导出 -> 导入（v4：办公端 Studio ↔ 大屏 流转链路）');
  const pkgRes = await api('GET', '/api/v1/presets/export');
  check('GET /presets/export 200 且含本课预设', pkgRes.status === 200 && pkgRes.json && pkgRes.json.data
    && pkgRes.json.data.pkg === 'kct-preset-package'
    && pkgRes.json.data.classes.some((c) => c.presetId === classPresetId), `status=${pkgRes.status}`);
  const pkgBody = pkgRes.json && pkgRes.json.data;
  // 构造"办公端导出包"：本课班级预设（旧时间 → 应 skipped）+ 新班级（→ added）
  const impPkg = {
    pkg: 'kct-preset-package', schemaVersion: 1, exportedAt: Date.now(), source: 'preset-studio',
    classes: [
      { presetId: classPresetId, name: '初二(3)班-旧', totalSeats: 48, groupSize: 6, updatedAt: 1 },
      { presetId: 'CP-SMOKE-IMP', name: '导入测试班', totalSeats: 44, groupSize: 4, updatedAt: Date.now() },
    ],
    activities: [],
  };
  const prev = await api('POST', '/api/v1/presets/import', impPkg);
  check('导入预演：added=1 / skipped>=1', prev.status === 200 && prev.json && prev.json.code === 0
    && prev.json.data.added === 1 && prev.json.data.skipped >= 1,
    prev.json ? JSON.stringify(prev.json.data) : '');
  const impCall = prev.json && prev.json.data.items.find((i) => i.presetId === 'CP-SMOKE-IMP');
  check('预演明细：新班级 action=added', !!impCall && impCall.action === 'added');
  check('预演不落库', (await api('GET', '/api/v1/presets/classes/CP-SMOKE-IMP')).status === 404);
  const commit = await api('POST', '/api/v1/presets/import?commit=true', impPkg);
  check('导入提交 200', commit.status === 200 && commit.json && commit.json.code === 0);
  const gotImp = await api('GET', '/api/v1/presets/classes/CP-SMOKE-IMP');
  check('提交后新班级入库', gotImp.status === 200 && gotImp.json.data.name === '导入测试班');
  const kept = await api('GET', `/api/v1/presets/classes/${classPresetId}`);
  check('本地较新预设未被旧包覆盖（名字保留）', kept.status === 200
    && kept.json.data.name !== '初二(3)班-旧', kept.json ? kept.json.data.name : '');
  const delImp = await api('DELETE', '/api/v1/presets/classes/CP-SMOKE-IMP');
  check('清理导入测试班级', delImp.status === 200);

  step('12. 预设清理');
  const delC = await api('DELETE', `/api/v1/presets/classes/${classPresetId}`);
  const delA = await api('DELETE', `/api/v1/presets/activities/${activityPresetId}`);
  check('删除班级/活动预设 200', delC.status === 200 && delA.status === 200);

  sse.close();
  stu.client.end(true);
  console.log(`\n冒烟完成：${pass} 通过, ${failCount} 失败`);
  process.exit(failCount > 0 ? 1 : 0);
}

const HARD_TIMEOUT = setTimeout(() => {
  console.log('\n冒烟超时（180s），强制退出');
  process.exit(1);
}, 180000);
HARD_TIMEOUT.unref();

main().catch((e) => {
  console.error('冒烟脚本异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
