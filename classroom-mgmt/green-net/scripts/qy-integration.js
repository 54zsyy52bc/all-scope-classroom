'use strict';
// =============================================================================
// 全域联动「落地」联调：真起 Electron + 真 broker，验证锁定/活动/解锁真的落到界面
//
// 为什么不能只靠 unit / 协议集成测试：
//   test/qy-mqtt.integration.js 证明了"桥接收到了指令、状态变量对了"，
//   但证明不了"浏览器真的锁屏了"。这两件事之间隔着 onEvent 接线、
//   setLocked、tabs.navigateInternal 好几跳，任何一跳断了都会表现为
//   "老师点了锁定，学生照样上网"——现场最难解释的那种问题。
//   所以这一层必须真跑 Electron。
//
// 前置：本机 SIoT 正在运行（MQTT 1883）。
//   必须在同一条 shell 命令里起 broker 再跑本文件（沙箱会回收后台进程）：
//     cd SIoT_V2_Win_2618/SIoT_V2_Win_2618 && ./main.exe -c conf/config.json &
//     sleep 5 && node classroom-mgmt/green-net/scripts/qy-integration.js
//
// 用法：node scripts/qy-integration.js   退出码 0 = 通过
// =============================================================================
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');

const APP_ROOT = path.join(__dirname, '..');
const BROKER = { host: '127.0.0.1', port: Number(process.env.SIOT_TCP_PORT || 1883) };

// eslint-disable-next-line global-require
const topics = require(path.join(APP_ROOT, 'src', 'shared', 'topics.js'));

function findElectron() {
  const cands = [
    process.env.ELECTRON_BIN,
    path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (_e) { /* next */ }
  }
  return null;
}

// 与 smoke.js 同样的净化：宿主注入的 ELECTRON_RUN_AS_NODE 会让 electron.exe
// 退化成纯 Node，require('electron') 拿到的是 exe 路径字符串（详见 smoke.js 注释）。
function sanitizeEnv(base) {
  const env = Object.assign({}, base);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

function probeBroker() {
  return new Promise((resolve) => {
    const s = net.connect({ host: BROKER.host, port: BROKER.port });
    const done = (v) => { try { s.destroy(); } catch (_e) { /* noop */ } resolve(v); };
    s.setTimeout(1500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function main() {
  const bin = findElectron();
  if (!bin) {
    console.error('✗ 找不到 Electron 可执行文件。请先在本目录执行 npm install。');
    process.exit(2);
  }

  if (!(await probeBroker())) {
    console.log(`SKIPPED：${BROKER.host}:${BROKER.port} 上没有 MQTT broker。`);
    console.log('  要跑这条联调，请先启动 SIoT：');
    console.log('    cd SIoT_V2_Win_2618/SIoT_V2_Win_2618 && ./main.exe -c conf/config.json');
    process.exit(0);
  }

  // eslint-disable-next-line global-require
  const mqtt = require('mqtt');
  // 教师端模拟器：用 shared/topics.js 的信封工厂，保证与被测实现的契约逐字一致
  const teacher = mqtt.connect(`mqtt://${BROKER.host}:${BROKER.port}`, {
    clientId: 'QYIT_TEACHER_' + Math.random().toString(36).slice(2, 8),
    username: 'siot', password: 'dfrobot',
    clean: true, reconnectPeriod: 0, connectTimeout: 8000, protocolVersion: 4,
  });

  const okConnect = await new Promise((resolve) => {
    teacher.once('connect', () => resolve(true));
    teacher.once('error', (e) => { console.log('教师端模拟器连接失败：' + e.message); resolve(false); });
    setTimeout(() => resolve(false), 8000);
  });
  if (!okConnect) { try { teacher.end(true); } catch (_e) { /* noop */ } process.exit(1); }

  console.log('使用 Electron：' + bin);
  const child = spawn(bin, [APP_ROOT, '--smoke-qy'], {
    cwd: APP_ROOT, env: sanitizeEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let scenarioStarted = false;

  child.stdout.on('data', (b) => {
    const s = b.toString();
    out += s;
    process.stdout.write(s);
    if (!scenarioStarted && out.includes('[qy-smoke] ready')) {
      scenarioStarted = true;
      runScenario();
    }
  });
  child.stderr.on('data', (b) => { out += b.toString(); });

  // 指令序列：锁定 → 活动 → 计时暂停 → 解锁
  // 间隔取 1.2s，留足 setLocked / 页面导航 / 状态推送的时间。
  async function runScenario() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pub = (env) => teacher.publish(topics.CMD_BROADCAST, JSON.stringify(env), { qos: 1 });

    await sleep(400);
    console.log('\n—— 教师端模拟器开始下发 ——');
    pub(topics.makeCommand({
      action: 'policy',
      payload: { mode: 'locked', locked: true, reason: '课堂进行中', phase: 'task' },
    }));
    console.log('  → cmd policy { locked:true, reason:课堂进行中 }');

    await sleep(1200);
    pub(topics.makeCommand({
      action: 'task',
      payload: {
        taskId: 'T-ITEST', title: '搭建智能小车', desc: '用行空板采集温度并上传 SIoT',
        source: 'activity', timed: true, durationSec: 300, timerState: 'running', remainingMs: 300000,
      },
    }));
    console.log('  → cmd task { 搭建智能小车, 5 分钟计时 }');

    await sleep(1200);
    pub(topics.makeCommand({
      action: 'task_timer',
      payload: { taskId: 'T-ITEST', timerAction: 'pause', remainingMs: 240000 },
    }));
    console.log('  → cmd task_timer { timerAction:pause }');

    await sleep(1200);
    pub(topics.makeCommand({
      action: 'policy',
      payload: { mode: 'open', locked: false, reason: '下课' },
    }));
    console.log('  → cmd policy { locked:false, reason:下课 }\n');
  }

  const code = await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      console.error('\n✗ 联调超时（60s），强制结束 Electron');
      try { child.kill(); } catch (_e) { /* noop */ }
      resolve(124);
    }, 60000);
    child.on('exit', (c) => { clearTimeout(killTimer); resolve(c == null ? 1 : c); });
    child.on('error', (e) => { clearTimeout(killTimer); console.error('Electron 启动失败：' + e.message); resolve(1); });
  });

  try { teacher.end(true); } catch (_e) { /* noop */ }

  // ---- 判定：进程退出码 + 关键结论行 ----
  const assertsOk = code === 0
    && /\[qy-smoke\] trace=.*"policy:lock"/.test(out)
    && /\[qy-smoke\] trace=.*"lock:on"/.test(out)
    && /\[qy-smoke\] trace=.*"lock:off"/.test(out)
    && out.includes('[qy-smoke] PASS');

  console.log('—— 结论 ——');
  if (assertsOk) {
    console.log('✅ 全域联动联调通过：锁定/活动/计时暂停/解锁 全部真实落地到界面');
    process.exit(0);
  }
  console.error('✗ 全域联动联调失败（退出码 ' + code + '）');
  if (!out.includes('[qy-smoke] ready')) {
    console.error('  提示：Electron 未打印 ready，可能是全域链路没连上 broker（检查 SIoT 是否在跑）。');
  }
  if (!out.includes('[qy-smoke] final=')) {
    console.error('  提示：没等到最终状态输出，检查是否卡在启动阶段。');
  }
  process.exit(1);
}

main().catch((e) => {
  console.error('联调脚本异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
