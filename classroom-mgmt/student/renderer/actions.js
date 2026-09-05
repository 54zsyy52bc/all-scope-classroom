'use strict';
// =============================================================================
// 学生端 · 业务动作（器材选择 / 登记 / 任务状态 / 归还确认 / 事件委托）
//
// 依赖注入：create(ctx) 接收控制器闭包内的共享值。
// ctx = { state, els, sendUp, sendHello, renderStage, renderMeta, bridge, log,
//         pad2, saveLocal, toast }
// 器材清单来自 window.EQUIPMENT，渲染模板来自 window.Views。
// =============================================================================
(function (global) {
  const Views = global.Views;
  // 器材清单惰性读取：教师端上课时动态下发（applyEquipmentList 原地替换），
  // 动作层每次提交时取最新，避免登记页与下发清单不一致。
  function equipment() { return global.EQUIPMENT || []; }

  function create(c) {
    const state = c.state;
    const els = c.els;
    const sendUp = c.sendUp;
    const sendHello = c.sendHello;
    const renderStage = c.renderStage;
    const renderMeta = c.renderMeta;
    const bridge = c.bridge;
    const log = c.log;
    const pad2 = c.pad2;
    const saveLocal = c.saveLocal;
    const toast = c.toast;
    let helloAfterSubmit = null;

    function resetEquipQty() {
      state.equipQty = {};
      for (const e of equipment()) if (e.preset) state.equipQty[e.eqId] = e.preset;
    }

    function readInputs() {
      return {
        name: (document.getElementById('f-name') || {}).value || '',
        seat: pad2((document.getElementById('f-seat') || {}).value),
        studentNo: (document.getElementById('f-no') || {}).value || '',
        note: (document.getElementById('f-note') || {}).value || '',
      };
    }

    function submitCheckin() {
      if (state.checkinDone) return; // 防重复提交（快速连点/回车）
      const v = readInputs();
      const hint = document.getElementById('checkin-hint');
      if (!v.name.trim()) { hint.textContent = '请填写姓名'; return; }
      if (!v.seat) { hint.textContent = '座位号请填 1-99 的数字，例如 7 号座位填 07'; return; }

      state.name = v.name.trim();
      state.seat = v.seat;
      state.studentNo = v.studentNo.trim();
      const equipments = equipment()
        .filter((e) => (state.equipQty[e.eqId] || 0) > 0)
        .map((e) => ({ eqId: e.eqId, qty: state.equipQty[e.eqId] }));

      if (!sendUp('checkin', { name: state.name, studentNo: state.studentNo, equipments })) return;

      state.borrowed = equipments.map((x) => ({ eqId: x.eqId, qty: x.qty }));
      state.checkinDone = true;
      renderMeta();
      renderStage();
      persistProfile();
      reverify();
    }

    function submitTaskStatus(status) {
      if (!state.currentTask || !state.currentTask.taskId) return;
      if (!sendUp('task', { taskId: state.currentTask.taskId, status })) return;
      state.taskStatus = status;
      renderStage();
    }

    function submitReturn() {
      if (state.returnDone) return; // 防重复提交（快速连点/回车）
      const borrowed = state.borrowed || [];
      const v = readInputs();
      state.note = v.note.trim();
      if (borrowed.length) {
        const missing = borrowed.filter((b) => !state.returnChecked[b.eqId]);
        if (missing.length) {
          const hint = document.getElementById('return-hint');
          hint.textContent = '还有 ' + missing.length + ' 项没有勾选，确认已全部放回器材柜';
          return;
        }
      }
      if (!sendUp('return', { note: state.note, allReturned: true })) return;
      state.returnDone = true;
      renderStage();
      reverify();
    }

    // 上行无 ACK：1.5s 后补发 hello，用 sync 回传的服务端真值校正本地乐观状态
    function reverify() {
      if (helloAfterSubmit) clearTimeout(helloAfterSubmit);
      helloAfterSubmit = setTimeout(() => {
        helloAfterSubmit = null;
        sendHello();
      }, 1500);
    }

    function persistProfile() {
      const b = bridge();
      if (!b || !b.saveProfile) return;
      b.saveProfile({ seat: state.seat, name: state.name, studentNo: state.studentNo })
        .catch((e) => log('座位信息保存失败: ' + (e && e.message)));
    }

    // 只重绘器材区块，避免整页重渲染打断输入框焦点与已输入内容
    function redrawEquipList(kind) {
      const selector = kind === 'return-list' ? '.return-block' : '.equip-list';
      const host = els.stage.querySelector(selector);
      if (!host) { renderStage(); return; }
      const tmp = document.createElement('div');
      tmp.innerHTML = kind === 'return-list' ? Views.returnList(state) : Views.equipList(state);
      const next = tmp.querySelector(selector) || tmp.firstElementChild;
      host.replaceWith(next);
      saveLocal();
    }

    function onStageClick(e) {
      const el = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!el) return;
      const act = el.dataset.act;
      const eqId = el.dataset.eq;

      if (act === 'equip-toggle') {
        state.equipQty[eqId] = (state.equipQty[eqId] || 0) > 0 ? 0 : 1;
        redrawEquipList('equip-list');
      } else if (act === 'equip-step') {
        const next = (state.equipQty[eqId] || 0) + Number(el.dataset.delta);
        state.equipQty[eqId] = Math.max(0, Math.min(99, next));
        redrawEquipList('equip-list');
      } else if (act === 'checkin-submit') {
        submitCheckin();
      } else if (act === 'task-status') {
        submitTaskStatus(el.dataset.status);
      } else if (act === 'return-toggle') {
        state.returnChecked[eqId] = !state.returnChecked[eqId];
        redrawEquipList('return-list');
      } else if (act === 'return-toggle-all') {
        const all = (state.borrowed || []).every((b) => state.returnChecked[b.eqId]);
        for (const b of (state.borrowed || [])) state.returnChecked[b.eqId] = !all;
        redrawEquipList('return-list');
      } else if (act === 'return-submit') {
        submitReturn();
      }
    }

    function onStageKeydown(e) {
      if (e.key !== 'Enter') return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag !== 'input') return;
      e.preventDefault();
      if (state.phase === 'checkin' && !state.checkinDone) submitCheckin();
      else if (state.phase === 'return' && !state.returnDone) submitReturn();
    }

    return { onStageClick, onStageKeydown, resetEquipQty, submitCheckin, submitReturn };
  }

  global.Actions = { create };
})(window);
