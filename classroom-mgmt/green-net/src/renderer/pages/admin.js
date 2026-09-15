'use strict';
// =============================================================================
// 教师管理页
//
// 双重把关：
//   1) 页面自己的口令门 —— 未验证前不渲染任何管理控件
//   2) 主进程 ipc.js 的"发送方 URL"鉴权 —— 只有 gnet://admin 能调用写通道
// 两者缺一不可：前者防学生直接看到界面，后者防网页伪造调用。
// =============================================================================
(function () {
  const { api, esc, el, toast, log } = window.GN;
  const $ = (id) => document.getElementById(id);

  let bl = null;      // 屏蔽配置（本地编辑副本）
  let nav = null;     // 导航配置
  let sys = null;     // 系统设置
  let rt = null;      // 运行时
  let gateMode = 'login';

  // ================= 口令门 =================
  function showGate(mode) {
    gateMode = mode;
    $('main').hidden = true;
    $('gate').hidden = false;
    const setup = mode === 'setup';
    $('gate-title').textContent = setup ? '首次使用 · 设置管理口令' : '教师管理';
    $('gate-sub').textContent = setup
      ? '给绿网设置一个管理口令（至少 4 位），学生将无法进入这个页面。'
      : '请输入管理口令';
    $('gate-pwd2').hidden = !setup;
    $('gate-pwd').value = '';
    $('gate-pwd2').value = '';
    $('gate-err').textContent = '';
    $('gate-ok').textContent = setup ? '设置并进入' : '进入管理';
    setTimeout(() => { try { $('gate-pwd').focus(); } catch (_e) { /* noop */ } }, 40);
  }

  async function submitGate() {
    const pwd = $('gate-pwd').value;
    const err = $('gate-err');
    if (!pwd) { err.textContent = '请输入口令'; return; }
    if (gateMode === 'setup') {
      if (pwd.length < 4) { err.textContent = '口令至少 4 位'; return; }
      if (pwd !== $('gate-pwd2').value) { err.textContent = '两次输入的口令不一样'; return; }
      const r = await api.adminSetup(pwd);
      if (!r || !r.ok) { err.textContent = (r && r.err) || '设置失败'; return; }
      toast('管理口令已设置');
      enter();
      return;
    }
    const r = await api.adminVerify(pwd);
    if (!r || !r.ok) {
      err.textContent = (r && r.err) || '口令错误';
      $('gate-pwd').value = '';
      return;
    }
    log('admin gate passed');
    enter();
  }

  async function enter() {
    $('gate').hidden = true;
    $('main').hidden = false;
    try { rt = (await api.getRuntime()) || null; } catch (_e) { rt = null; }
    if (rt && rt.ok) $('sys-machine').value = rt.machineId || '';
    $('who').textContent = rt && rt.ok ? ('机器 ' + (rt.machineId || '-') + '　Chrome ' + (rt.versions && rt.versions.chrome ? rt.versions.chrome.split('.')[0] : '')) : '';
    await Promise.all([loadBlock(), loadNav(), loadSys()]);
    bindPanes();
  }

  // ================= 屏蔽名单 =================
  const RULE_TYPES = [['domain', '域名'], ['keyword', '关键词'], ['url', '网址前缀'], ['regex', '正则']];

  async function loadBlock() {
    const r = await api.getBlocklist();
    if (!r || !r.ok) { toast('读取屏蔽名单失败', 'warn'); return; }
    bl = r.config;
    renderBlock();
  }

  function renderBlock() {
    $('bl-enabled').checked = !!bl.enabled;
    $('bl-local').checked = bl.alwaysAllowLocal !== false;
    $('bl-mode').value = bl.mode || 'blacklist';
    $('bl-mode-hint').textContent = (bl.mode === 'whitelist')
      ? '当前是【只允许白名单】：除了下方"允许清单"里的站点和本机地址，其它网站一律打不开。规则列表暂不生效，切回黑名单后可继续使用。'
      : '当前是【黑名单】：命中下方任意一条启用的规则就拦截；"允许清单"里的站点始终放行。';

    const box = $('rules');
    box.innerHTML = '';
    (bl.rules || []).forEach((r, i) => {
      const row = el('div', { class: 'rule', 'data-ri': String(i) });
      row.innerHTML = ''
        + '<select data-f="type">' + RULE_TYPES.map(([v, t]) =>
          '<option value="' + v + '"' + (r.type === v ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>'
        + '<input type="text" data-f="value" value="' + esc(r.value) + '" placeholder="要拦的内容" />'
        + '<input type="text" data-f="note" value="' + esc(r.note || '') + '" placeholder="为什么拦（可空）" />'
        + '<label class="switch"><input type="checkbox" data-f="enabled"' + (r.enabled === false ? '' : ' checked') + ' /> 启用</label>'
        + '<button class="btn sm danger" data-act="del" title="删除这条规则">✕</button>';
      box.appendChild(row);
    });

    const allows = $('allows');
    allows.innerHTML = '';
    (bl.allowDomains || []).forEach((d, i) => {
      const t = el('span', { class: 'tag' }, esc(d) + ' <button data-ai="' + i + '" title="移除">✕</button>');
      allows.appendChild(t);
    });
    if (!(bl.allowDomains || []).length) allows.innerHTML = '<span class="muted">还没有例外站点</span>';
  }

  // 把 DOM 上的编辑结果写回 bl（避免"改了没保存就丢"）
  function collectBlock() {
    bl.enabled = $('bl-enabled').checked;
    bl.alwaysAllowLocal = $('bl-local').checked;
    bl.mode = $('bl-mode').value;
    const rows = $('rules').querySelectorAll('.rule[data-ri]');
    const next = [];
    rows.forEach((row) => {
      const i = Number(row.dataset.ri);
      const cur = bl.rules[i] || {};
      const val = row.querySelector('[data-f="value"]').value.trim();
      next.push({
        id: cur.id || ('r-' + Date.now().toString(36) + i),
        type: row.querySelector('[data-f="type"]').value,
        value: val,
        note: row.querySelector('[data-f="note"]').value.trim(),
        enabled: row.querySelector('[data-f="enabled"]').checked,
      });
    });
    bl.rules = next.filter((r) => r.value);
    return bl;
  }

  async function saveBlock(quiet) {
    collectBlock();
    const r = await api.saveBlocklist(Object.assign({}, bl, { by: 'teacher' }));
    if (!r || !r.ok) { toast((r && r.err) || '保存失败', 'err'); return false; }
    bl = r.config;
    renderBlock();
    if (!quiet) toast('屏蔽名单已保存');
    $('bl-saved').textContent = '已保存 ' + new Date().toLocaleTimeString();
    return true;
  }

  // ================= 导航内容 =================
  async function loadNav() {
    const r = await api.getNavConfig();
    if (!r || !r.ok) { toast('读取导航配置失败', 'warn'); return; }
    nav = r.config;
    renderNav();
  }

  function renderNav() {
    $('nav-title').value = nav.title || '';
    $('nav-subtitle').value = nav.subtitle || '';

    // 快捷按钮（动作固定为内置功能，只让老师改名字/图标/说明）
    const q = $('quick-edit');
    q.innerHTML = '';
    (nav.quickActions || []).forEach((a, i) => {
      const row = el('div', { class: 'rule', 'data-qi': String(i), style: 'grid-template-columns:52px 1fr 2fr 96px' });
      row.innerHTML = ''
        + '<input type="text" data-f="icon" value="' + esc(a.icon) + '" />'
        + '<input type="text" data-f="name" value="' + esc(a.name) + '" />'
        + '<input type="text" data-f="desc" value="' + esc(a.desc || '') + '" />'
        + '<span class="muted" style="font-size:12px">' + esc(a.action) + '</span>';
      q.appendChild(row);
    });

    renderGroups();
  }

  function renderGroups() {
    const box = $('groups-edit');
    box.innerHTML = '';
    (nav.groups || []).forEach((g, gi) => {
      const wrap = el('div', { class: 'nav-group', 'data-gi': String(gi) });
      const head = el('div', { class: 'nav-group-head' });
      head.innerHTML = ''
        + '<input type="text" data-f="icon" value="' + esc(g.icon) + '" style="width:52px;flex:none" title="图标（一个 emoji）" />'
        + '<input type="text" data-f="name" value="' + esc(g.name) + '" placeholder="分组名" />'
        + '<input type="text" data-f="color" value="' + esc(g.color) + '" style="width:104px;flex:none" title="颜色" />'
        + '<button class="btn sm" data-act="gup" title="上移">↑</button>'
        + '<button class="btn sm" data-act="gdown" title="下移">↓</button>'
        + '<button class="btn sm danger" data-act="gdel">删除分组</button>';
      wrap.appendChild(head);

      const sitesBox = el('div', { 'data-sites': String(gi) });
      (g.sites || []).forEach((s, si) => {
        const row = el('div', {
          class: 'rule', 'data-si': String(si),
          style: 'grid-template-columns:52px 1.1fr 1.8fr 1.4fr 32px',
        });
        row.innerHTML = ''
          + '<input type="text" data-f="icon" value="' + esc(s.icon) + '" title="图标" />'
          + '<input type="text" data-f="name" value="' + esc(s.name) + '" placeholder="网站名" />'
          + '<input type="text" data-f="url" value="' + esc(s.url) + '" placeholder="https://… 或 internal:siot" />'
          + '<input type="text" data-f="desc" value="' + esc(s.desc || '') + '" placeholder="一句话说明" />'
          + '<button class="btn sm danger" data-act="sdel" title="删除">✕</button>';
        sitesBox.appendChild(row);
      });
      wrap.appendChild(sitesBox);

      const addBtn = el('button', { class: 'btn sm', 'data-act': 'sadd' }, '+ 添加网站');
      wrap.appendChild(addBtn);
      box.appendChild(wrap);
    });
    if (!(nav.groups || []).length) box.innerHTML = '<p class="muted">还没有分组，点下面的按钮添加一个。</p>';
  }

  function collectNav() {
    nav.title = $('nav-title').value.trim();
    nav.subtitle = $('nav-subtitle').value.trim();

    $('quick-edit').querySelectorAll('.rule[data-qi]').forEach((row) => {
      const i = Number(row.dataset.qi);
      if (!nav.quickActions[i]) return;
      nav.quickActions[i].icon = row.querySelector('[data-f="icon"]').value.trim() || '⚡';
      nav.quickActions[i].name = row.querySelector('[data-f="name"]').value.trim() || '快捷操作';
      nav.quickActions[i].desc = row.querySelector('[data-f="desc"]').value.trim();
    });

    $('groups-edit').querySelectorAll('.nav-group[data-gi]').forEach((wrap) => {
      const gi = Number(wrap.dataset.gi);
      const g = nav.groups[gi];
      if (!g) return;
      const head = wrap.querySelector('.nav-group-head');
      g.icon = head.querySelector('[data-f="icon"]').value.trim() || '📁';
      g.name = head.querySelector('[data-f="name"]').value.trim() || ('分组 ' + (gi + 1));
      g.color = head.querySelector('[data-f="color"]').value.trim() || '#16a34a';
      const sites = [];
      wrap.querySelectorAll('[data-si]').forEach((row) => {
        const si = Number(row.dataset.si);
        const cur = (g.sites || [])[si] || {};
        const url = row.querySelector('[data-f="url"]').value.trim();
        sites.push({
          id: cur.id,
          icon: row.querySelector('[data-f="icon"]').value.trim() || '🔗',
          name: row.querySelector('[data-f="name"]').value.trim() || '未命名',
          url,
          desc: row.querySelector('[data-f="desc"]').value.trim(),
          color: cur.color || '#16a34a',
        });
      });
      g.sites = sites.filter((s) => s.url);
    });
    return nav;
  }

  async function saveNav() {
    collectNav();
    const r = await api.saveNavConfig(nav, 'teacher');
    if (!r || !r.ok) { toast((r && r.err) || '保存失败', 'err'); return; }
    nav = r.config;
    renderNav();
    toast('导航内容已保存');
    $('nav-saved').textContent = '已保存 ' + new Date().toLocaleTimeString();
  }

  // ================= 系统设置 =================
  async function loadSys() {
    const r = await api.getSettings();
    if (!r || !r.ok) { toast('读取系统设置失败', 'warn'); return; }
    sys = r.settings;
    renderSys();
  }

  function renderSys() {
    const s = sys.siot || {};
    const q = sys.qy || {};
    $('sys-seat').value = sys.seat || '';
    $('sys-name').value = sys.name || '';
    $('sys-siot-host').value = s.host || '';
    $('sys-siot-mqtt').value = s.mqttPort || 1883;
    $('sys-siot-http').value = s.httpPort || 8080;
    $('sys-siot-ws').value = s.wsPort || 1888;

    $('qy-enabled').checked = !!q.enabled;
    $('qy-lock').checked = q.lockOnPolicy !== false;
    $('qy-close').checked = !!q.closeOnEnd;
    $('qy-hb').checked = !!q.reportHeartbeat;
    $('qy-host').value = q.host || '';
    $('qy-port').value = q.port || 1883;
    $('qy-user').value = q.username || '';
    $('qy-pass').value = q.password || '';
    $('qy-prefix').value = q.projectPrefix || 'ICTClass';
    $('qy-hbsec').value = q.heartbeatSec || 15;

    $('sys-home').value = /^internal:/i.test(sys.homeUrl || '') ? '' : (sys.homeUrl || '');
    $('sys-maxtabs').value = sys.maxTabs || 8;
    $('sys-download').checked = !!sys.allowDownload;
    $('sys-devtools').checked = !!sys.allowDevTools;

    const proxy = sys.proxy || {};
    $('proxy-mode').value = ['auto', 'manual', 'off'].includes(proxy.mode) ? proxy.mode : 'auto';
    $('proxy-server').value = proxy.server || '';
    $('proxy-bypass').value = proxy.bypass || '<local>';
    toggleProxyServer();
  }

  // 仅在「手动指定」模式显示代理地址输入框
  function toggleProxyServer() {
    const wrap = $('proxy-server-wrap');
    if (!wrap) return;
    wrap.style.display = $('proxy-mode').value === 'manual' ? '' : 'none';
  }

  async function saveSys() {
    const patch = {
      seat: $('sys-seat').value.trim(),
      name: $('sys-name').value.trim(),
      siot: {
        host: $('sys-siot-host').value.trim(),
        mqttPort: Number($('sys-siot-mqtt').value),
        httpPort: Number($('sys-siot-http').value),
        wsPort: Number($('sys-siot-ws').value),
      },
      qy: {
        enabled: $('qy-enabled').checked,
        lockOnPolicy: $('qy-lock').checked,
        closeOnEnd: $('qy-close').checked,
        reportHeartbeat: $('qy-hb').checked,
        host: $('qy-host').value.trim(),
        port: Number($('qy-port').value),
        username: $('qy-user').value.trim(),
        password: $('qy-pass').value,
        projectPrefix: $('qy-prefix').value.trim(),
        heartbeatSec: Number($('qy-hbsec').value),
      },
      maxTabs: Number($('sys-maxtabs').value),
      allowDownload: $('sys-download').checked,
      allowDevTools: $('sys-devtools').checked,
      proxy: {
        mode: $('proxy-mode').value,
        server: $('proxy-server').value.trim(),
        bypass: $('proxy-bypass').value.trim(),
      },
    };
    const home = $('sys-home').value.trim();
    if (home) patch.homeUrl = home;
    else if (rt && rt.ok && /^internal:/i.test(rt.homeUrl || '')) patch.homeUrl = 'internal:home';
    else patch.homeUrl = 'internal:home';

    const r = await api.saveSettings(patch);
    if (!r || !r.ok) { toast((r && r.err) || '保存失败', 'err'); return; }
    const proxyTouched = patch.proxy && (patch.proxy.mode !== 'auto' || patch.proxy.server);
    toast(proxyTouched ? '系统设置已保存（代理改动需重启绿网后生效）' : '系统设置已保存');
    $('sys-saved').textContent = '已保存 ' + new Date().toLocaleTimeString();
    await loadSys();
    await refreshQyLine();
  }

  async function refreshQyLine() {
    try {
      const r = await api.getQy();
      if (!r || !r.ok) return;
      const q = r.qy;
      const names = { online: '已连接', connecting: '连接中', backoff: '重连中', off: '未启用', 'no-mqtt': '缺少 mqtt 依赖', error: '连接异常' };
      $('qy-state-line').textContent = '当前状态：' + (names[q.state] || q.state)
        + '　|　broker ' + q.brokerUrl + '　|　clientId ' + q.clientId
        + (q.seat ? '' : '　|　⚠ 未设置座位号，心跳不会上报');
    } catch (_e) { /* noop */ }
  }

  // ================= 事件绑定 =================
  let panesBound = false;
  function bindPanes() {
    if (panesBound) return;
    panesBound = true;

    document.querySelectorAll('.tabs-nav button').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('.tabs-nav button').forEach((x) => x.classList.toggle('active', x === b));
        ['pane-block', 'pane-nav', 'pane-sys'].forEach((id) => { $(id).hidden = id !== b.dataset.pane; });
        if (b.dataset.pane === 'pane-sys') refreshQyLine();
      };
    });

    $('btn-home').onclick = () => api.openInternal('home');
    $('btn-lock').onclick = async () => {
      const r = await api.getLock();
      const next = !(r && r.locked);
      await api.setLock(next);
      toast(next ? '已临时锁定浏览器（学生无法上网）' : '已解除锁定');
    };

    // ---- 屏蔽：规则增删 ----
    $('btn-add-rule').onclick = () => {
      collectBlock();
      bl.rules.push({ type: 'domain', value: '', note: '', enabled: true });
      renderBlock();
    };
    $('rules').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act="del"]');
      if (!btn) return;
      collectBlock();
      bl.rules.splice(Number(btn.closest('.rule').dataset.ri), 1);
      renderBlock();
    });
    $('allows').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-ai]');
      if (!btn) return;
      collectBlock();
      bl.allowDomains.splice(Number(btn.dataset.ai), 1);
      renderBlock();
    });
    const addAllow = () => {
      const v = $('allow-input').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!v) return;
      collectBlock();
      if (!bl.allowDomains.includes(v)) bl.allowDomains.push(v);
      $('allow-input').value = '';
      renderBlock();
    };
    $('btn-add-allow').onclick = addAllow;
    $('allow-input').onkeydown = (e) => { if (e.key === 'Enter') addAllow(); };
    $('bl-mode').onchange = () => { collectBlock(); renderBlock(); };

    $('btn-test').onclick = async () => {
      const v = $('test-url').value.trim();
      if (!v) { toast('先填一个网址', 'warn'); return; }
      // 先按当前编辑内容落盘，再用主进程的判定引擎试算 —— 保证"所见即所得"
      const ok = await saveBlock(true);
      if (!ok) return;
      const r = await api.checkUrl(v);
      const res = r && r.result;
      const box = $('test-result');
      box.style.display = 'flex';
      box.className = 'state ' + (res && res.blocked ? 'err' : 'ok');
      $('test-text').textContent = res
        ? (res.blocked ? '会被拦截　·　' : '可以访问　·　') + res.message
        : '判定失败';
    };

    $('btn-save-block').onclick = () => saveBlock(false);

    // ---- 导航内容 ----
    $('btn-add-group').onclick = () => {
      collectNav();
      nav.groups.push({ icon: '📁', name: '新分组', color: '#16a34a', sites: [] });
      renderGroups();
    };
    $('groups-edit').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const wrap = btn.closest('.nav-group');
      const gi = Number(wrap.dataset.gi);
      collectNav();
      if (act === 'gdel') {
        if (!confirm('确定删除分组「' + (nav.groups[gi] || {}).name + '」及其中的网站吗？')) return;
        nav.groups.splice(gi, 1);
      } else if (act === 'gup' && gi > 0) {
        const t = nav.groups[gi - 1]; nav.groups[gi - 1] = nav.groups[gi]; nav.groups[gi] = t;
      } else if (act === 'gdown' && gi < nav.groups.length - 1) {
        const t = nav.groups[gi + 1]; nav.groups[gi + 1] = nav.groups[gi]; nav.groups[gi] = t;
      } else if (act === 'sadd') {
        nav.groups[gi].sites = nav.groups[gi].sites || [];
        nav.groups[gi].sites.push({ icon: '🔗', name: '', url: '', desc: '' });
      } else if (act === 'sdel') {
        const si = Number(btn.closest('[data-si]').dataset.si);
        nav.groups[gi].sites.splice(si, 1);
      }
      renderGroups();
    });
    $('btn-save-nav').onclick = saveNav;
    $('btn-reset-nav').onclick = async () => {
      if (!confirm('恢复为出厂默认导航内容？当前编辑的内容会丢失。')) return;
      const r = await api.resetNavConfig();
      if (r && r.ok) { nav = r.config; renderNav(); toast('已恢复默认导航内容'); }
      else toast((r && r.err) || '恢复失败', 'err');
    };

    // ---- 系统设置 ----
  $('btn-save-sys').onclick = saveSys;
  $('btn-qy-test').onclick = refreshQyLine;
  if ($('proxy-mode')) $('proxy-mode').addEventListener('change', toggleProxyServer);
    $('btn-change-pwd').onclick = async () => {
      const oldPwd = $('pwd-old').value;
      const newPwd = $('pwd-new').value;
      if (!newPwd || newPwd.length < 4) { toast('新口令至少 4 位', 'warn'); return; }
      const r = await api.adminChange(oldPwd, newPwd);
      if (r && r.ok) { toast('管理口令已修改'); $('pwd-old').value = ''; $('pwd-new').value = ''; }
      else toast((r && r.err) || '修改失败', 'err');
    };

    // ---- 口令门 ----
    $('gate-ok').onclick = submitGate;
    $('gate-cancel').onclick = () => api.openInternal('home');
    const keyHandler = (e) => { if (e.key === 'Enter') submitGate(); };
    $('gate-pwd').onkeydown = keyHandler;
    $('gate-pwd2').onkeydown = keyHandler;
  }

  // ================= 启动 =================
  async function boot() {
    bindPanes();
    let st = null;
    try { st = await api.adminState(); } catch (_e) { st = null; }
    if (st && st.ok && st.initialized === false) {
      showGate('setup');
    } else if (st && st.ok && st.locked) {
      showGate('login');
      $('gate-err').textContent = '尝试次数过多，请稍后再试';
    } else {
      showGate('login');
    }
    log('admin ready, initialized=' + (st && st.initialized));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
