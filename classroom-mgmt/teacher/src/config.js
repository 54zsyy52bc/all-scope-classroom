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
  // 座位上限（服务端校验 1-99）：内部"取全量学生"的查询一律用它当分页上限，
  // 避免 queryStudents 的默认分页 50 把组机模式（14 台×6 人=84 座）的后半班截掉。
  MAX_SEAT: 99,
  // v5 组机（全域学生桌面）默认：机房台数 × 每组人数（大屏开始上课可自定义，totalSeats = T×K）
  TERMINAL_COUNT: 14,
  GROUP_MEMBERS: 6,
  HTTP_PORT: 3000,
  // 必须监听所有网卡：学生端桌面（student/renderer/desktop.js）会用教师机 IP
  // 跨机轮询 /api/v1/system/health 显示「教室在线/离线」，收敛到 127.0.0.1 会导致
  // 全部学生机状态灯恒为「教室离线」。安全边界由 ENABLE_AUTH（默认开启）承担：
  // 本机免鉴权 + health 免鉴权，其余跨机访问一律要求 X-Teacher-Token。
  HTTP_HOST: '0.0.0.0',
  TOPIC_PLAN: 'B',
  GROUP_SIZE: 5,
  HEARTBEAT_INTERVAL_MS: 15000,
  OFFLINE_THRESHOLD_MS: 45000,
  SHUTDOWN_DELAY_SEC: 10,
  HMAC_WINDOW_MS: 60000,
  // 默认开启 HTTP API 鉴权；回环地址（大屏同源）免鉴权，跨机需 X-Teacher-Token。
  ENABLE_AUTH: true,
  TEACHER_TOKEN: '',
  // CORS 额外允许来源（逗号分隔，默认空）。无 Origin 的请求（curl/Node fetch/MQTT 工具）与同源请求始终放行。
  CORS_ORIGINS: '',
  LOG_LEVEL: 'info',
};

const NUM_KEYS = [
  'SIOT_WS_PORT', 'SIOT_TCP_PORT', 'SIOT_WEB_PORT', 'SEAT_COUNT', 'MAX_SEAT',
  'HTTP_PORT', 'GROUP_SIZE', 'HEARTBEAT_INTERVAL_MS',
  'OFFLINE_THRESHOLD_MS', 'SHUTDOWN_DELAY_SEC', 'HMAC_WINDOW_MS',
  'TERMINAL_COUNT', 'GROUP_MEMBERS',
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

// 凭据健康度自检：仅告警，不阻断启动（强闸门见 server.js，仅 production / STRICT_CREDENTIALS=1 生效）。
// 注意：HMAC_SECRET 必须与学生对端一致，绝对不能在教师端自动改写，否则现场关机功能直接失效。
const PLACEHOLDER_HMAC = 'change-me-before-deploy';
cfg.credentialWarnings = [];
if (cfg.HMAC_SECRET === PLACEHOLDER_HMAC) {
  cfg.credentialWarnings.push('HMAC_SECRET 仍为占位默认值 change-me-before-deploy，现场关机功能可能被禁用；请在部署前设置为与学生端一致的密钥。');
}
if (cfg.ENABLE_AUTH === true && !cfg.TEACHER_TOKEN) {
  cfg.credentialWarnings.push('已启用鉴权但 TEACHER_TOKEN 为空：启动时会生成一次性随机令牌（重启即失效），跨机调用方无法获知令牌、无法调用接口；如需稳定的跨机访问，请在 app-config.json 显式设置 TEACHER_TOKEN。');
}
if (cfg.HTTP_HOST === '0.0.0.0') {
  // 监听全网卡是学生端探活的硬需求，本身不算风险；风险在于「全网卡 + 关闭鉴权」这个组合。
  if (cfg.ENABLE_AUTH !== true) {
    cfg.credentialWarnings.push('HTTP_HOST 为 0.0.0.0 且 ENABLE_AUTH 未开启：局域网内任何主机都可调用教师端接口（含关机），请在 app-config.json 中开启 ENABLE_AUTH。');
  }
}

module.exports = cfg;
