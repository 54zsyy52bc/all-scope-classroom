'use strict';
// =============================================================================
// 教师端指令模拟器（手工联调用）
//
// 与 scripts/qy-integration.js 的区别：
//   qy-integration.js  自动化 —— 自己起一个「无窗口」Electron 跑断言，跑完就退
//   teach-sim.js       手工     —— 只往 broker 发指令，不动 Electron，
//                                 让你对着「自己开着的绿网窗口」肉眼看反应
//
// 典型用法（两个终端）：
//   终端 A：cd green-net && npm run dev          ← 绿网窗口开着
//   终端 B：node scripts/teach-sim.js seq        ← 一键跑完整剧本，看 A 的反应
//
// 单独发某一条：
//   node scripts/teach-sim.js lock             锁定课堂
//   node scripts/teach-sim.js unlock           解除锁定
//   node scripts/teach-sim.js task "搭建智能小车" 5
//   node scripts/teach-sim.js timer pause 240  倒计时暂停在第 240 秒
//   node scripts/teach-sim.js timer resume
//   node scripts/teach-sim.js end              下课（清活动 + 解锁）
//   node scripts/teach-sim.js sync --seat 01   按座位下发一次同步（测座位过滤）
//   node scripts/teach-sim.js watch            只看上行：学生端心跳与上报
//
// 前置：本机 SIoT 在跑（MQTT 1883）。broker 地址默认读 app-config.json 的 qy 段，
//       也可用 SIOT_HOST / SIOT_TCP_PORT 环境变量覆盖。
// =============================================================================
const path = require('node:path');
const fs = require('node:fs');

const APP_ROOT = path.join(__dirname, '..');
// eslint-disable-next-line global-require
const topics = require(path.join(APP_ROOT, 'src', 'shared', 'topics.js'));
// eslint-disable-next-line global-require
const mqtt = require('mqtt');

// ---- broker 配置：优先 env，其次 app-config.json，最后内置默认 ----
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'app-config.json'), 'utf8')); } catch (_e) { /* 用默认 */ }
const qy = (fileCfg && fileCfg.qy) || {};
const BROKER = {
  host: process.env.SIOT_HOST || qy.host || '127.0.0.1',
  port: Number(process.env.SIOT_TCP_PORT || qy.port || 1883),
};
const CRED = { username: qy.username || 'siot', password: qy.password || 'dfrobot' };
const DEFAULT_SEAT = String((fileCfg && fileCfg.seat) || '01');

function usage() {
  const lines = [
    '绿网 · 教师端指令模拟器',
    '',
    '用法：node scripts/teach-sim.js <命令> [参数...]',
    '',
    '命令：',
    '  seq                       一键跑完整剧本（锁定→活动→计时暂停→解锁）',
    '  lock   [理由]              锁定课堂',
    '  unlock [理由]              解除锁定',
    '  end                       下课（解锁 + 清活动）',
    '  task   <标题> [分钟]        下发课堂活动（默认 5 分钟倒计时）',
    '  timer  pause|resume [秒]    暂停 / 恢复活动倒计时',
    '  sync   [--seat 01]         按座位下发一次状态同步（测座位过滤）',
    '  watch                      只监听上行（学生端心跳 / 上报），不下发',
    '',
    '全局选项：',
    '  --seat <号>                指定操作的座位号（默认 ' + DEFAULT_SEAT + '）',
    '  --host <地址> --port <端口>  覆盖 broker 地址',
    '',
    'broker：' + BROKER.host + ':' + BROKER.port + '   （改 app-config.json 的 qy 段即可）',
  ];
  console.log(lines.join('\n'));
}

// ---- 参数解析：把 --x value / --x=value 摘出来，其余留作位置参数 ----
function parseArgs(argv) {
  const opts = { seat: DEFAULT_SEAT, host: BROKER.host, port: BROKER.port };
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const val = eq >= 0 ? a.slice(eq + 1) : argv[i + 1];
      const takesValue = ['seat', 'host', 'port', 'reason', 'title', 'min'].includes(key);
      if (takesValue && eq < 0) i += 1;
      if (key === 'seat') opts.seat = String(val);
      else if (key === 'host') opts.host = String(val);
      else if (key === 'port') opts.port = Number(val);
      else if (key === 'reason') opts.reason = String(val);
    } else {
      pos.push(a);
    }
  }
  return { opts, pos };
}

