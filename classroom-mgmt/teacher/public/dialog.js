'use strict';
// 教师大屏 · 可复用确认/输入弹窗（替代原生 confirm/prompt，统一 UX 且让输入非法时就地报错）
// 暴露 window.DashboardDialog.confirmDialog / promptDialog
//   confirmDialog({ title, message, confirmText, cancelText, danger }) -> Promise<boolean>
//   promptDialog({ title, label, value, validate }) -> Promise<string|null>
//     validate(v) 返回 null/'' 表示通过；返回字符串表示就地显示的中文错误
(function (global) {
  function $(id) { return document.getElementById(id); }

  // 惰性创建弹窗 DOM（index.html 已预置时跳过）
  function ensureDom() {
    if ($('overlay-dialog')) return;
    const ov = document.createElement('div');
    ov.className = 'overlay'; ov.id = 'overlay-dialog'; ov.hidden = true;
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    const m = document.createElement('div'); m.className = 'modal';
    m.setAttribute('aria-labelledby', 'dialog-title');
    m.innerHTML = ''
      + '<h2 id="dialog-title"></h2>'
      + '<p id="dialog-message"></p>'
      + '<label id="dialog-prompt-wrap" hidden><span id="dialog-prompt-label"></span>'
      + '<input id="dialog-input" type="text" /></label>'
      + '<p class="dialog-error" id="dialog-error" hidden></p>'
      + '<div class="modal-actions">'
      + '<button class="btn btn-ghost" id="dialog-cancel"></button>'
      + '<button class="btn btn-primary" id="dialog-confirm"></button>'
      + '</div>';
    ov.appendChild(m);
    document.body.appendChild(ov);
  }

  function confirmDialog(opts) {
    ensureDom();
    opts = opts || {};
    const ov = $('overlay-dialog');
    const title = $('dialog-title');
    const msg = $('dialog-message');
    const pwrap = $('dialog-prompt-wrap');
    const err = $('dialog-error');
    const cancel = $('dialog-cancel');
    const confirm = $('dialog-confirm');
    title.textContent = opts.title || '请确认';
    msg.textContent = opts.message || '';
    msg.hidden = !opts.message;
    pwrap.hidden = true;
    err.hidden = true; err.textContent = '';
    cancel.textContent = opts.cancelText || '取消';
    confirm.textContent = opts.confirmText || '确认';
    confirm.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
    ov.hidden = false;
    setTimeout(function () { (opts.danger ? cancel : confirm).focus(); }, 30);
    return new Promise(function (resolve) {
      function done(v) {
        ov.hidden = true;
        confirm.onclick = null; cancel.onclick = null; ov.onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(v);
      }
      // Esc 关闭 = 取消（与 promptDialog 一致，保证键盘可达性）
      function onKey(e) { if (e.key === 'Escape') done(false); }
      confirm.onclick = function () { done(true); };
      cancel.onclick = function () { done(false); };
      ov.onclick = function (e) { if (e.target === ov) done(false); };
      document.addEventListener('keydown', onKey);
    });
  }

  function promptDialog(opts) {
    ensureDom();
    opts = opts || {};
    const ov = $('overlay-dialog');
    const title = $('dialog-title');
    const msg = $('dialog-message');
    const pwrap = $('dialog-prompt-wrap');
    const plabel = $('dialog-prompt-label');
    const input = $('dialog-input');
    const err = $('dialog-error');
    const cancel = $('dialog-cancel');
    const confirm = $('dialog-confirm');
    title.textContent = opts.title || '请输入';
    msg.textContent = ''; msg.hidden = true;
    plabel.textContent = opts.label || '';
    pwrap.hidden = false;
    input.value = opts.value != null ? String(opts.value) : '';
    err.hidden = true; err.textContent = '';
    cancel.textContent = opts.cancelText || '取消';
    confirm.textContent = opts.confirmText || '确定';
    confirm.className = 'btn btn-primary';
    ov.hidden = false;
    setTimeout(function () { input.focus(); if (input.select) input.select(); }, 30);
    return new Promise(function (resolve) {
      function close(v) {
        ov.hidden = true;
        confirm.onclick = null; cancel.onclick = null; ov.onclick = null; input.onkeydown = null;
        resolve(v);
      }
      function submit() {
        const v = input.value;
        const bad = opts.validate ? opts.validate(v) : null;
        if (bad) { err.textContent = bad; err.hidden = false; input.focus(); return; }
        close(v);
      }
      confirm.onclick = submit;
      cancel.onclick = function () { close(null); };
      ov.onclick = function (e) { if (e.target === ov) close(null); };
      input.onkeydown = function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(null); }
      };
    });
  }

  global.DashboardDialog = { confirmDialog: confirmDialog, promptDialog: promptDialog };
})(window);
