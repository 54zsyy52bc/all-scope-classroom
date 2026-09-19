/* =============================================================================
   课堂页 ↔ 置顶浮窗 联动（app.js 专用，MQTT 真源仍在本页）。
   - push()：把状态快照推给浮窗（经主进程转发 float:status）
   - onAction()：处理浮窗按钮上报（状态三键 / 跳登记归还 / 退出课堂 / 快照请求）
   performExit()：退出课堂 = 本地重置到「待课」+ 上行 exit 消息。
   不切页、不断 MQTT：教师大屏仍能看到该机在线，老师发新活动即自动回归。
   ============================================================================= */
(function (global) {
  function create(c) {
    const state = c.state;
    const els = c.els;
    const toast = c.toast;
    const renderStage = c.renderStage;
    const saveLocal = c.saveLocal;
    const sendUp = c.sendUp;
    const audit = c.audit;
    const bridge = c.bridge;
    const onJump = c.onJump;

    function snap() {
      return {
        phase: state.phase, currentTask: state.currentTask, taskStatus: state.taskStatus,
        checkinDone: state.checkinDone, returnDone: state.returnDone,
      };
    }
    function push() {
      const b = bridge();
      if (b && b.floatStatus) { try { b.floatStatus(snap()); } catch (_e) { /* 浮窗不可达不阻断 */ } }
    }

    // 退出课堂：清空课中状态（登记/活动/求助/归还勾选），锁定遮罩一并收起。
    // 上行 exit 由教师端落库（t_student.exited=1）并在大屏标记「已退出」。
    function performExit() {
      audit('exit-class', 'seat=' + (state.seat || ''));
      state.phase = 'idle'; // 回待课：页面显示「等老师开始上课」，教师发新活动即自动回归
      state.currentTask = null;
      state.taskStatus = null;
      state.checkinDone = false;
      state.returnDone = false;
      state.returnChecked = {};
      state.borrowed = [];
      state.locked = false;
      if (els && els.lock) els.lock.hidden = true;
      if (c.resetEquipQty) c.resetEquipQty();
      saveLocal();
      renderStage();
      toast('已退出课堂，回到待课状态', 'info');
      sendUp('exit', { reason: 'student' });
    }

    function onAction(p) {
      const t = p && p.type;
      if (t === 'status' && c.actions) c.actions.submitTaskStatus(p.status);
      else if (t === 'jump') onJump(p.to);
      else if (t === 'sync-request') push();
      else if (t === 'exit') performExit();
    }

    return { push, onAction, performExit };
  }
  global.FloatLink = { create };
})(window);
