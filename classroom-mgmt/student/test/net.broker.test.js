'use strict';
// =============================================================================
// 真机联调测试：把渲染层真实的 net.js 加载进 Node（vm 沙箱 + 真实 mqtt 包），
// 直连 SIoT2 的 WebSocket 1888/ws，验证四主题精确订阅、上下行收发、协议降级。
//
// 必须在同一条 shell 命令里起 broker 再跑本文件（沙箱会回收后台进程）：
//   cd SIoT_V2_Win_2618/SIoT_V2_Win_2618 && ./main.exe -c conf/config.json &
//   sleep 5 && node classroom-mgmt/student/test/net.broker.test.js
// =============================================================================
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mqttLib = require('mqtt');

const ROOT = path.resolve(__dirname, '..', '..');
const NET_SRC = path.join(ROOT, 'student', 'renderer', 'net.js');
const TOPICS = require(path.join(ROOT, 'shared', 'topics.js'));

const HOST = process.env.SIOT_IP || '127.0.0.1';
const WS_PORT = Number(process.env.SIOT_WS_PORT || 1888);
const TCP_PORT = Number(process.env.SIOT_TCP_PORT || 1883);
const MACHINE_ID = 'M-broker01';

// ---------------------------------------------------------------------------
// 把 net.js 原样加载进沙箱（不改动、不复制一份逻辑，测的就是渲染层跑的那份代码）
// ---------------------------------------------------------------------------
function loadNet() {
  const sandbox = {
    mqtt: mqttLib,
    ClassroomTopics: TOPICS,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(NET_SRC, 'utf8'), sandbox, { filename: 'net.js' });
  return sandbox.Net;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  // eslint-disable-next-line no-console
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok ? '' : ' -> ' + (detail || '')));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(predicate, ms, label) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - started > ms) {
        // eslint-disable-next-line no-console
        console.log('        （等待超时: ' + label + '）');
        return resolve(false);
      }
      return setTimeout(tick, 100);
    };
    tick();
  });
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('\nSIoT2 真机联调  ws://' + HOST + ':' + WS_PORT + '/ws  tcp://' + HOST + ':' + TCP_PORT);

  // ---- 教师侧监听（TCP 1883，模拟教师端 bridge 的订阅方式）----
  const teacher = mqttLib.connect('mqtt://' + HOST + ':' + TCP_PORT, {
    clientId: 'teacher_brokertest',
    username: 'siot',
    password: 'dfrobot',
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 8000,
  });
  const up = [];
  const hb = [];
  teacher.on('message', (topic, payload) => {
    const env = JSON.parse(payload.toString());
    if (topic === TOPICS.STU_UP) up.push({ topic, env });
    if (topic === TOPICS.STU_HB) hb.push({ topic, env });
  });
  teacher.on('error', (e) => {
    // eslint-disable-next-line no-console
    console.log('        [teacher] ' + e.message);
  });

  await new Promise((resolve) => {
    teacher.on('connect', resolve);
    setTimeout(resolve, 9000);
  });
  if (!teacher.connected) {
    // eslint-disable-next-line no-console
    console.log('  SKIP  教师侧连不上 tcp://' + HOST + ':' + TCP_PORT + '，broker 未启动');
    process.exit(2);
  }
  // 精确主题订阅（与教师端 bridge 一致，不用通配符）
  await new Promise((resolve) => teacher.subscribe([TOPICS.STU_UP, TOPICS.STU_HB], { qos: 1 }, resolve));

  // ---- 学生侧：真实的 net.js ----
  const Net = loadNet();
  const net = Net.create({
    url: 'ws://' + HOST + ':' + WS_PORT + '/ws',
    clientId: 'stu_' + MACHINE_ID,
    username: 'siot',
    password: 'dfrobot',
  });

  const states = [];
  const received = [];
  net.on('state', (s) => states.push(s));
  net.on('message', (m) => received.push(m));
  net.start();

  const online = await waitFor(() => net.isOnline(), 15000, '学生端 WS 连接');
  check('学生端经 WebSocket 1888/ws 连上 SIoT2', online,
    '状态序列: ' + states.map((s) => s.state).join(' -> '));

  const connState = states.filter((s) => s.state === 'online').pop();
  check('协议版本已确定（v4 或降级 3.1.1）', !!(connState && connState.proto),
    JSON.stringify(connState));
  if (connState && connState.proto) {
    // eslint-disable-next-line no-console
    console.log('        实际协商协议: MQTT ' + connState.proto);
  }

  // ---- 上行：checkin ----
  const checkinEnv = TOPICS.makeEnvelope({
    type: 'checkin',
    seat: '07',
    group: '*',
    machineId: MACHINE_ID,
    payload: {
      name: '陈书瑶',
      studentNo: '2024070312',
      equipments: [{ eqId: 'DEV-BOARD', qty: 1 }, { eqId: 'DUPONT', qty: 5 }],
    },
  });
  net.publishUp(checkinEnv);
  const gotCheckin = await waitFor(() => up.some((m) => m.env.type === 'checkin'), 4000, '上行 checkin');
  const ck = up.filter((m) => m.env.type === 'checkin').pop();
  check('上行 checkin 经 siot/ict_up 送达教师端', gotCheckin);
  check('上行 checkin 字段完整（seat 补零 / machineId / equipments）',
    !!(ck && ck.env.seat === '07' && ck.env.machineId === MACHINE_ID
      && ck.env.payload.equipments.length === 2 && ck.env.payload.name === '陈书瑶'),
    ck ? JSON.stringify(ck.env) : '未收到');

  // ---- 上行：心跳（QoS0，走 siot/ict_hb）----
  net.publishHeartbeat(TOPICS.makeEnvelope({
    type: 'status', seat: '07', group: '*', machineId: MACHINE_ID,
    payload: { online: true, phase: 'task' },
  }));
  const gotHb = await waitFor(() => hb.length > 0, 4000, '心跳');
  check('心跳 status 经 siot/ict_hb 送达教师端（与业务上行分离）', gotHb);
  check('心跳没有混进业务主题 siot/ict_up',
    !up.some((m) => m.env.type === 'status'), '心跳跑到业务主题了');

  // ---- 下行：cmd（教师 -> 学生，精确主题）----
  await new Promise((resolve) => teacher.publish(TOPICS.CMD_BROADCAST,
    JSON.stringify(TOPICS.makeCommand({
      action: 'task',
      payload: { task: { taskId: 'T-TEST0001', title: '点亮第一颗 LED', desc: '接好电路后点已完成' } },
    })), { qos: 1 }, resolve));
  const gotCmd = await waitFor(() => received.some((m) => m.env.type === 'cmd'), 4000, '下行 cmd');
  const cmd = received.filter((m) => m.env.type === 'cmd').pop();
  check('下行 cmd 经 siot/ict_cmd 送达学生端', gotCmd);
  check('下行 cmd.task 结构可被学生端直接消费',
    !!(cmd && cmd.env.payload.action === 'task'
      && cmd.env.payload.task.taskId === 'T-TEST0001'),
    cmd ? JSON.stringify(cmd.env.payload) : '未收到');

  // ---- 下行：sync（只认自己座位）----
  await new Promise((resolve) => teacher.publish(TOPICS.SYNC,
    JSON.stringify(TOPICS.makeSync({
      seat: '07', sessionId: 'S-TEST', phase: 'task',
      currentTask: { taskId: 'T-TEST0001', title: '点亮第一颗 LED' },
      checkinDone: true, returnDone: false,
    })), { qos: 1 }, resolve));
  const gotSync = await waitFor(() => received.some((m) => m.env.type === 'sync'), 4000, '下行 sync');
  const sync = received.filter((m) => m.env.type === 'sync').pop();
  check('下行 sync 经 siot/ict_sync 送达学生端', gotSync);
  check('sync 带 seat，学生端可过滤非自己的广播',
    !!(sync && sync.env.seat === '07' && sync.env.payload.checkinDone === true),
    sync ? JSON.stringify(sync.env) : '未收到');

  // ---- 通配符能力探测（实测记录，2026-08-31）----
  // 实测结论：`siot/#` 在 SIoT2 上可以订阅并收到消息（# 通配符可用）；
  // 而 spike 阶段 `ICTClass/+/#`（含 + 单级通配）被 suback 128 拒绝。
  // 即 SIoT2 对 `+` 与 `#` 的处理不一致。设计仍用四硬编码精确主题（TOPIC_PLAN=B）：
  // 精确主题路由意图清晰、无跨主题串扰风险，且不依赖 broker 通配符行为差异。
  const wildcard = mqttLib.connect('mqtt://' + HOST + ':' + TCP_PORT, {
    clientId: 'teacher_wildcard', username: 'siot', password: 'dfrobot',
    protocolVersion: 4, clean: true, reconnectPeriod: 0, connectTimeout: 8000,
  });
  let wildcardGot = 0;
  let wildcardSubscribed = false;
  wildcard.on('message', () => { wildcardGot += 1; });
  await new Promise((resolve) => {
    wildcard.on('connect', resolve);
    setTimeout(resolve, 8000);
  });
  await new Promise((resolve) => {
    wildcard.subscribe('siot/#', { qos: 1 }, (err) => {
      wildcardSubscribed = !err;
      resolve();
    });
  });
  await new Promise((resolve) => teacher.publish(TOPICS.STU_UP,
    JSON.stringify(TOPICS.makeEnvelope({ type: 'status', seat: '07', machineId: MACHINE_ID, payload: { online: true } })),
    { qos: 1 }, resolve));
  await sleep(1200);
  // 断言实测事实：`siot/#` 可订阅且能收到消息（# 通配符可用，与 + 不同）
  check('通配符能力：siot/# 可订阅且收到消息（实测 # 可用；+ 在 spike 中被拒）',
    wildcardSubscribed && wildcardGot >= 1,
    'subscribed=' + wildcardSubscribed + ' 收到 ' + wildcardGot + ' 条');

  // ---- 收尾 ----
  net.stop();
  wildcard.end(true);
  teacher.end(true);
  await sleep(300);

  const failed = results.filter((r) => !r.ok);
  // eslint-disable-next-line no-console
  console.log('\n结果：' + (results.length - failed.length) + ' 通过 / ' + failed.length + ' 失败');
  if (failed.length) process.exit(1);
  process.exit(0);
}

const guard = setTimeout(() => {
  // eslint-disable-next-line no-console
  console.log('\n整体超时 40s，强制退出');
  process.exit(1);
}, 40000);
guard.unref();

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('测试异常:', e && e.stack);
  process.exit(1);
});
