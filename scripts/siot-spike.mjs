/**
 * SIoT V2 能力验证脚本（ARCH_v1 §10 的 P0 闸口）
 *
 * 目的：把三个只能实测才能定论的未知项收口，再决定主题方案与连接参数。
 *   1) WebSocket 接入是否为 1888 + /ws
 *   2) 三级自定义主题 ICTClass/... 是否被转发、是否支持 + / # 通配符
 *   3) MQTT 协议版本（3.1.1 还是 3.1）
 * 附带确认：两级 siot/* 主题、retained、LWT。
 *
 * 用法：
 *   npm i mqtt@5.15.2
 *   node scripts/siot-spike.mjs <SIOT_IP> [user] [pass]
 * 例：
 *   node scripts/siot-spike.mjs 192.168.1.100
 *
 * 输出：逐项 PASS/FAIL + 汇总表 + 依据 ARCH_v1 §10 决策规则给出的 TOPIC_PLAN 建议。
 */

import mqtt from 'mqtt';

const IP = process.argv[2] || '127.0.0.1';
const AUTH = { username: process.argv[3] || 'siot', password: process.argv[4] || 'dfrobot' };

const WS_PORT = 1888;
const WS_PATH = '/ws';
const TCP_PORT = 1883;

const results = [];
const clients = new Set();

function log(id, ok, note = '') {
  results.push({ 验证项: id, 结果: ok ? 'PASS' : 'FAIL', 备注: note });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}${note ? '  -> ' + note : ''}`);
}

/** 建立连接，恒定 resolve，不抛异常，便于顺序编排 */
function conn(url, opts = {}) {
  return new Promise(resolve => {
    let settled = false;
    const c = mqtt.connect(url, {
      ...AUTH,
      connectTimeout: 6000,
      reconnectPeriod: 0, // 验证阶段禁用自动重连，避免干扰结果
      ...opts,
    });
    clients.add(c);
    const done = (ok, note) => {
      if (settled) return;
      settled = true;
      resolve({ ok, note, c });
    };
    c.once('connect', () => done(true, ''));
    c.once('error', e => done(false, e.message));
    setTimeout(() => done(false, 'timeout 6.5s'), 6500);
  });
}

/** 等待指定 topic 上的一条消息，超时返回 null */
function expectMsg(c, topic, ms = 3000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      c.removeListener('message', onMsg);
      resolve(null);
    }, ms);
    function onMsg(tp, payload) {
      if (tp !== topic) return;
      clearTimeout(timer);
      c.removeListener('message', onMsg);
      resolve(payload.toString());
    }
    c.on('message', onMsg);
  });
}

const envelope = (type, seat = '07') =>
  JSON.stringify({ msgId: `spike-${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(), type, seat, group: 'G2', payload: {} });

function cleanup() {
  for (const c of clients) {
    try { c.end(true); } catch { /* ignore */ }
  }
}

