'use strict';
// =============================================================================
// 教师端 / 学生端 共用的物理主题常量与信封工厂（Plan B 两级主题）。
//
// UMD 包装：Node 端 require 得到 module.exports；浏览器端（Electron renderer
// 经 classic <script> 加载）得到全局 window.ClassroomTopics。两端逐字一致。
//
// 逻辑名 + 物理值：
//   - CMD_BROADCAST = 'siot/ict_cmd'   教师→学生 指令（QoS1）
//   - STU_UP        = 'siot/ict_up'    学生→教师 业务上行（QoS1，type 区分 checkin/task/return/hello）
//   - STU_HB        = 'siot/ict_hb'    学生→教师 心跳（QoS0，不入库）
//   - SYNC          = 'siot/ict_sync'  双向 状态同步（QoS1）
//
// 业务代码只引用逻辑名，物理主题统一在此定义，切 Plan 只改此处。
// =============================================================================
(function (global, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    global.ClassroomTopics = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const CMD_BROADCAST = 'siot/ict_cmd';
  const STU_UP = 'siot/ict_up';
  const STU_HB = 'siot/ict_hb';
  const SYNC = 'siot/ict_sync';

  // 信封 type 枚举（与 03/04 文档一致）
  const ENVELOPE_TYPES = {
    CHECKIN: 'checkin',
    TASK: 'task',
    RETURN: 'return',
    CMD: 'cmd',
    STATUS: 'status',
    HELLO: 'hello',
    SYNC: 'sync',
  };

  // 指令 action 枚举（cmd.payload.action）
  const CMD_ACTIONS = {
    START: 'start',
    END: 'end',
    TASK: 'task',
    SHUTDOWN: 'shutdown',
    RESET: 'reset',
    EQUIPMENT: 'equipment',
    TASK_TIMER: 'task_timer',
    POLICY: 'policy',
  };

  function genId() {
    if (globalThis.crypto && globalThis.crypto.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // 稳定短哈希：djb2 → 4 位 hex。用于 machineId（克隆镜像 clientId 冲突规避）。
  function shortHash(str) {
    const s = String(str == null ? '' : str);
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return ('0000' + (h & 0xffff).toString(16)).slice(-4);
  }

  // 通用上行/事件信封。machineId 同时写到顶层与 payload（后端 handlers 读 env.machineId || p.machineId）。
  function makeEnvelope(opts) {
    const o = opts || {};
    const env = {
      msgId: o.msgId || genId(),
      ts: o.ts != null ? o.ts : Date.now(),
      type: o.type,
      seat: o.seat != null ? String(o.seat) : '*',
      group: o.group != null ? String(o.group) : '*',
      payload: o.payload != null ? o.payload : {},
    };
    if (o.machineId != null && o.machineId !== '') {
      env.machineId = o.machineId;
      if (env.payload && typeof env.payload === 'object') env.payload.machineId = o.machineId;
    }
    return env;
  }

  // 教师下行指令信封（type=cmd）。shutdown 额外带 sessionId/ts/token。
  function makeCommand(opts) {
    const o = opts || {};
    const env = makeEnvelope({
      type: ENVELOPE_TYPES.CMD,
      seat: '*',
      group: '*',
      ts: o.ts != null ? o.ts : Date.now(),
      payload: Object.assign({ action: o.action }, o.payload || {}),
    });
    if (o.sessionId !== undefined) env.payload.sessionId = o.sessionId;
    if (o.ts !== undefined) env.payload.ts = o.ts;
    if (o.token !== undefined) env.payload.token = o.token;
    return env;
  }

  // 教师向学生回 sync（hello 应答）。equipment 为当前活动器材清单；policy 为锁定策略。
  function makeSync(opts) {
    const o = opts || {};
    return makeEnvelope({
      type: ENVELOPE_TYPES.SYNC,
      seat: String(o.seat),
      group: '*',
      ts: o.ts != null ? o.ts : Date.now(),
      payload: {
        sessionId: o.sessionId,
        phase: o.phase,
        currentTask: o.currentTask || null,
        checkinDone: !!o.checkinDone,
        returnDone: !!o.returnDone,
        equipment: o.equipment || null,
        policy: o.policy || null,
      },
    });
  }

  return {
    CMD_BROADCAST,
    STU_UP,
    STU_HB,
    SYNC,
    ENVELOPE_TYPES,
    CMD_ACTIONS,
    genId,
    shortHash,
    makeEnvelope,
    makeCommand,
    makeSync,
  };
});