function connect(opts, clientId) {
  return new Promise((resolve) => {
    const c = mqtt.connect(`mqtt://${opts.host}:${opts.port}`, {
      clientId: 'TEACHSIM_' + clientId + '_' + Math.random().toString(36).slice(2, 6),
      username: CRED.username, password: CRED.password,
      clean: true, reconnectPeriod: 0, connectTimeout: 5000, protocolVersion: 4,
    });
    let settled = false;
    c.once('connect', () => { if (!settled) { settled = true; resolve(c); } });
    c.once('error', (e) => {
      if (settled) return;
      settled = true;
      console.error('✗ 连不上 broker ' + opts.host + ':' + opts.port + ' —— ' + e.message);
      console.error('  先启动 SIoT： cd SIoT_V2_Win_2618/SIoT_V2_Win_2618 && ./main.exe -c conf/config.json');
      try { c.end(true); } catch (_e) { /* noop */ }
      resolve(null);
    });
    setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 6000);
  });
}

function pub(client, env, label) {
  return new Promise((resolve) => {
    client.publish(topics.CMD_BROADCAST, JSON.stringify(env), { qos: 1 }, () => {
      console.log('  → ' + label);
      resolve();
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 各命令的信封构造（一律走 shared/topics.js 工厂，保证与被测实现契约逐字一致）----
function envLock(reason) {
  return topics.makeCommand({ action: 'policy', payload: { mode: 'locked', locked: true, reason: reason || '课堂进行中' } });
}
function envUnlock(reason) {
  return topics.makeCommand({ action: 'policy', payload: { mode: 'open', locked: false, reason: reason || '下课' } });
}
function envTask(title, minutes) {
  const sec = Math.max(1, Math.round((minutes || 5) * 60));
  return topics.makeCommand({
    action: 'task',
    payload: {
      taskId: 'T-SIM-' + Date.now().toString(36).toUpperCase(),
      title: title || '课堂活动',
      desc: '由 teach-sim 下发的模拟活动',
      source: 'activity', timed: true, durationSec: sec,
      timerState: 'running', remainingMs: sec * 1000,
    },
  });
}
function envTimer(action, remainSec) {
  // ★ 注意：子动作字段是 payload.timerAction，不是 payload.action（后者会被覆盖成 'task_timer'）
  return topics.makeCommand({
    action: 'task_timer',
    payload: { timerAction: action, remainingMs: Math.max(0, Math.round((remainSec || 0) * 1000)) },
  });
}
function envEnd() {
  return topics.makeCommand({ action: 'end', payload: { reason: '下课' } });
}
// sync 与上面不同：它是「按座位」的（seat 在信封顶层），正是座位过滤要测的点
function envSync(seat, locked) {
  return topics.makeSync({
    seat: String(seat),
    phase: 'task',
    policy: { mode: locked ? 'locked' : 'open', locked: !!locked, reason: '教师端同步（座位 ' + seat + '）' },
  });
}

async function main() {
  const argvRaw = process.argv.slice(2);
  if (!argvRaw.length || argvRaw.includes('-h') || argvRaw.includes('--help')) { usage(); return; }

  const { opts, pos } = parseArgs(argvRaw);
  const cmd = pos[0];

  // ---- 先校验命令，再去连 broker ----
  // 顺序有讲究：先连再报「命令写错了」会白等一次 6s 连接超时，课堂现场尤其难受。
  const KNOWN = ['lock', 'unlock', 'end', 'task', 'timer', 'sync', 'seq', 'watch'];
  if (!KNOWN.includes(cmd)) {
    console.error('✗ 未知命令：' + cmd + '\n');
    usage();
    process.exitCode = 2;
    return;
  }
  if (cmd === 'timer' && !['pause', 'resume', 'stop', 'reset'].includes(String(pos[1] || '').toLowerCase())) {
    console.error('✗ timer 的子动作应为 pause / resume / stop / reset\n');
    usage();
    process.exitCode = 2;
    return;
  }

  // ---- watch：只订阅上行 ----
  if (cmd === 'watch') {
    const c = await connect(opts, 'WATCH');
    if (!c) { process.exit(1); return; }
    c.subscribe([topics.STU_HB, topics.STU_UP, topics.SYNC], { qos: 0 }, () => {
      console.log('已订阅上行：' + topics.STU_HB + '（心跳） / ' + topics.STU_UP + '（上报） / ' + topics.SYNC + '（同步）');
      console.log('等待学生端消息…（Ctrl+C 退出）\n');
    });
    c.on('message', (t, buf) => {
      let body = '';
      try { body = JSON.stringify(JSON.parse(buf.toString())); } catch (_e) { body = buf.toString().slice(0, 200); }
      if (body.length > 300) body = body.slice(0, 300) + '…';
      console.log(new Date().toLocaleTimeString() + '  [' + t + ']\n    ' + body);
    });
    return; // 不退出，保持常驻
  }

  const c = await connect(opts, String(cmd || 'CMD').toUpperCase().slice(0, 6));
  if (!c) { process.exit(1); return; }
  console.log('已连上 broker ' + opts.host + ':' + opts.port + '（座位 ' + opts.seat + '）');

  try {
    switch (cmd) {
      case 'lock': {
        await pub(c, envLock(opts.reason), 'cmd policy { locked:true, reason:' + (opts.reason || '课堂进行中') + ' }');
        console.log('\n  绿网窗口应立即切到「课堂锁定」页。');
        break;
      }
      case 'unlock': {
        await pub(c, envUnlock(opts.reason), 'cmd policy { locked:false, reason:' + (opts.reason || '下课') + ' }');
        console.log('\n  绿网窗口应恢复到锁定前的页面。');
        break;
      }
      case 'end': {
        await pub(c, envEnd(), 'cmd end { reason:下课 }');
        await sleep(300);
        await pub(c, envUnlock('下课'), 'cmd policy { locked:false, reason:下课 }');
        console.log('\n  活动条应清空、锁定解除。');
        break;
      }
      case 'task': {
        const title = pos[1] || '课堂活动';
        const minutes = Number(pos[2] || 5);
        await pub(c, envTask(title, minutes), 'cmd task { ' + title + ', ' + minutes + ' 分钟 }');
        console.log('\n  界面上应出现活动条与倒计时。');
        break;
      }
      case 'timer': {
        const action = String(pos[1] || '').toLowerCase(); // 合法性已在连接前校验
        const remain = Number(pos[2] || 0);
        await pub(c, envTimer(action, remain), 'cmd task_timer { timerAction:' + action
          + (remain ? ', remainingMs:' + Math.round(remain * 1000) : '') + ' }');
        console.log('\n  倒计时应' + (action === 'pause' ? '停住' : action === 'resume' ? '继续走' : '被重置') + '。');
        break;
      }
      case 'sync': {
        const locked = pos.includes('--locked');
        await pub(c, envSync(opts.seat, locked), 'sync { seat:' + opts.seat
          + ', policy.locked:' + locked + ' }');
        console.log('\n  座位过滤的判定：绿网「系统设置 → 座位号」若为空，任何座位的 sync 都会被应用；');
        console.log('  若已设为 ' + opts.seat + '，则本机生效；设成别的号（如 --seat 99）本机应忽略。');
        break;
      }
      case 'seq': {
        console.log('\n—— 开始下发剧本（每条间隔 1.5s，看着绿网窗口）——');
        await sleep(300);
        await pub(c, envLock('课堂进行中'), '1/4 cmd policy { locked:true }');
        await sleep(1500);
        await pub(c, envTask('搭建智能小车', 5), '2/4 cmd task { 搭建智能小车, 5 分钟 }');
        await sleep(1500);
        await pub(c, envTimer('pause', 240), '3/4 cmd task_timer { timerAction:pause }');
        await sleep(1500);
        await pub(c, envUnlock('下课'), '4/4 cmd policy { locked:false }');
        console.log('\n—— 剧本结束。预期：先出现锁定页 → 解锁后回到首页，');
        console.log('   顶部活动条显示「搭建智能小车」且倒计时处于暂停态。');
        break;
      }
      default: {
        console.error('✗ 未知命令：' + cmd + '\n');
        usage();
        process.exitCode = 2;
      }
    }
  } finally {
    // 等 publish 的 QoS1 回执送达再断开，否则可能丢包
    await sleep(250);
    try { c.end(true); } catch (_e) { /* noop */ }
  }
}

main().catch((e) => {
  console.error('模拟器异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
