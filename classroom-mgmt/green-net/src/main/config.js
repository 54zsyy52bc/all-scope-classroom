'use strict';
// =============================================================================
// 统一配置（app-config.json）
//
// 结构分层：
//   - 顶层：窗口 / 下载 / 首页等运行参数
//   - siot：本机 SIoT 服务地址（控制台按钮用）
//   - qy  ：全域系统对接参数（MQTT broker / 主题前缀 / 联动开关）
//   - seat/name/studentNo/machineId：与全域学生端同源的身份字段
// =============================================================================
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const U = require('./util');

const PLACEHOLDER = 'change-me-before-deploy';

const DEFAULTS = {
  homeUrl: 'internal:home',
  windowTitle: '绿网 · 物联网实践浏览器',
  kiosk: false,
  allowDownload: false,
  allowDevTools: false,
  allowPopups: false,
  maxTabs: 8,
  blockEnabled: true,
  blockMode: 'blacklist',
  siot: { host: '127.0.0.1', httpPort: 8080, mqttPort: 1883, wsPort: 1888, autoOpen: false },
  qy: {
    enabled: true,
    projectPrefix: 'ICTClass',
    host: '127.0.0.1',
    port: 1883,
    wsPort: 1888,
    username: 'siot',
    password: 'dfrobot',
    lockOnPolicy: true,
    closeOnEnd: false,
    // 默认关闭：绿网是附加应用，不应默认向教师端写在线态（避免影响考勤统计）。
    // 需要"浏览器在线 = 本机在线"时再打开，且必须已配置 seat。
    reportHeartbeat: false,
    heartbeatSec: 15,
  },
  // 代理：解决 Windows 上 Chromium 不读 HTTPS_PROXY / 不认系统代理导致的
  // 「公网站 ERR_FAILED(-2)」问题。mode: auto(按环境/系统自动) | manual(用 server) | off(直连)
  proxy: { mode: 'auto', server: '', bypass: '<local>' },
  machineId: '',
  seat: '',
  name: '',
  studentNo: '',
  secret: PLACEHOLDER,
};

function pickMac() {
  const ifaces = os.networkInterfaces();
  for (const n of Object.keys(ifaces).sort()) {
    for (const it of ifaces[n] || []) {
      if (it.internal) continue;
      if (!it.mac || it.mac === '00:00:00:00:00:00') continue;
      return it.mac;
    }
  }
  return '';
}

// 与学生端 main.js 同算法，保证同一台机器在两端得到同一个 machineId
function deriveMachineId() {
  const raw = [os.hostname(), pickMac(), os.cpus()[0] && os.cpus()[0].model, os.arch()]
    .filter(Boolean).join('|');
  return 'M-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
}

function normSeat(v) {
  const m = String(v == null ? '' : v).trim().match(/^\d{1,3}$/);
  if (!m) return '';
  const n = parseInt(m[0], 10);
  if (n < 1 || n > 999) return '';
  return String(n).padStart(2, '0');
}

function normProxy(raw) {
  const p = U.isPlainObject(raw) ? raw : {};
  const mode = ['auto', 'manual', 'off'].includes(p.mode) ? p.mode : 'auto';
  return {
    mode,
    server: U.str(p.server, 128),
    bypass: U.str(p.bypass, 256) || '<local>',
  };
}

function normSiot(raw) {
  const s = U.isPlainObject(raw) ? raw : {};
  return {
    host: U.str(s.host, 64) || DEFAULTS.siot.host,
    httpPort: U.int(s.httpPort, DEFAULTS.siot.httpPort, 1, 65535),
    mqttPort: U.int(s.mqttPort, DEFAULTS.siot.mqttPort, 1, 65535),
    wsPort: U.int(s.wsPort, DEFAULTS.siot.wsPort, 1, 65535),
    autoOpen: U.bool(s.autoOpen, DEFAULTS.siot.autoOpen),
  };
}

