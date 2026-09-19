'use strict';
// =============================================================================
// sync 报文构造（唯一真源）：hello 应答与锁定策略"双保险"下发必须共用同一构造器。
//
// 现场事故（"发布活动后学生机无法解锁、大屏取消集体失效"根因之一）：policy.service
// 曾逐生下发仅 { policy } 的残缺 sync —— 学生端把 sync 当**完整权威状态**处理
// （setPhase(p.phase||'idle') / 清活动卡 / 回滚登记），教师每切一次锁定策略，
// 全班学生端就被打回待课页、登记被回滚，看起来像"解锁不了、操作集体失效"。
//
// 契约（两端共同遵守）：sync payload 必须始终包含全部字段（无值可为 null）；
// 学生端按"字段存在性"应用，字段缺失 = 不动对应状态。
// =============================================================================
const db = require('../db');
const taskSvc = require('./task.service');

function buildSyncPayload(session, seat) {
  const sessionId = session ? session.session_id : null;
  const phase = session ? session.phase : null;
  let currentTask = null;
  let checkinDone = false;
  let returnDone = false;
  let equipment = null;
  let policy = null;
  if (session) {
    const tasks = db.listTasks(sessionId);
    const openTasks = tasks.filter((x) => !x.close_time);
    if (openTasks.length) {
      const t = openTasks[openTasks.length - 1];
      // 最近活动：带计时字段（迟到/重连学生据此恢复计时显示）
      currentTask = {
        taskId: t.task_id, title: t.title,
        timed: !!t.timed, durationSec: t.duration_sec != null ? t.duration_sec : null,
        timerState: t.timer_state || 'idle',
        remainingMs: taskSvc.remainingMs(t),
      };
    }
    const st = db.getStudent(sessionId, seat);
    if (st) { checkinDone = st.checkin_status === 'done'; returnDone = st.return_status === 'done'; }
    // 器材清单随 sync 下发：迟到/重连学生据此恢复登记页器材列表
    if (session.equipment_json) {
      try { equipment = JSON.parse(session.equipment_json); } catch (_e) { equipment = null; }
    }
    // 锁定策略随 sync 下发：迟到/重连学生恢复锁定状态
    // （惰性 require：policy.service 反向依赖本模块构造双保险 sync，避免加载环）
    try { policy = require('./policy.service').computePolicy(session); } catch (_e) { policy = null; }
  }
  return { sessionId, phase, currentTask, checkinDone, returnDone, equipment, policy };
}

module.exports = { buildSyncPayload };
