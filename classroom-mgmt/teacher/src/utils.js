'use strict';
// 纯工具函数：ID 生成、HMAC 令牌、座位格式化、UTF-8 BOM 包装。无副作用。
const crypto = require('crypto');

function genId() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function dateStamp(d) {
  const dt = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}${p(dt.getMonth() + 1)}${p(dt.getDate())}`;
}

function makeSessionId() {
  return `S-${dateStamp()}-${genId().slice(0, 8)}`;
}

function makeTaskId() {
  return `T-${genId().slice(0, 8).toUpperCase()}`;
}

function makeExportId() {
  return `E-${dateStamp()}-${genId().slice(0, 8)}`;
}

// 关机令牌：HMAC_SHA256(secret, sessionId + ':' + ts)（团队约定格式）
function signToken(secret, sessionId, ts) {
  return crypto.createHmac('sha256', secret).update(`${sessionId}:${ts}`).digest('hex');
}

// 校验令牌：签名匹配 + 时间窗内
function verifyToken(secret, token, sessionId, ts, windowMs) {
  if (!token || !sessionId || ts == null) return false;
  const expected = signToken(secret, sessionId, ts);
  if (token !== expected) return false;
  const now = Date.now();
  if (Math.abs(now - ts) > windowMs) return false;
  return true;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 座位号规范化：1 -> '01'，'7' -> '07'，'07' -> '07'
function seatNum(n) {
  const m = String(n).match(/^\d{1,2}$/);
  if (!m) return String(n);
  return pad2(parseInt(n, 10));
}

function nowMs() {
  return Date.now();
}

// Excel 打开中文不乱码
function withBOM(str) {
  return '﻿' + str;
}

// 简易日志（文字，无 emoji）
function makeLogger(level) {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const cur = levels[level] != null ? levels[level] : 2;
  const out = (lv, args) => {
    if (levels[lv] <= cur) {
      const ts = new Date().toISOString();
      // eslint-disable-next-line no-console
      console.log(`[${ts}] [${lv.toUpperCase()}]`, ...args);
    }
  };
  return {
    error: (...a) => out('error', a),
    warn: (...a) => out('warn', a),
    info: (...a) => out('info', a),
    debug: (...a) => out('debug', a),
  };
}

module.exports = {
  genId,
  dateStamp,
  makeSessionId,
  makeTaskId,
  makeExportId,
  signToken,
  verifyToken,
  pad2,
  seatNum,
  nowMs,
  withBOM,
  makeLogger,
};