function normQy(raw) {
  const q = U.isPlainObject(raw) ? raw : {};
  return {
    enabled: U.bool(q.enabled, DEFAULTS.qy.enabled),
    projectPrefix: U.str(q.projectPrefix, 40) || DEFAULTS.qy.projectPrefix,
    host: U.str(q.host, 64) || DEFAULTS.qy.host,
    port: U.int(q.port, DEFAULTS.qy.port, 1, 65535),
    wsPort: U.int(q.wsPort, DEFAULTS.qy.wsPort, 1, 65535),
    username: U.str(q.username, 64) || DEFAULTS.qy.username,
    password: U.str(q.password, 128),
    lockOnPolicy: U.bool(q.lockOnPolicy, DEFAULTS.qy.lockOnPolicy),
    closeOnEnd: U.bool(q.closeOnEnd, DEFAULTS.qy.closeOnEnd),
    reportHeartbeat: U.bool(q.reportHeartbeat, DEFAULTS.qy.reportHeartbeat),
    heartbeatSec: U.int(q.heartbeatSec, DEFAULTS.qy.heartbeatSec, 5, 300),
  };
}

function normalize(file) {
  const raw = U.isPlainObject(file) ? file : {};
  return {
    homeUrl: U.str(raw.homeUrl, 512) || DEFAULTS.homeUrl,
    windowTitle: U.str(raw.windowTitle, 80) || DEFAULTS.windowTitle,
    kiosk: U.bool(raw.kiosk, DEFAULTS.kiosk),
    allowDownload: U.bool(raw.allowDownload, DEFAULTS.allowDownload),
    allowDevTools: U.bool(raw.allowDevTools, DEFAULTS.allowDevTools),
    allowPopups: U.bool(raw.allowPopups, DEFAULTS.allowPopups),
    maxTabs: U.int(raw.maxTabs, DEFAULTS.maxTabs, 1, 30),
    blockEnabled: U.bool(raw.blockEnabled, DEFAULTS.blockEnabled),
    blockMode: raw.blockMode === 'whitelist' ? 'whitelist' : 'blacklist',
    siot: normSiot(raw.siot),
    qy: normQy(raw.qy),
    proxy: normProxy(raw.proxy),
    machineId: U.str(raw.machineId, 32),
    seat: normSeat(raw.seat),
    name: U.str(raw.name, 20),
    studentNo: U.str(raw.studentNo, 24),
    secret: U.str(raw.secret, 128) || PLACEHOLDER,
  };
}

function createConfig(appRoot) {
  const file = path.join(appRoot, 'app-config.json');
  let cache = normalize(U.readJsonSafe(file, {}));

  function get() {
    return JSON.parse(JSON.stringify(cache));
  }

  // patch 只接受白名单键；嵌套 siot/qy 走各自的规范化函数
  function patch(input) {
    const p = U.pick(input || {}, [
      'homeUrl', 'windowTitle', 'kiosk', 'allowDownload', 'allowDevTools',
      'allowPopups', 'maxTabs', 'blockEnabled', 'blockMode', 'siot', 'qy', 'proxy',
      'seat', 'name', 'studentNo', 'secret',
    ]);
    const next = Object.assign({}, cache);
    for (const k of Object.keys(p)) {
      if (k === 'siot') next.siot = Object.assign({}, cache.siot, U.pick(p.siot, Object.keys(DEFAULTS.siot)));
      else if (k === 'qy') next.qy = Object.assign({}, cache.qy, U.pick(p.qy, Object.keys(DEFAULTS.qy)));
      else if (k === 'proxy') next.proxy = Object.assign({}, cache.proxy, U.pick(p.proxy, Object.keys(DEFAULTS.proxy)));
      else next[k] = p[k];
    }
    cache = normalize(next);
    U.writeJsonAtomic(file, cache);
    return get();
  }

  // machineId 首次运行生成并落盘（与学生端一致的 M-xxxxxxxx 形态）
  function ensureMachineId() {
    if (cache.machineId && /^M-[0-9a-f]{8}$/i.test(cache.machineId)) return cache.machineId;
    const id = cache.machineId && cache.machineId.trim() ? cache.machineId.trim() : deriveMachineId();
    cache.machineId = U.str(id, 32);
    U.writeJsonAtomic(file, cache);
    return cache.machineId;
  }

  return { file, get, patch, ensureMachineId, DEFAULTS, PLACEHOLDER, deriveMachineId, normSeat };
}

module.exports = { createConfig, DEFAULTS, PLACEHOLDER, normalize, deriveMachineId, normSeat };
