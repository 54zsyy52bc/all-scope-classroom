'use strict';
// =============================================================================
// 学生端 · 下行指令处理（cmd / sync 语义 + 阶段机 + 关机倒计时）
//
// 下行（siot/ict_cmd）：cmd{start|task|end|shutdown|reset}
// 同步（siot/ict_sync）：sync{phase,currentTask,checkinDone,returnDone} —— 只认 seat 匹配自己的
//
// 依赖注入：create(ctx) 接收控制器闭包内的共享值，避免本文件持有全局可变状态。
// ctx = { state, toast, renderStage, renderShutdown, bridge, log, pad2,
//         resetEquipQty, getRuntime, onEquipment, onTimer, onPolicy }
// onEquipment(payload)：教师端下发/同步器材清单时回调（app.js 注入）
// onTimer(payload)：计时控制/截止回调；onPolicy(payload)：锁定策略回调
// =============================================================================
(function (global) {
  function create(c) {
    const state = c.state;
    const toast = c.toast;
    const renderStage = c.renderStage;
    const renderShutdown = c.renderShutdown;
    const bridge = c.bridge;
    const log = c.log;
    const pad2 = c.pad2;
    const resetEquipQty = c.resetEquipQty;
    const getRuntime = c.getRuntime;
    const onEquipment = c.onEquipment;
    const onTimer = c.onTimer;
    const onPolicy = c.onPolicy;
    let cdTimer = null;

    function onCommand(env) {
      const p = env.payload || {};
      if (p.action === 'start') return applyStart();
      if (p.action === 'task') return applyTask(p.task);
      if (p.action === 'end') return setPhase('return');
      if (p.action === 'reset') return applyReset(p.seat);
      if (p.action === 'shutdown') return handleShutdown(p);
      if (p.action === 'equipment') {
        if (typeof onEquipment === 'function') onEquipment(p);
        return undefined;
      }
      if (p.action === 'task_timer') {
        if (typeof onTimer === 'function') onTimer(p);
        return undefined;
      }
      if (p.action === 'policy') {
        if (typeof onPolicy === 'function') onPolicy(p);
        return undefined;
      }
      log('忽略未知指令 action=' + String(p.action));
      return undefined;
    }

    function onSync(env) {
      const p = env.payload || {};
      if (String(env.seat) !== state.seat) return; // 单主题广播，只认自己的
      // 器材清单随 sync 下发：迟到/重连学生据此恢复登记页器材列表
      if (p.equipment && typeof onEquipment === 'function') onEquipment({ equipment: p.equipment });
      // 锁定策略随 sync 下发：迟到/重连学生恢复锁定状态
      if (p.policy && typeof onPolicy === 'function') onPolicy(p.policy);
      // 计时活动状态随 sync 恢复（含计时字段）
      if (p.currentTask && p.currentTask.taskId) {
        state.currentTask = p.currentTask;
        if (typeof onTimer === 'function') onTimer({ action: 'sync', taskId: p.currentTask.taskId, remainingMs: p.currentTask.remainingMs });
      }
      setPhase(p.phase || 'idle');
      // 服务端真值校正：教师端没写进去的提交要回滚，避免学生以为成功了
      if (state.checkinDone && !p.checkinDone) {
        state.checkinDone = false;
        toast('登记未被教师端确认，请检查座位号是否与他人重复', 'error');
      }
      if (state.returnDone && !p.returnDone) {
        state.returnDone = false;
        toast('归还未被教师端确认，请重新点一次确认归还', 'error');
      }
      if (p.currentTask && p.currentTask.taskId) state.currentTask = p.currentTask;
      renderStage();
    }

    function setPhase(next) {
      if (state.phase === next) return;
      state.phase = next;
      if (next === 'checkin') {
        state.currentTask = null;
        state.taskStatus = null;
        state.checkinDone = false;
        state.returnDone = false;
        state.returnChecked = {};
        state.borrowed = [];
        resetEquipQty();
      }
      renderStage();
    }

    function applyStart() {
      setPhase('checkin');
      toast('老师已开始上课，请完成登记', 'info');
    }

    function applyTask(task) {
      if (!task || !task.taskId) return;
      // 活动 = 任务 + 计时元数据
      state.currentTask = {
        taskId: task.taskId,
        title: task.title,
        desc: task.desc || '',
        timed: !!task.timed,
        durationSec: task.durationSec != null ? task.durationSec : null,
        timerState: task.timerState || 'idle',
        remainingMs: task.remainingMs != null ? task.remainingMs : null,
      };
      state.taskStatus = null;
      state.phase = 'task';
      renderStage();
      toast(task.timed && task.timerState === 'running' ? '新活动：' + task.title + '（计时中）' : '新任务：' + task.title, 'info');
    }

    function applyReset(seat) {
      if (seat && pad2(seat) !== state.seat) return;
      state.checkinDone = false;
      state.returnDone = false;
      state.currentTask = null;
      state.taskStatus = null;
      state.borrowed = [];
      state.returnChecked = {};
      resetEquipQty();
      state.phase = 'checkin';
      renderStage();
      toast('老师已重置本座位登记，请重新登记', 'warn');
    }

    function handleShutdown(p) {
      const b = bridge();
      if (!b || !b.verifyShutdown) {
        log('无主进程桥接，忽略关机指令（演练）');
        startCountdown(p.delaySec || 60, true);
        return;
      }
      b.verifyShutdown({ sessionId: p.sessionId, ts: p.ts, token: p.token }).then((r) => {
        if (!r || !r.verified) {
          log('关机指令校验未通过，已忽略：' + (r && r.reason));
          toast('收到关机指令但校验未通过，已忽略', 'error');
          return;
        }
        const rt = getRuntime();
        return b.executeShutdown({ delaySec: rt ? rt.shutdownDelaySec : 60, reason: 'teacher-cmd' })
          .then((res) => {
            startCountdown((res && res.delaySec) || 60, !!(res && res.dryRun));
            log('关机指令已执行' + (res && res.dryRun ? '（演练模式）' : ''));
          });
      }).catch((e) => {
        log('关机流程异常: ' + (e && e.message));
      });
    }

    function startCountdown(sec, dryRun) {
      state.shutdownIn = sec;
      state.shutdownDryRun = dryRun;
      renderShutdown();
      if (cdTimer) clearInterval(cdTimer);
      cdTimer = setInterval(() => {
        state.shutdownIn -= 1;
        if (state.shutdownIn <= 0) {
          clearInterval(cdTimer);
          cdTimer = null;
          // 归零后置 null → renderShutdown 自动隐藏关机遮罩（dryRun 演练不真关机，必须恢复操作界面）
          state.shutdownIn = null;
        }
        renderShutdown();
      }, 1000);
    }

    return { onCommand, onSync, setPhase };
  }

  global.Downlink = { create };
})(window);
