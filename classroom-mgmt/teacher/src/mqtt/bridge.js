'use strict';
// MQTT 桥接：教师端 Node 聚合点，走 TCP 1883 连 SIoT2。
// - clientId = teacher_<短哈希>，防与历史连接互踢。
// - 协议版本先试 3.1.1(v4)，握手失败自动降级 3.1(MQIsdp)。
// - 自管指数退避 1→2→4→8→16→30s，加 0~300ms 随机 jitter（防 50 台重连风暴）。
// - SIoT 不可达不崩溃：后台重连，server 其余功能照常。
// 不依赖 services（避免循环引用）；消息分发由外部通过 setMessageHandler 注入。
const mqtt = require('mqtt');
const crypto = require('crypto');
const cfg = require('../config');
// 主题常量取单一真源：classroom-mgmt/shared/topics.js（教师端/学生端共用，禁止各端复制）
// 路径：teacher/src/mqtt/ → ../../../ = classroom-mgmt/ → shared/topics
const topics = require('../../../shared/topics');
const { makeLogger } = require('../utils');

const log = makeLogger(cfg.LOG_LEVEL);

const STATE = {
  state: 'offline',
  brokerUrl: cfg.SIOT_TCP_URL,
  topicPlan: cfg.TOPIC_PLAN,
  lastConnectedAt: null,
  reconnectAttempts: 0,
  nextRetryInMs: null,
};

const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];
const JITTER_MAX = 300;

let client = null;
let messageHandler = null;
let onStateChange = null;
let backoffIndex = 0;
let retryTimer = null;
let protoVersion = 4;
let triedV3 = false;

function shortHash(str) {
  return crypto.createHash('md5').update(str).digest('hex').slice(0, 8);
}
function buildClientId() {
  return `teacher_${shortHash(`${cfg.SIOT_IP}:${cfg.SIOT_TCP_PORT}`)}`;
}

function getState() {
  return {
    state: STATE.state,
    brokerUrl: STATE.brokerUrl,
    topicPlan: STATE.topicPlan,
    lastConnectedAt: STATE.lastConnectedAt,
    reconnectAttempts: STATE.reconnectAttempts,
    nextRetryInMs: STATE.nextRetryInMs,
  };
}

function updateState(patch) {
  Object.assign(STATE, patch);
  if (onStateChange) {
    try { onStateChange(getState()); } catch (_e) { /* ignore */ }
  }
}

function setOnStateChange(fn) { onStateChange = fn; }
function setMessageHandler(fn) { messageHandler = fn; }

function isOnline() { return STATE.state === 'online' && !!client; }

function scheduleReconnect(delayOverride) {
  if (retryTimer) return; // 已在退避，避免重复
  const base = delayOverride != null ? delayOverride : BACKOFF[Math.min(backoffIndex, BACKOFF.length - 1)];
  const jitter = Math.floor(Math.random() * JITTER_MAX);
  const delay = base + jitter;
  const attempts = backoffIndex + (delayOverride ? 0 : 1);
  updateState({ state: 'reconnecting', reconnectAttempts: attempts, nextRetryInMs: delay });
  log.info(`MQTT 重连退避 ${delay}ms（base ${base} + jitter ${jitter}）`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (backoffIndex < BACKOFF.length - 1) backoffIndex += 1;
    connect();
  }, delay);
  if (retryTimer.unref) retryTimer.unref();
}

function subscribe() {
  if (!client) return;
  client.subscribe(topics.STU_UP, { qos: 1 }, (err) => {
    if (err) log.warn('订阅 siot/ict_up 失败:', err.message);
  });
  client.subscribe(topics.STU_HB, { qos: 0 }, (err) => {
    if (err) log.warn('订阅 siot/ict_hb 失败:', err.message);
  });
}

function connect() {
  if (client) {
    try { client.end(true); } catch (_e) { /* ignore */ }
    client = null;
  }
  const opts = {
    clientId: buildClientId(),
    username: cfg.SIOT_USER,
    password: cfg.SIOT_PASS,
    keepalive: 30,
    protocolVersion: protoVersion,
    protocolId: protoVersion === 3 ? 'MQIsdp' : 'MQTT',
    clean: true,
    reconnectPeriod: 0, // 自管退避
    connectTimeout: 8000,
  };
  log.info(`MQTT 连接中 ${STATE.brokerUrl}（proto v${protoVersion}）`);
  updateState({ state: 'reconnecting' });
  client = mqtt.connect(STATE.brokerUrl, opts);

  client.on('connect', () => {
    log.info('MQTT 已连接');
    backoffIndex = 0;
    STATE.lastConnectedAt = Date.now();
    updateState({ state: 'online', reconnectAttempts: 0, nextRetryInMs: null });
    subscribe();
  });

  client.on('message', (topic, payload) => {
    if (messageHandler) {
      try { messageHandler(topic, payload); } catch (e) { log.error('消息处理异常:', e.message); }
    }
  });

  client.on('error', (err) => {
    log.warn('MQTT error:', err.message);
    if (protoVersion === 4 && !triedV3) {
      triedV3 = true;
      protoVersion = 3;
      log.info('协议握手失败，降级到 MQTT 3.1 (MQIsdp) 重试');
      scheduleReconnect(500);
      return;
    }
    updateState({ state: 'reconnecting' });
    scheduleReconnect();
  });

  client.on('close', () => {
    if (STATE.state !== 'reconnecting') updateState({ state: 'reconnecting' });
    scheduleReconnect();
  });

  client.on('offline', () => {
    updateState({ state: 'reconnecting' });
  });
}

// 发布到指定主题；离线时返回 delivered:false 不抛异常。
function publish(topic, envelope, qos = 1) {
  return new Promise((resolve) => {
    if (!client || STATE.state !== 'online') {
      resolve({ delivered: false, error: 'offline' });
      return;
    }
    client.publish(topic, JSON.stringify(envelope), { qos }, (err) => {
      if (err) resolve({ delivered: false, error: err.message });
      else resolve({ delivered: true, msgId: envelope.msgId, topic });
    });
  });
}

// 广播教师指令到 siot/ict_cmd（QoS1）
async function publishCommand(action, payload = {}, extra = {}) {
  const env = topics.makeCommand({
    action,
    payload,
    sessionId: extra.sessionId,
    ts: extra.ts,
    token: extra.token,
  });
  return publish(topics.CMD_BROADCAST, env, 1);
}

// 向学生回 sync（hello 应答）
async function publishSync(seat, syncPayload) {
  const env = topics.makeSync(Object.assign({ seat }, syncPayload));
  return publish(topics.SYNC, env, 1);
}

function shutdown() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (client) { try { client.end(true); } catch (_e) { /* ignore */ } client = null; }
  updateState({ state: 'offline' });
}

module.exports = {
  connect,
  shutdown,
  publish,
  publishCommand,
  publishSync,
  setMessageHandler,
  setOnStateChange,
  getState,
  isOnline,
  CMD_BROADCAST: topics.CMD_BROADCAST,
  STU_UP: topics.STU_UP,
  STU_HB: topics.STU_HB,
  SYNC: topics.SYNC,
};
