'use strict';
// =============================================================================
// V-12 并发压测：N 台"学生机"协议级全流程模拟（真实 broker + 真实 teacher server）
// 场景：25 台同时 hello→checkin（带器材借）→ 教师发布活动 → 全部任务上报 →
//       下课 → 归还 → 教师结束课堂。验证大屏聚合、无掉线、无越界、延迟分布。
// 用法：起好 SIoT broker(1883) 与 teacher server(3000) 后：
//       node test/stress.sim.js [N]   （默认 25，建议 25~50）
// 退出码：0=达标（全登 / 全上报 / 全归还 / 收到下课与关机广播），1=失败
// =============================================================================
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const TOPICS = require(path.join(__dirname, '..', '..', 'shared', 'topics.js'));
const mqtt = require('mqtt');

const API = 'http://127.0.0.1:3000/api/v1';
const N = Math.max(2, Number(process.argv[2]) || 25);
const SEATS = N; // 座位数=并发数：全部归还后 autoShutdown 才能满足"全员归还"触发
const TIME = Date.now();
let studentsDone = 0;

async function http(method, url, body) {
  const r = await fetch(API + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- 一台"学生机"：connect → hello → 等 sync → checkin → 任务上报 → 归还 ----
function spawnStudent(seatNo, report) {
  return new Promise((resolve) => {
    const seat = String(seatNo).padStart(2, '0');
    const machineId = 'SIM-' + String(seatNo).padStart(3, '0');
    const client = mqtt.connect('mqtt://127.0.0.1:1883', {
      clientId: 'sim-' + machineId.toLowerCase(),
      username: 'siot', password: 'dfrobot', clean: true,
      connectTimeout: 5000, reconnectPeriod: 0,
    });
    let phase = 'pre';
    const t0 = Date.now();
    let helloAt = 0;
    let syncAt = 0;
    let taskBroadcast = 0;
    let endBroadcast = 0;
    let shutBroadcast = 0;
    let equip = [];
    const done = (ok, why) => {
      try { client.end(true); } catch (_e) { /* noop */ }
      report({ seat, ok, why, helloMs: syncAt ? syncAt - helloAt : -1,
        taskBroadcast, endBroadcast, shutBroadcast });
      resolve();
    };
    client.on('connect', async () => {
      await client.subscribeAsync([TOPICS.CMD_BROADCAST, TOPICS.SYNC], { qos: 1 }).catch(() => {});
      // hello
      const hello = TOPICS.makeEnvelope({ type: 'hello', seat, group: '*', machineId,
        payload: { machineId } });
      client.publishAsync(TOPICS.STU_UP, JSON.stringify(hello), { qos: 1 }).catch(() => {});
      helloAt = Date.now();
    });
    client.on('message', (topic, buf) => {
      let env;
      try { env = JSON.parse(buf.toString()); } catch (_e) { return; }
      if (topic === TOPICS.SYNC && env.payload && env.payload.seatId === seat) { /* placeholder */ }
      if (topic === TOPICS.SYNC && (String(env.seat) === seat || env.seat === '*')) {
        const p = env.payload || {};
        phase = p.phase || phase;
        if (phase === 'checkin') {
          syncAt = Date.now();
          equip = p.equipment || [];
          // checkin：登记姓名 + 借第一件器材（若清单有）
          const eqs = equip.length ? [{ eqId: equip[0].eqId, qty: 1 }] : [];
          const ck = TOPICS.makeEnvelope({ type: 'checkin', seat, group: '*', machineId,
            payload: { name: '学生' + seatNo, studentNo: String(seatNo).padStart(3, '0'), equipments: eqs } });
          client.publishAsync(TOPICS.STU_UP, JSON.stringify(ck), { qos: 1 }).catch(() => {});
        }
      } else if (topic === TOPICS.CMD_BROADCAST) {
        const p = env.payload || {};
        if (p.action === 'task' && p.task && p.task.taskId) {
          taskBroadcast += 1;
          // 上报一次状态（doing→done 的模拟发 done）
          const st = TOPICS.makeEnvelope({ type: 'task', seat, group: '*', machineId,
            payload: { taskId: p.task.taskId, status: 'done' } });
          client.publishAsync(TOPICS.STU_UP, JSON.stringify(st), { qos: 1 }).catch(() => {});
        } else if (p.action === 'end') {
          endBroadcast += 1;
          // 归还（模拟全部交还）
          const rt = TOPICS.makeEnvelope({ type: 'return', seat, group: '*', machineId,
            payload: { note: '', allReturned: true } });
          client.publishAsync(TOPICS.STU_UP, JSON.stringify(rt), { qos: 1 }).catch(() => {});
        } else if (p.action === 'shutdown') {
          shutBroadcast += 1;
          done(true, 'ok');
        }
      }
    });
    client.on('error', () => done(false, 'mqtt-error'));
    // 兜底超时
    setTimeout(() => done(shutBroadcast > 0, 'timeout'), 60000);
  });
}

async function main() {
  const stats = [];
  // 0) 清理旧会话（保证干净）
  try {
    const cur = await http('GET', '/dashboard/snapshot');
    if (cur.data && cur.data.session && cur.data.session.phase !== 'closed') {
      await http('POST', '/session/finish').catch(() => {});
    }
  } catch (_e) { /* server 未起则后续会失败 */ }

  // 1) 开始上课（座位 60）
  const s = await http('POST', '/sessions', { teacher: '压测教师', className: '并发压测班', totalSeats: SEATS });
  if (!s.data || !s.data.session) { console.error('开课失败', JSON.stringify(s)); process.exit(1); }
  const sid = s.data.session.sessionId;
  console.log(`[S] 开课 ${sid}，并发学生 ${N} 台`);

  // 2) 25 台同时 hello→checkin
  const tStart = Date.now();
  const jobs = [];
  for (let i = 1; i <= N; i += 1) jobs.push(spawnStudent(i, (r) => stats.push(r)));
  // 3) 等 checkin 全落库：轮询 snapshot.stats.checkedIn 直到全部已登记（≤20s）
  let registered = 0;
  for (let w = 0; w < 40; w += 1) {
    await sleep(500);
    const snap = await http('GET', '/dashboard/snapshot');
    const st = (snap.data && snap.data.stats) || {};
    registered = st.checkedIn || 0;
    if (registered >= N) break;
  }
  console.log(`[C] 全量登记 ${registered}/${N}（用时 ${Date.now() - tStart}ms）`);

  // 4) 发布计时活动（1 分钟，学生会立刻回 done；任务无需等计时）
  const act = await http('POST', `/sessions/${sid}/activities`, {
    source: 'custom', title: '并发压测任务', desc: 'V-12', timed: false,
  });
  console.log('[T] 活动已发布', !!act.data && !!act.data.task);

  // 5) 等任务状态 ≥ N 条（poll snapshot.stats.taskDone 30s）
  let taskDone = 0;
  for (let w = 0; w < 60; w += 1) {
    await sleep(500);
    const snap = await http('GET', '/dashboard/snapshot');
    const st = (snap.data && snap.data.stats) || {};
    taskDone = st.taskDone || 0;
    if (taskDone >= N) break;
  }
  console.log(`[D] 任务完成上报 ${taskDone}/${N}`);

  // 6) 下课（return）→ 归还 → autoShutdown
  await http('POST', '/session/end');
  // 7) 等关机广播（全部归还触发），最久 25s
  await sleep(1000);
  let doneCnt = 0;
  for (let w = 0; w < 50; w += 1) {
    await sleep(400);
    doneCnt = stats.filter((x) => x.shutBroadcast > 0).length;
    if (doneCnt >= N) break;
  }
  console.log(`[R] 归还完成并收到关机广播 ${doneCnt}/${N}`);

  // 8) 结束归档
  await http('POST', '/session/finish').catch(() => {});

  // 汇总
  const helloMs = stats.filter((x) => x.helloMs >= 0).map((x) => x.helloMs).sort((a, b) => a - b);
  const pct = (p) => (helloMs.length ? helloMs[Math.min(helloMs.length - 1, Math.floor(helloMs.length * p))] : -1);
  const bad = stats.filter((x) => !x.ok);
  console.log(`[Z] 学生完成=${stats.length}/${N} 失败=${bad.length} ${bad[0] ? '示例:' + bad[0].why : ''}`);
  console.log(`[Z] hello→sync 延迟 P50=${pct(0.5)}ms P95=${pct(0.95)}ms MAX=${helloMs.length ? helloMs[helloMs.length - 1] : -1}ms`);
  const pass = stats.length === N && registered >= N && taskDone >= N && doneCnt >= N && bad.length === 0;
  console.log(pass ? 'V-12 并发压测：达标 ✓' : 'V-12 并发压测：未达标 ✗');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
