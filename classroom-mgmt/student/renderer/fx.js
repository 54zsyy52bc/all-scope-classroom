'use strict';
// =============================================================================
// 阶段切换全屏擦除过渡（切课 / 待课→登记→课中→归还→已结束）
//
// 纯视觉层，独立于 #stage，不触碰 stage.innerHTML，故不影响渲染层测试断言。
// 由 app.js 在每次 renderStage() 时调用 StageFx.onPhase(state.phase)：
//   仅当 phase 相对上一帧发生变化才触发一次 #fx-wipe 擦除动画，避免每次重渲染闪屏。
// 用 classList 守卫：无头测试桩无 classList 时直接跳过。
// =============================================================================
(function (global) {
  let el = null;
  let lastPhase = null;

  function ensure() {
    if (!el) el = document.getElementById('fx-wipe');
    return el;
  }

  function onPhase(phase) {
    el = ensure();
    const changed = lastPhase !== null && phase !== lastPhase;
    lastPhase = phase;
    if (!changed || !el || !el.classList) return;
    el.classList.remove('play');
    void el.offsetWidth; // 强制 reflow，重复 phase 变化也能重启动画
    el.classList.add('play');
    el.addEventListener('animationend', () => el.classList.remove('play'), { once: true });
  }

  global.StageFx = { onPhase };
})(window);
