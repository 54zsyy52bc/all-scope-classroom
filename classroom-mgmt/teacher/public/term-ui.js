'use strict';
// ===== v5 组机 UI 辅助（终端标签 + 开始表单座位联动），从 app.js 抽出控行数 =====
(function (global) {
  function termLabel(gid) {
    const m = /^G(\d+)$/.exec(gid || '');
    return m ? '终端 ' + String(Number(m[1])).padStart(2, '0') : String(gid || '');
  }
  function syncTermSeats() {
    if (!global.document) return;
    const $ = (id) => global.document.getElementById(id);
    const fTerm = $('f-term');
    if (!fTerm || ($('f-class-preset') && $('f-class-preset').value)) return;
    const t = Math.max(1, Math.min(50, Number(fTerm.value) || 14));
    const k = Math.max(1, Math.min(20, Number($('f-members').value) || 6));
    $('f-seats').value = String(t * k);
    const note = $('f-seats-note'); if (note) note.textContent = t * k + '（' + t + ' 台 × ' + k + ' 人）';
  }
  global.termLabel = termLabel;
  global.syncTermSeats = syncTermSeats;
})(window);
