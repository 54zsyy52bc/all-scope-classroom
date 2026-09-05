'use strict';
// =============================================================================
// 渲染层 MQTT 客户端（WebSocket 1888 / 路径 /ws）。
//
// SIoT2 三条硬约束（已实测，不要改）：
//   1) broker 不支持通配符 → 订阅必须逐个精确主题：siot/ict_cmd、siot/ict_sync
//   2) 实际只支持 MQTT 3.1.1 → 先试 v4，握手失败自动降级 v3.1.1（MQIsdp）
//   3) cleanSession = true，broker 不保存状态 → 每次连上都要自己发 hello 换 sync
//
// 重连：自管指数退避 1→2→4→8→16→30s + 0~300ms 抖动（防 50 台同时重连打爆 broker）。
// 本文件只管「连得上、发得出、收得到」，不解析业务语义——语义在 app.js。
// =============================================================================
(function (global) {
  const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];
  const JITTER_MAX = 300;
  const CONNECT_TIMEOUT_MS = 8000;
  const KEEPALIVE_SEC = 30;

  function topics() {
    return global.ClassroomTopics;
  }

  function create(opts) {
    const o = opts || {};
    const url = o.url;
    const clientId = o.clientId;
    const listeners = { state: [], message: [] };

    let client = null;
    let timer = null;
    let backoffIndex = 0;
    let protoVersion = 4;
    let triedV3 = false;
    let stopped = false;
    let state = 'offline';

    function emit(kind, payload) {
      const list = listeners[kind] || [];
      for (let i = 0; i < list.length; i += 1) {
        try {
          list[i](payload);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('[net] 监听器抛出异常:', e && e.message);
        }
      }
    }

    function setState(next, detail) {
      state = next;
      emit('state', Object.assign({ state: next }, detail || {}));
    }

    function clearTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function schedule(delayOverride) {
      if (stopped || timer) return;
      const base = delayOverride != null
        ? delayOverride
        : BACKOFF[Math.min(backoffIndex, BACKOFF.length - 1)];
      const delay = base + Math.floor(Math.random() * JITTER_MAX);
      setState('reconnecting', { nextRetryInMs: delay, attempts: backoffIndex + 1 });
      timer = setTimeout(() => {
        timer = null;
        if (backoffIndex < BACKOFF.length - 1) backoffIndex += 1;
        connect();
      }, delay);
    }

    function teardownClient() {
      if (!client) return;
      try {
        client.removeAllListeners();
        client.end(true);
      } catch (_e) { /* 连接已断，忽略 */ }
      client = null;
    }

    function connect() {
      if (stopped) return;
      teardownClient();
      const T = topics();
      setState('reconnecting', { attempts: backoffIndex, url });
      client = global.mqtt.connect(url, {
        clientId,
        username: o.username,
        password: o.password,
        keepalive: KEEPALIVE_SEC,
        protocolVersion: protoVersion,
        protocolId: protoVersion === 3 ? 'MQIsdp' : 'MQTT',
        clean: true,
        reconnectPeriod: 0, // 退避自管
        connectTimeout: CONNECT_TIMEOUT_MS,
      });

      client.on('connect', () => {
        backoffIndex = 0;
        setState('online', { url, proto: protoVersion === 3 ? '3.1.1' : '4' });
        client.subscribe([T.CMD_BROADCAST, T.SYNC], { qos: 1 }, (err) => {
          if (err) {
            // eslint-disable-next-line no-console
            console.error('[net] 订阅指令/同步主题失败:', err.message);
          }
        });
      });

      client.on('message', (topic, payload) => {
        let env = null;
        try {
          env = JSON.parse(payload.toString());
        } catch (_e) {
          return; // 非 JSON 报文直接丢弃（SIoT 可能有其它话题残留）
        }
        if (!env || !env.type) return;
        emit('message', { topic, env });
      });

      client.on('error', (err) => {
        if (protoVersion === 4 && !triedV3) {
          triedV3 = true;
          protoVersion = 3;
          // eslint-disable-next-line no-console
          console.warn('[net] MQTT v4 握手失败，降级 3.1.1 重试:', err.message);
          clearTimer();
          schedule(500);
          return;
        }
        setState('reconnecting', { error: err && err.message });
        schedule();
      });

      client.on('close', () => {
        if (!stopped) schedule();
      });

      client.on('offline', () => {
        if (!stopped) setState('reconnecting', { reason: 'transport-offline' });
      });
    }

    return {
      start() {
        stopped = false;
        backoffIndex = 0;
        connect();
      },
      stop() {
        stopped = true;
        clearTimer();
        teardownClient();
        setState('offline', { reason: 'stopped' });
      },
      isOnline() {
        return state === 'online' && !!client;
      },
      // 业务上行（QoS1）：checkin / task / return / hello
      publishUp(env) {
        if (!client || state !== 'online') return false;
        client.publish(topics().STU_UP, JSON.stringify(env), { qos: 1, retain: false });
        return true;
      },
      // 心跳（QoS0，不入库）：status
      publishHeartbeat(env) {
        if (!client || state !== 'online') return false;
        client.publish(topics().STU_HB, JSON.stringify(env), { qos: 0, retain: false });
        return true;
      },
      on(kind, fn) {
        if (listeners[kind] && typeof fn === 'function') listeners[kind].push(fn);
      },
      getState() {
        return state;
      },
    };
  }

  global.Net = { create };
})(window);
