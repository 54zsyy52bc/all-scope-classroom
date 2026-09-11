'use strict';
// ===== 课程应用坞悬浮窗（渲染层）=====
// 常驻可拖动/可折叠悬浮面板：列出全部课堂应用并实时显示进程状态（未运行/运行中），
// 点击启动、运行中点击切前台。进程状态来自主进程 guard:apps 推送 + 主动轮询 getAppsState。
// 自己注入样式（不改 desktop.html 内联样式 / styles.css）；无桥接的浏览器预览环境直接 return。
(function () {
  function $el(id) { return document.getElementById(id); }
  function bridge() { return window.classroom || null; }
  const dock = $el('app-dock');
  const bb = bridge();
  if (!dock || !bb) return; // 浏览器预览/无桥接：不报错直接退出

  // 注入样式（直角、白底、#0078d7 强调色，跟随现有学生端风格）。
  // z-index 最终定为 38：悬浮窗是常驻非模态面板，必须浮在页面内容之上，
  // 但必须低于两个模态层 —— 底部抽屉 .drawer-mask(40)/.drawer(41) 与设置弹窗 #set-overlay(60)，
  // 否则展开抽屉/设置时悬浮窗会盖住它们（实测 55 会盖住抽屉，已改 38）。
  const STYLE = '#app-dock{font-family:"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;font-size:13px;}'
    + '#app-dock .adock{position:fixed;right:18px;top:72px;z-index:38;width:200px;background:#fff;border:1px solid #e0e0e0;box-shadow:0 2px 8px rgba(0,0,0,.12);}'
    + '#app-dock .adock-head{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#f5f5f5;border-bottom:1px solid #e0e0e0;cursor:move;user-select:none;}'
    + '#app-dock .adock-title{font-size:13px;font-weight:600;color:#1b1b1b;flex:1;}'
    + '#app-dock .adock-cnt{font-size:12px;color:#6f6f6f;}'
    + '#app-dock .adock-btn{font-family:inherit;font-size:12px;padding:3px 8px;cursor:pointer;border:1px solid #e0e0e0;background:#fff;color:#1b1b1b;}'
    + '#app-dock .adock-btn:hover{background:#eaf4fd;}'
    + '#app-dock .adock-body{max-height:50vh;overflow-y:auto;padding:6px;}'
    + '#app-dock .adock-row{display:flex;align-items:center;gap:8px;width:100%;padding:8px 6px;cursor:pointer;border:0;background:#fff;font-family:inherit;text-align:left;border-bottom:1px solid #f0f0f0;}'
    + '#app-dock .adock-row:hover{background:#eaf4fd;}'
    + '#app-dock .adock-dot{width:9px;height:9px;background:#bbb;flex:none;}'
    + '#app-dock .adock-dot[data-on="1"]{background:#107c10;}'
    + '#app-dock .adock-nm{font-size:13px;color:#1b1b1b;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
    + '#app-dock .adock-tag{font-size:12px;color:#6f6f6f;}'
    + '#app-dock .adock-tag.on{color:#107c10;}'
    + '#app-dock .adock-empty{padding:10px;color:#6f6f6f;font-size:13px;}'
    + '#app-dock .adock-min{position:fixed;right:18px;top:72px;z-index:38;background:#0078d7;color:#fff;padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit;}';
  const st = document.createElement('style');
  st.id = 'app-dock-style';
  st.textContent = STYLE;
  document.head.appendChild(st);

  let state = { ok: true, guardEnabled: false, minimizeOthers: true, apps: [], minimized: 0 };
  let pos = load('alls.dock.pos', null); // {left,top} 或 null（用 CSS 默认 right/top）
  let min = load('alls.dock.min', '0');
  let timer = null;
  let minToastAt = 0;

  function load(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (_e) { /* noop */ } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function render() {
    const apps = state.apps || [];
    const running = apps.filter((a) => a.running).length;
    if (min === '1') { // 收起：小胶囊
      dock.innerHTML = '<div class="adock-min" id="ad-min">课 ' + running + '/' + apps.length + '</div>';
      const cap = $el('ad-min'); if (cap) cap.onclick = toggleMin;
      applyPos(); // 收起态也要跟随拖动后的位置，否则一收起就跳回默认右上角
      return;
    }
    const rows = apps.map((a) => {
      const on = a.running ? '1' : '0';
      const tag = a.running ? ('运行中' + (a.procNames && a.procNames.length ? ' ' + a.procNames.length + ' 进程' : '')) : '未运行';
      return '<button class="adock-row" data-id="' + esc(a.id) + '">'
        + '<span class="adock-dot" data-on="' + on + '"></span>'
        + '<span class="adock-nm">' + esc(a.name) + '</span>'
        + '<span class="adock-tag' + (a.running ? ' on' : '') + '">' + tag + '</span></button>';
    }).join('');
    dock.innerHTML = '<div class="adock" id="ad-main">'
      + '<div class="adock-head" id="ad-head"><span class="adock-title">课程应用</span>'
      + '<span class="adock-cnt">' + running + '/' + apps.length + ' 运行</span>'
      + '<button class="adock-btn" data-act="min">收起</button></div>'
      + '<div class="adock-body">' + (rows || '<div class="adock-empty">无课堂应用</div>') + '</div></div>';
    const btn = dock.querySelector('[data-act="min"]');
    if (btn) {
      btn.onclick = toggleMin;
      // 阻止冒泡到 .adock-head：否则点「收起」会顺带触发一次拖动，
      // 手抖几像素就把悬浮窗位置改了并写进 localStorage。
      btn.onmousedown = (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation(); };
    }
    const head = $el('ad-head'); if (head) head.onmousedown = startDrag;
    dock.querySelectorAll('.adock-row').forEach((el) => { el.onclick = () => onRow(el.dataset.id); });
    applyPos();
  }

  function onRow(id) {
    const a = (state.apps || []).find((x) => x.id === id);
    if (!a) return;
    if (a.running) { if (bb.focusApp) bb.focusApp(id); }
    else { if (bb.launchApp) bb.launchApp(id); }
    setTimeout(refresh, 300); // 启动/切前台后稍等再刷新一次状态
  }

  // 拖动：首次把 CSS 的 right/top 换算成 left/top
  let drag = null;
  function startDrag(e) {
    const main = $el('ad-main'); if (!main) return;
    const rect = main.getBoundingClientRect();
    const base = pos || { left: rect.left, top: rect.top };
    drag = { x: e.clientX, y: e.clientY, l: base.left, t: base.top };
    document.onmousemove = onDrag; document.onmouseup = endDrag;
    e.preventDefault();
  }
  // 边界钳制：位置会持久化到 localStorage，若不钳制，一旦拖出屏幕外就被永久存下来，
  // 下次进入课堂悬浮窗直接「消失」，学生无法自救（这是必须防的失效模式）。
  function clampPos(p) {
    const el = $el('ad-main') || $el('ad-min');
    const w = (el && el.offsetWidth) || 200;
    const h = (el && el.offsetHeight) || 40;
    const maxL = Math.max(0, window.innerWidth - w - 6);
    const maxT = Math.max(0, window.innerHeight - h - 6);
    return { left: Math.min(Math.max(0, p.left), maxL), top: Math.min(Math.max(0, p.top), maxT) };
  }
  function onDrag(e) {
    if (!drag) return;
    pos = clampPos({ left: drag.l + (e.clientX - drag.x), top: drag.t + (e.clientY - drag.y) });
    applyPos();
  }
  function endDrag() {
    document.onmousemove = null; document.onmouseup = null; drag = null;
    if (pos) pos = clampPos(pos);
    save('alls.dock.pos', JSON.stringify(pos));
  }
  function applyPos() {
    const el = $el('ad-main') || $el('ad-min');
    if (!el || !pos) return;
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
    el.style.right = 'auto';
  }

  function toggleMin() { min = (min === '1') ? '0' : '1'; save('alls.dock.min', min); render(); }

  async function refresh() {
    try { const s = await bb.getAppsState(); if (s) state = s; render(); } catch (_e) { /* noop */ }
  }

  function floatMinToast(p) {
    const now = Date.now();
    if (now - minToastAt < 5000) return; // 5 秒内最多一次，不刷屏
    minToastAt = now;
    const exes = (p && p.exes) || [];
    const txt = '已自动最小化：' + (exes.length ? exes.join(', ') : '非课堂应用');
    let el = $el('ad-float');
    if (!el) {
      el = document.createElement('div'); el.id = 'ad-float';
      el.style.cssText = 'position:fixed;right:18px;bottom:64px;background:#0078d7;color:#fff;padding:8px 14px;z-index:39;font-size:13px;font-family:inherit';
      document.body.appendChild(el);
    }
    el.textContent = txt;
    setTimeout(() => { if (el && el.parentNode) el.parentNode.removeChild(el); }, 3000);
  }

  function boot() {
    if (bb.guardStart) { try { bb.guardStart(); } catch (_e) { /* 课堂登记页也要进程状态 */ } }
    render();
    refresh();
    if (bb.onApps) bb.onApps((p) => { if (p) { state = p; render(); } });
    if (bb.onMinimize) bb.onMinimize((p) => floatMinToast(p));
    timer = setInterval(refresh, 2500);
    // 接投影/换显示器导致分辨率变化后，旧的持久化坐标可能已经在屏幕外 → 重新钳制
    if (pos) { pos = clampPos(pos); applyPos(); }
    window.addEventListener('resize', () => { if (pos) { pos = clampPos(pos); applyPos(); } });
    window.addEventListener('beforeunload', () => { if (timer) clearInterval(timer); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