async function main() {
  console.log(`\nSIoT V2 能力验证  目标 ${IP}  账号 ${AUTH.username}\n${'-'.repeat(60)}`);

  // ---- V-1 WebSocket 1888/ws ----
  const ws = await conn(`ws://${IP}:${WS_PORT}${WS_PATH}`);
  log(`V-1 WS ${WS_PORT}${WS_PATH}`, ws.ok, ws.ok ? '' : `${ws.note}（若失败，从 start SIoT.bat 黑窗读取实际 WS 监听地址）`);

  // ---- V-2 TCP 1883 ----
  const tcp = await conn(`mqtt://${IP}:${TCP_PORT}`);
  log(`V-2 TCP ${TCP_PORT}`, tcp.ok, tcp.note);

  // ---- V-3 协议版本 ----
  if (tcp.ok) {
    log('V-3 协议版本', true, 'protocolVersion 4 (MQTT 3.1.1) 可用');
  } else {
    const v3 = await conn(`mqtt://${IP}:${TCP_PORT}`, { protocolVersion: 3, protocolId: 'MQIsdp' });
    log('V-3 协议版本', v3.ok, v3.ok ? '需改用 protocolVersion 3 + protocolId MQIsdp' : '3.1.1 与 3.1 均失败，检查凭据/端口');
  }

  if (!(tcp.ok && ws.ok)) {
    console.log('\n基础连通性未通过，跳过 V-4 至 V-8。请先解决端口/防火墙/凭据问题。');
    return;
  }

  const pub = tcp.c;  // 发布端走 TCP（教师端形态）
  const sub = ws.c;   // 订阅端走 WS（学生端形态）

  // ---- V-4 三级自定义主题转发（决定 Plan A 可行性）----
  const T3 = 'ICTClass/STU_07/checkin';
  await sub.subscribeAsync(T3, { qos: 1 });
  const p4 = expectMsg(sub, T3);
  await pub.publishAsync(T3, envelope('checkin'), { qos: 1 });
  const v4 = !!(await p4);
  log('V-4 三级主题转发', v4, v4 ? 'ICTClass/STU_07/checkin 可用' : '三级主题不被转发，需切 Plan B');

  // ---- V-5 通配符订阅（决定教师端订阅方式）----
  const wc = await conn(`ws://${IP}:${WS_PORT}${WS_PATH}`, { clientId: 'spike_wildcard' });
  let v5 = false;
  if (wc.ok) {
    try {
      await wc.c.subscribeAsync('ICTClass/+/#', { qos: 1 });
      const p5 = expectMsg(wc.c, 'ICTClass/STU_09/task');
      await pub.publishAsync('ICTClass/STU_09/task', envelope('task', '09'), { qos: 1 });
      v5 = !!(await p5);
    } catch (e) {
      v5 = false; // 通配符订阅被 broker 拒绝（granted 128），符合 Plan A 不可行
    }
  }
  log('V-5 通配符 + / #', v5, v5 ? 'ICTClass/STU_+/# 可用' : '不支持通配符，教师端需显式订阅 50 个主题');

  // ---- V-6 两级 siot/* 主题（Plan B 前置）----
  await sub.subscribeAsync('siot/ict_up', { qos: 1 });
  const p6 = expectMsg(sub, 'siot/ict_up');
  await pub.publishAsync('siot/ict_up', envelope('checkin'), { qos: 1 });
  const v6 = !!(await p6);
  log('V-6 两级 siot/* 转发', v6, v6 ? 'Plan B 可用' : 'Plan B 亦不可用，需上报阻塞');

  // ---- V-7 retained message（架构不依赖，仅确认）----
  await pub.publishAsync('siot/ict_ret', 'RETAINED_PROBE', { qos: 1, retain: true });
  const rt = await conn(`ws://${IP}:${WS_PORT}${WS_PATH}`, { clientId: 'spike_retain' });
  let v7 = false;
  if (rt.ok) {
    await rt.c.subscribeAsync('siot/ict_ret', { qos: 1 });
    v7 = !!(await expectMsg(rt.c, 'siot/ict_ret', 2500));
  }
  log('V-7 retained', v7, v7 ? '支持（架构仍不依赖，用 hello/sync 握手）' : '不支持（符合预期，架构已用 hello/sync 规避）');

  // ---- V-8 LWT 遗嘱（支持则启用近实时掉线感知）----
  const willTopic = 'siot/ict_hb';
  await sub.subscribeAsync(willTopic, { qos: 0 });
  const will = await conn(`mqtt://${IP}:${TCP_PORT}`, {
    clientId: 'spike_will',
    will: { topic: willTopic, payload: '{"online":false}', qos: 0, retain: false },
  });
  let v8 = false;
  if (will.ok) {
    const p8 = expectMsg(sub, willTopic, 5000);
    will.c.stream.destroy(); // 模拟异常断连（非正常 DISCONNECT），触发遗嘱
    v8 = !!(await p8);
  }
  log('V-8 LWT 遗嘱', v8, v8 ? '可启用，掉线感知 45s -> 近实时' : '不支持，靠 15s 心跳 + 45s 超时兜底');

  // ---- 汇总与决策建议（ARCH_v1 §10 决策规则）----
  console.log(`\n${'-'.repeat(60)}`);
  console.table(results);

  let plan, reason;
  if (v4 && v5) {
    plan = 'A'; reason = '三级主题与通配符均可用，沿用 02 文档主题规划';
  } else if (v4 && !v5) {
    plan = 'A（教师端显式订阅 50 个 seat 主题）'; reason = '三级主题可用但通配符不可用';
  } else if (!v4 && v6) {
    plan = 'B'; reason = '三级主题不可转发，切两级扁平主题';
  } else {
    plan = '无可用方案'; reason = '三级与两级主题均失败，需上报 team-lead 重新评估 broker';
  }
  console.log(`\n建议 TOPIC_PLAN = ${plan}\n依据：${reason}`);
  console.log(`LWT：${v8 ? '启用' : '不启用'}    retained：${v7 ? '支持但不使用' : '不支持（已规避）'}`);
  console.log('\n请把以上结果回填 ARCH_v1.md §10「结果回填区」。');
  console.log('另需人工核对 V-9 conf/config.json、V-10 HTTP WebAPI、V-11 QoS 入库、V-12 50 并发。\n');
}

main()
  .catch(e => { console.error('\n脚本异常：', e); process.exitCode = 1; })
  .finally(() => { cleanup(); setTimeout(() => process.exit(), 300); });
