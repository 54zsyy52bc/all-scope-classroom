'use strict';
// 学生导航首页：把 data/nav-config.json 渲染成「快捷按钮 + 分组站点卡」
(function () {
  const { api, esc, el, toast, log } = window.GN;

  async function openSite(site) {
    const url = String(site.url || '');
    if (url.startsWith('internal:')) {
      const action = url.slice('internal:'.length).toLowerCase();
      if (action === 'siot') {
        // 一键打开 SIoT 控制台：先探活，在跑就直接开；没跑就给启动指引
        const r = await api.probeSiot();
        const res = r && r.result;
        if (res && res.running) {
          toast('SIoT 服务已启动，正在打开控制台…');
          await api.openSiotConsole(true);
        } else {
          toast('没有检测到本机 SIoT 服务，先看启动步骤', 'warn');
          await api.openInternal('siot');
        }
        return;
      }
      api.openInternal(['home', 'ip', 'qy', 'help'].includes(action) ? action : 'home');
      return;
    }
    const r = await api.go(url);
    if (r && r.ok === false) toast(r.err || '打不开这个网站', 'warn');
  }

  function renderQuick(list) {
    const box = document.getElementById('quick');
    box.innerHTML = '';
    (list || []).forEach((q) => {
      const btn = el('button', { class: 'quick-item', type: 'button' },
        '<span class="quick-ico">' + esc(q.icon || '⚡') + '</span>'
        + '<span class="quick-txt"><strong>' + esc(q.name) + '</strong><span>' + esc(q.desc || '') + '</span></span>');
      btn.onclick = () => openSite({ url: 'internal:' + (q.action || 'home') });
      box.appendChild(btn);
    });
  }

  function renderGroups(groups) {
    const box = document.getElementById('groups');
    box.innerHTML = '';
    if (!groups || !groups.length) {
      box.appendChild(el('div', { class: 'card' },
        '<h2>还没有配置导航内容</h2><p class="muted">老师可以按 <code>Ctrl + Shift + A</code> 进入管理页添加常用网站。</p>'));
      return;
    }
    groups.forEach((g) => {
      const wrap = el('div', { class: 'group' });
      const head = el('div', { class: 'group-head' });
      head.appendChild(el('span', { class: 'dot', style: 'background:' + esc(g.color || '#16a34a') }));
      head.appendChild(el('h2', {}, esc((g.icon ? g.icon + ' ' : '') + g.name)));
      head.appendChild(el('span', { class: 'cnt' }, '(' + (g.sites || []).length + ' 个网站)'));
      wrap.appendChild(head);

      const grid = el('div', { class: 'grid' });
      (g.sites || []).forEach((s) => {
        const internal = String(s.url).startsWith('internal:');
        const card = el('button', { class: 'site', type: 'button', title: internal ? '本机功能' : s.url },
          '<span class="site-ico">' + esc(s.icon || '🔗') + '</span>'
          + '<span class="site-txt"><strong>' + esc(s.name) + '</strong><span>'
          + esc(s.desc || s.url) + '</span></span>'
          + (internal ? '<span class="badge">本机</span>' : ''));
        card.onclick = () => openSite(s);
        grid.appendChild(card);
      });
      wrap.appendChild(grid);
      box.appendChild(wrap);
    });
  }

  async function boot() {
    let cfg = null;
    try {
      const r = await api.getNavConfig();
      if (r && r.config) cfg = r.config;
    } catch (e) { log('读取导航配置失败：' + (e && e.message)); }

    if (cfg) {
      document.getElementById('title').textContent = cfg.title || '绿网 · 学生导航';
      document.getElementById('subtitle').textContent = cfg.subtitle || '';
      renderQuick(cfg.quickActions);
      renderGroups(cfg.groups);
      document.title = cfg.title || '绿网 · 学生导航';
    }

    try {
      const rt = await api.getRuntime();
      if (rt && rt.ok) {
        document.getElementById('meta').textContent =
          '机器 ' + (rt.machineId || '--') + '　|　网页屏蔽：'
          + (rt.blockEnabled ? (rt.blockMode === 'whitelist' ? '仅允许老师指定的网站' : '已开启') : '已关闭');
      }
    } catch (_e) { /* noop */ }
    log('home ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
