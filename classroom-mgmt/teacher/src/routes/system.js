'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const bridge = require('../mqtt/bridge');
const cfg = require('../config');
const db = require('../db');
const { ok, asyncHandler, isLocalRequest } = require('../response');

const router = express.Router();

// 探活接口：学生端桌面（student/renderer/desktop.js）跨机轮询它以显示「教室在线/离线」，
// 故免鉴权且对局域网公开——因此只返回运行状态，不下发任何身份/凭据信息。
// 凭据健康度告警（占位密钥/空令牌/全网卡+无鉴权）会暴露部署弱点，仅对本机访问返回。
router.get('/health', (req, res) => {
  const mqttState = bridge.getState();
  const status = mqttState.state === 'online' ? 'ok' : 'degraded';
  const local = isLocalRequest(req);
  ok(res, {
    status,
    uptimeMs: Math.round(process.uptime() * 1000),
    version: '1.0.0',
    mqtt: mqttState,
    db: { state: 'ok', path: cfg.DB_PATH, mode: db.getMode() },
    credentialWarnings: local && Array.isArray(cfg.credentialWarnings) ? cfg.credentialWarnings : [],
  });
});

router.get('/config', (req, res) => {
  const totalSeats = cfg.SEAT_COUNT;
  const groupCount = Math.ceil(totalSeats / cfg.GROUP_SIZE);
  const groups = [];
  for (let i = 1; i <= groupCount; i += 1) groups.push(`G${i}`);
  ok(res, {
    totalSeats,
    groupSize: cfg.GROUP_SIZE,
    groups,
    heartbeatIntervalMs: cfg.HEARTBEAT_INTERVAL_MS,
    offlineThresholdMs: cfg.OFFLINE_THRESHOLD_MS,
    helpBlinkMs: 1000,
    shutdownDelaySec: cfg.SHUTDOWN_DELAY_SEC,
    exportFormats: ['xlsx', 'csv'],
    // v5 组机默认（大屏开始上课表单预填）：机房台数/每组人数
    terminalCount: cfg.TERMINAL_COUNT,
    groupMembers: cfg.GROUP_MEMBERS,
  });
});

// 教师端 GUI 主动审计：写操作已由 server 中间件覆盖；大屏 logEvent（开始/下课/复位/导出/策略切换等）
// 也通过此端点落 logs/audit.log，方便测试期与大屏前端事件一一对应。
router.post('/audit', asyncHandler(async (req, res) => {
  const { type, detail } = req.body || {};
  const line = '[' + (type || 'ui') + '] ' + new Date().toISOString().slice(0, 19) + ' ' + String(detail || '').slice(0, 500);
  // eslint-disable-next-line no-console
  console.log('[audit-ui]', line);
  try {
    fs.mkdirSync(path.join(__dirname, '..', '..', 'logs'), { recursive: true });
    fs.appendFileSync(path.join(__dirname, '..', '..', 'logs', 'audit.log'), line + '\n', { flag: 'a' });
  } catch (_e) { /* 落盘失败不阻断 */ }
  ok(res, { logged: true });
}));

module.exports = router;
