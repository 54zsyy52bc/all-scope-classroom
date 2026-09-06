'use strict';
// =============================================================================
// 视图层：纯函数 state -> HTML 字符串。不读 DOM、不发消息、不含业务判断。
// 所有图标取自 shared/icons.js（Lucide 描边 SVG），尺寸 16 / 20 / 24 三档，全项目一致。
// 事件由 app.js 在容器上做委托（data-act），本文件不挂监听器。
// =============================================================================
(function (global) {
  const Icons = global.Icons;
  // 器材清单惰性读取：教师端上课时动态下发（applyEquipmentList 原地替换），
  // 视图层每次渲染时取最新，不缓存快照。
  function equipment() { return global.EQUIPMENT || []; }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function icon(name, size, cls) {
    return Icons.svg(name, size, cls);
  }

  function equipName(eqId) {
    for (const e of equipment()) if (e.eqId === eqId) return e.eqName;
    return eqId;
  }

  // ---------------------------------------------------------------------------
  // 登记页：器材选择列表（可单独重绘，避免整页重渲染打断输入框焦点）
  // ---------------------------------------------------------------------------
  function equipList(state) {
    const qty = state.equipQty || {};
    return '<div class="equip-list">' + equipment().map((e) => {
      const n = qty[e.eqId] || 0;
      const on = n > 0;
      return '<div class="equip' + (on ? ' equip-on' : '') + '" data-eq="' + esc(e.eqId) + '">'
        + '<button type="button" class="equip-main" data-act="equip-toggle" data-eq="' + esc(e.eqId) + '"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '">'
        + '<span class="equip-box">' + icon(on ? 'check-square' : 'square', 24) + '</span>'
        + '<span class="equip-text"><span class="equip-name">' + esc(e.eqName) + '</span>'
        + '<span class="equip-cat">' + esc(e.category) + '</span></span>'
        + '</button>'
        + '<div class="equip-stepper">'
        + '<button type="button" class="step-btn" data-act="equip-step" data-eq="' + esc(e.eqId) + '"'
        + ' data-delta="-1" aria-label="减少 ' + esc(e.eqName) + ' 数量"' + (on ? '' : ' disabled') + '>-</button>'
        + '<span class="step-val">' + (on ? n : '—') + '</span>'
        + '<button type="button" class="step-btn" data-act="equip-step" data-eq="' + esc(e.eqId) + '"'
        + ' data-delta="1" aria-label="增加 ' + esc(e.eqName) + ' 数量">+</button>'
        + '</div></div>';
    }).join('') + '</div>';
  }

  // ---------------------------------------------------------------------------
  // 归还页：借用清单勾选（同样可单独重绘）
  // ---------------------------------------------------------------------------
  function returnList(state) {
    const borrowed = state.borrowed || [];
    if (!borrowed.length) {
      return '<p class="empty">本次登记没有记录到借用器材。若实际领用了，请联系老师补登。</p>';
    }
    const checked = state.returnChecked || {};
    const all = borrowed.every((b) => checked[b.eqId]);
    let html = '<div class="return-block"><div class="return-master">'
      + '<button type="button" class="equip-main" data-act="return-toggle-all" aria-pressed="' + (all ? 'true' : 'false') + '">'
      + '<span class="equip-box">' + icon(all ? 'check-square' : 'square', 24) + '</span>'
      + '<span class="equip-text"><span class="equip-name">全部已放回器材柜</span>'
      + '<span class="equip-cat">一次性勾选全部 ' + borrowed.length + ' 项</span></span></button></div>';
    html += '<div class="equip-list">' + borrowed.map((b) => {
      const on = !!checked[b.eqId];
      return '<div class="equip' + (on ? ' equip-on' : '') + '" data-eq="' + esc(b.eqId) + '">'
        + '<button type="button" class="equip-main" data-act="return-toggle" data-eq="' + esc(b.eqId) + '"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '">'
        + '<span class="equip-box">' + icon(on ? 'check-square' : 'square', 24) + '</span>'
        + '<span class="equip-text"><span class="equip-name">' + esc(equipName(b.eqId)) + '</span>'
        + '<span class="equip-cat">借用数量 ' + esc(b.qty) + '</span></span></button></div>';
    }).join('') + '</div></div>';
    return html;
  }

  // ---------------------------------------------------------------------------
  // 各阶段整页
  // ---------------------------------------------------------------------------
  function viewIdle(state) {
    return '<section class="panel panel-center">'
      + '<span class="hero-icon">' + icon('monitor', 64) + '</span>'
      + '<h1 class="hero-title">等待老师开始上课</h1>'
      + '<p class="hero-sub">老师点「上课」后，本页会自动切换到登记页面。<br />'
      + '请先确认右上角连接状态为「已连接」。</p>'
      + '<div class="meta-row">'
      + '<span class="meta">' + icon('hash', 16) + '座位 ' + esc(state.seat || '未设置') + '</span>'
      + '<span class="meta">' + icon('monitor', 16) + '机器号 ' + esc(state.machineId) + '</span>'
      + '</div></section>';
  }

  function viewCheckinDone(state) {
    const items = (state.borrowed || []).map((b) => '<li>' + icon('package', 16)
      + '<span>' + esc(equipName(b.eqId)) + '</span><b>×' + esc(b.qty) + '</b></li>').join('');
    return '<section class="panel panel-center">'
      + '<span class="state-icon" data-state="done">' + icon('circle-check', 64) + '</span>'
      + '<h1 class="hero-title">登记成功</h1>'
      + '<p class="hero-sub">' + esc(state.name || '') + ' · 座位 ' + esc(state.seat || '') + '</p>'
      + (items ? '<ul class="summary-list">' + items + '</ul>' : '')
      + '<p class="hint">等待老师发布任务，页面会自动切换。</p></section>';
  }

  function viewCheckin(state) {
    return '<section class="panel">'
      + '<header class="panel-head">'
      + '<span class="step-badge">第 1 步 / 共 3 步</span>'
      + '<h1 class="panel-title">' + icon('clipboard-check', 24) + '上课登记</h1>'
      + '<p class="panel-sub">填写姓名与座位号，核对领到的器材，然后确认登记。</p></header>'
      + '<div class="form-grid">'
      + '<label class="field"><span class="field-label">姓名</span>'
      + '<input id="f-name" class="input" type="text" maxlength="20" autocomplete="off"'
      + ' placeholder="例如：陈书瑶" value="' + esc(state.name || '') + '" /></label>'
      + '<label class="field field-seat"><span class="field-label">座位号</span>'
      + '<input id="f-seat" class="input input-seat" type="text" inputmode="numeric" maxlength="2"'
      + ' autocomplete="off" placeholder="07" value="' + esc(state.seat || '') + '" /></label>'
      + '<label class="field"><span class="field-label">学号（选填）</span>'
      + '<input id="f-no" class="input" type="text" maxlength="24" autocomplete="off"'
      + ' placeholder="例如：2024070312" value="' + esc(state.studentNo || '') + '" /></label>'
      + '</div>'
      + '<div class="section-head"><h2>' + icon('package', 20) + '领用器材</h2>'
      + '<p>点卡片选中或取消，右侧加减数量。数量按实际领到的填。</p></div>'
      + equipList(state)
      + '<div class="actions"><button type="button" class="btn btn-primary btn-xl" data-act="checkin-submit">'
      + icon('check-square', 24) + '确认登记</button></div>'
      + '<p class="hint hint-error" id="checkin-hint"></p></section>';
  }

  // 计时器块：mm:ss + 状态（running 正常 / paused 灰显 / expired 红色截止）
  function timerBlock(t) {
    if (!t || !t.timed) return '';
    const state = t.timerState || 'idle';
    if (state === 'closed' || state === 'idle') return '';
    const ms = Math.max(0, t.remainingMs || 0);
    const mm = Math.floor(ms / 60000).toString().padStart(2, '0');
    const ss = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
    const label = state === 'running' ? '活动进行中' : state === 'paused' ? '计时已暂停' : '活动已截止';
    return '<div class="activity-timer" data-state="' + state + '">'
      + '<span class="timer-icon">' + icon('timer', 28) + '</span>'
      + '<span class="timer-time">' + mm + ':' + ss + '</span>'
      + '<span class="timer-label">' + label + '</span></div>';
  }

  function viewTask(state) {
    const t = state.currentTask;
    if (!t || !t.taskId) {
      return '<section class="panel panel-center">'
        + '<span class="hero-icon">' + icon('megaphone', 64) + '</span>'
        + '<h1 class="hero-title">等待老师发布任务</h1>'
        + '<p class="hero-sub">老师发布后，这里会出现任务内容和三个状态按钮。</p></section>';
    }
    const opts = [
      { key: 'doing', label: '进行中', iconName: 'play' },
      { key: 'done', label: '已完成', iconName: 'circle-check' },
      { key: 'help', label: '求助', iconName: 'circle-help' },
    ];
    const buttons = opts.map((o) => {
      const on = state.taskStatus === o.key;
      return '<button type="button" class="btn-status" data-act="task-status" data-status="' + o.key + '"'
        + ' data-state="' + o.key + '" data-active="' + (on ? 'true' : 'false') + '"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '">'
        + '<span class="btn-status-icon">' + icon(o.iconName, 32) + '</span>'
        + '<span class="btn-status-label">' + o.label + '</span></button>';
    }).join('');
    const label = (state.taskStatus === 'doing' ? '进行中' : state.taskStatus === 'done' ? '已完成'
      : state.taskStatus === 'help' ? '求助' : '尚未选择');
    return '<section class="panel">'
      + '<header class="panel-head">'
      + '<span class="step-badge">第 1 步 / 共 1 步</span>'
      + '<h1 class="panel-title">' + icon('activity', 24) + esc(t.title) + '</h1>'
      + '<p class="panel-sub">' + esc(t.desc || '按老师要求完成操作，随时点下方按钮更新进度。') + '</p></header>'
      + timerBlock(t)
      + '<div class="status-grid">' + buttons + '</div>'
      + '<p class="hint">当前状态：<b id="task-current">' + label + '</b></p></section>';
  }

  function viewReturnDone(state) {
    return '<section class="panel panel-center">'
      + '<span class="state-icon" data-state="done">' + icon('package-check', 64) + '</span>'
      + '<h1 class="hero-title">已确认归还</h1>'
      + '<p class="hero-sub">全班都归还后，老师会下发关机指令，这台电脑会自动关机。</p>'
      + '<p class="hint">如果还要继续用电脑，请举手告知老师，老师会为你撤销关机。</p></section>';
  }

  function viewReturn(state) {
    return '<section class="panel">'
      + '<header class="panel-head">'
      + '<span class="step-badge">第 1 步 / 共 2 步</span>'
      + '<h1 class="panel-title">' + icon('package-check', 24) + '归还确认</h1>'
      + '<p class="panel-sub">把器材放回器材柜，逐项打勾后再点确认归还。</p></header>'
      + returnList(state)
      + '<label class="field"><span class="field-label">备注（选填：损坏、缺失等）</span>'
      + '<input id="f-note" class="input" type="text" maxlength="60" autocomplete="off"'
      + ' placeholder="例如：开发板 USB 口松动" value="' + esc(state.note || '') + '" /></label>'
      + '<div class="actions"><button type="button" class="btn btn-primary btn-xl" data-act="return-submit">'
      + icon('package-check', 24) + '确认归还</button></div>'
      + '<p class="hint hint-error" id="return-hint"></p></section>';
  }

  function viewClosed() {
    return '<section class="panel panel-center">'
      + '<span class="state-icon" data-state="done">' + icon('circle-check', 64) + '</span>'
      + '<h1 class="hero-title">本课已结束</h1>'
      + '<p class="hero-sub">请带好个人物品，有序离开机房。</p></section>';
  }

  function render(state) {
    if (state.phase === 'checkin') {
      return state.checkinDone ? viewCheckinDone(state) : viewCheckin(state);
    }
    if (state.phase === 'task') return viewTask(state);
    if (state.phase === 'return') {
      return state.returnDone ? viewReturnDone(state) : viewReturn(state);
    }
    if (state.phase === 'closed') return viewClosed();
    return viewIdle(state);
  }

  global.Views = { render, equipList, returnList, esc, equipName };
})(window);
