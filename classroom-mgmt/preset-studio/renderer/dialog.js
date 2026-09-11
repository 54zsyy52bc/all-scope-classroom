'use strict';
// Preset Studio · 可复用确认弹窗（替代原生 confirm；Electron 渲染进程内运行）
// 暴露 window.PresetDialog.confirmDialog({ title, message, confirmText, cancelText, danger }) -> Promise<boolean>
// 说明：preset-studio 为离线编辑器，不依赖教师端 window.DashboardDialog，此处独立精简实现。
(function (global) {
  function ensureDom() {
    if (document.getElementById('overlay-dialog')) return;
    const ov = document.createElement('div');
    ov.className = 'overlay'; ov.id = 'overlay-dialog'; ov.hidden = true;
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    const m = document.createElement('div'); m.className = 'modal';
    m.setAttribute('aria-labelledby', 'dialog-title');
    m.innerHTML = ''
      + '<h2 id="dialog-title"></h2>'
      + '<p id="dialog-message"></p>'
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
    const ov = document.getElementById('overlay-dialog');
    const title = document.getElementById('dialog-title');
    const msg = document.getElementById('dialog-message');
    const cancel = document.getElementById('dialog-cancel');
    const confirm = document.getElementById('dialog-confirm');
    title.textContent = opts.title || '请确认';
    msg.textContent = opts.message || '';
    msg.hidden = !opts.message;
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
      // Esc 关闭 = 取消，保证键盘可达性
      function onKey(e) { if (e.key === 'Escape') done(false); }
      confirm.onclick = function () { done(true); };
      cancel.onclick = function () { done(false); };
      ov.onclick = function (e) { if (e.target === ov) done(false); };
      document.addEventListener('keydown', onKey);
    });
  }

  global.PresetDialog = { confirmDialog: confirmDialog };
})(window);
