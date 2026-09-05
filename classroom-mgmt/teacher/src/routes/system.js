'use strict';
const express = require('express');
const bridge = require('../mqtt/bridge');
const cfg = require('../config');
const db = require('../db');
const { ok, asyncHandler } = require('../response');

const router = express.Router();

router.get('/health', (req, res) => {
  const mqttState = bridge.getState();
  const status = mqttState.state === 'online' ? 'ok' : 'degraded';
  ok(res, {
    status,
    uptimeMs: Math.round(process.uptime() * 1000),
    version: '1.0.0',
    mqtt: mqttState,
    db: { state: 'ok', path: cfg.DB_PATH, mode: db.getMode() },
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
  });
});

module.exports = router;
