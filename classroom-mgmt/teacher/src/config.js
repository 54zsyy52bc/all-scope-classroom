'use strict';
// 配置加载：环境变量覆盖 app-config.json，再覆盖内置默认值。
// 不引入 dotenv 依赖，直接用 process.env，部署时用 .env 由启动脚本 source 或系统环境变量注入。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname; // src/
const PROJECT_ROOT = path.resolve(ROOT, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'app-config.json');

function loadFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_e) {
    return {};
  }
}

const defaults = {
  SIOT_IP: '127.0.0.1',
  SIOT_WS_PORT: 1888,
  SIOT_TCP_PORT: 1883,
  SIOT_WEB_PORT: 8080,
  SIOT_USER: 'siot',
  SIOT_PASS: 'dfrobot',
  HMAC_SECRET: 'change-me-before-deploy',
  SEATS_FILE: path.join(PROJECT_ROOT, 'seeds', 'seats.json'),
  EQUIP_FILE: path.join(PROJECT_ROOT, 'seeds', 'equipment.json'),
  DB_PATH: path.join(PROJECT_ROOT, 'classroom.db'),
  SEAT_COUNT: 50,
  HTTP_PORT: 3000,
  HTTP_HOST: '0.0.0.0',
  TOPIC_PLAN: 'B',
  GROUP_SIZE: 5,
  HEARTBEAT_INTERVAL_MS: 15000,
  OFFLINE_THRESHOLD_MS: 45000,
  SHUTDOWN_DELAY_SEC: 10,
  HMAC_WINDOW_MS: 60000,
  ENABLE_AUTH: false,
  TEACHER_TOKEN: '',
  LOG_LEVEL: 'info',
};

const NUM_KEYS = [
  'SIOT_WS_PORT', 'SIOT_TCP_PORT', 'SIOT_WEB_PORT', 'SEAT_COUNT',
  'HTTP_PORT', 'GROUP_SIZE', 'HEARTBEAT_INTERVAL_MS',
  'OFFLINE_THRESHOLD_MS', 'SHUTDOWN_DELAY_SEC', 'HMAC_WINDOW_MS',
];
const BOOL_KEYS = ['ENABLE_AUTH'];

const fileCfg = loadFileConfig();
const cfg = Object.assign({}, defaults);

for (const key of Object.keys(defaults)) {
  let v = process.env[key];
  if (v === undefined) v = fileCfg[key];
  if (v === undefined) continue;
  if (NUM_KEYS.includes(key)) v = Number(v);
  else if (BOOL_KEYS.includes(key)) v = String(v).toLowerCase() === 'true';
  cfg[key] = v;
}

// 路径类配置若仍是相对路径，按项目根解析
for (const pkey of ['SEATS_FILE', 'EQUIP_FILE', 'DB_PATH']) {
  if (cfg[pkey] && !path.isAbsolute(cfg[pkey])) {
    cfg[pkey] = path.resolve(PROJECT_ROOT, cfg[pkey]);
  }
}
cfg.EXPORTS_DIR = path.join(PROJECT_ROOT, 'exports');
cfg.PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

// broker 地址派生
cfg.SIOT_TCP_URL = `mqtt://${cfg.SIOT_IP}:${cfg.SIOT_TCP_PORT}`;
cfg.SIOT_WS_URL = `ws://${cfg.SIOT_IP}:${cfg.SIOT_WS_PORT}/ws`;

module.exports = cfg;
