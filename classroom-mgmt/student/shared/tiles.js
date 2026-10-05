'use strict';
// =============================================================================
// 共用磁贴模块：课堂页（index.html 磁贴主屏）与桌面页（desktop.html）共用同一份
// 磁贴 DOM 生成逻辑，避免两页各写一份 tileHtml 而漂移（见 desktop-tile-and-launch 测试 A 段）。
// 纯函数：不读 DOM、不发消息、与 state 无关。挂 window.Tiles。
// esc() 一并带过来（原 desktop.js 的 esc），保持 HTML 转义与桌面页一致。
// =============================================================================
(function (global) {
  // 与 desktop.js 原 esc 逐字一致（shared/icons.js 的转义规则也同源）
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // 双面磁贴：front 显示图标+名称，hover 时 inner 翻转露出 back（名称+状态提示）。
  // 必须逐字保持 desktop.js 原有的 DOM 结构与类名（.tile / .tile-inner / .tile-front /
  // .tile-back / .ico / .nm / .bk-nm / .bk-tip / data-id / .empty-guide），
  // 因为已有测试（desktop-tile-and-launch.test.js）和 styles.css 依赖它们。
  function tileHtml(a, big) {
    const initial = String(a.name || '?').slice(0, 1).toUpperCase();
    const cls = big ? 'tile' : 'd-app';
    const tip = big ? '点击打开' : '课程应用';
    return '<button type="button" class="' + cls + '" data-id="' + esc(a.id) + '" title="' + esc(a.name) + '">'
      + '<span class="tile-inner">'
      + '<span class="tile-front"><span class="ico">' + esc(initial) + '</span><span class="nm">' + esc(a.name) + '</span></span>'
      + '<span class="tile-back"><span class="bk-nm">' + esc(a.name) + '</span><span class="bk-tip">' + tip + '</span></span>'
      + '</span></button>';
  }

  // 首页网格：homeApps 优先，否则全部应用；无应用时显示引导文案（emptyText 由调用方决定，
  // 课堂页不暴露设置入口，故传「请老师来设置」这类文案，设置只在桌面页有）。
  function gridHtml(apps, homeIds, emptyText) {
    if (!apps || !apps.length) {
      return '<div class="empty-guide">' + esc(emptyText || '还没有课程应用') + '</div>';
    }
    const home = apps.filter((a) => (homeIds || []).includes(a.id));
    const shown = home.length ? home : apps;
    return shown.map((a) => tileHtml(a, true)).join('');
  }

  // v5.6 应用包：按应用名过滤本机应用（教师端开课选应用包后随 sync 下发 appNames）。
  // 学生机应用 id 跨机不稳定，只有名称可对应，故按 name 精确匹配（去首尾空格）。
  // names 为 null / 空数组 = 不过滤（返回本机全部应用）；全部匹配失败时返回 []，由调用方决定空态文案。
  function filterByNames(apps, names) {
    if (!Array.isArray(names) || !names.length) return apps || [];
    const set = new Set(names.map((n) => String(n == null ? '' : n).trim()).filter(Boolean));
    if (!set.size) return apps || [];
    return (apps || []).filter((a) => set.has(String((a && a.name) || '').trim()));
  }

  global.Tiles = { tileHtml, gridHtml, filterByNames, esc };
})(window);
