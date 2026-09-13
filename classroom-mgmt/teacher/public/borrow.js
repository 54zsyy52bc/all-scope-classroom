'use strict';
// =============================================================================
// 大屏 · 器材补登借用（L1 闭环）
//
// 场景：学生端归还阶段空态提示「器材不见了？请联系老师补登」。
//   成因通常是老师口头发了器材、但系统里没有这条借出记录，于是学生端
//   归还页显示为空、也没法点"已归还"，整组卡在"未归还"上。
//   老师在这里补一条借出记录，学生端的归还清单立刻就能正常显示。
//
// 依赖由 app.js 在 bind 时注入（$ / esc / api / logEvent / refreshSoon / withGuard）。
// 对应的后端接口：POST /api/v1/sessions/:sessionId/borrows（见 src/routes/equipment.js）
// =============================================================================
(function (global) {
  let d = null;
  let sessionId = '';
  let equipLoaded = false;

  function el(id) { return d.$ ? d.$ (id) : document.getElementById(id); }

  function setError(msg) {
    const box = el('bf-error');
    if (!box) return;
    box.hidden = !msg;
    box.textContent = msg || '';
  }

  async function open() {
    setError('');
    el('bf-seat').value = '';
    el('bf-qty').value = '1';
    // 会话号现场拉取，避免与 app.js 的快照渲染路径耦合（无需在 applySnapshot 里挂钩子）
    if (!sessionId) {
      const j = await d.api('GET', '/api/v1/dashboard/snapshot');
      const sess = j && j.code === 0 && j.data ? j.data.session : null;
      sessionId = (sess && (sess.sessionId || sess.session_id)) || '';
    }
    if (!sessionId) { d.toast('尚未开始上课，无法补登借用', true); return; }
    loadEquipment();
    el('overlay-borrow').hidden = false;
    setTimeout(() => el('bf-seat').focus(), 30);
  }

  function close() {
    const ov = el('overlay-borrow');
    if (ov) ov.hidden = true;
  }

  // 器材下拉：懒加载一次；失败时给出可操作的中文提示而不是空白
  async function loadEquipment() {
    const sel = el('bf-eq');
    if (!sel) return;
    if (equipLoaded) { sel.selectedIndex = 0; return; }
    sel.innerHTML = '<option value="">（加载中…）</option>';
    const j = await d.api('GET', '/api/v1/equipment');
    if (!j || j.code !== 0 || !Array.isArray(j.data)) {
      sel.innerHTML = '<option value="">（器材台账读取失败，请刷新页面）</option>';
      return;
    }
    if (!j.data.length) {
      sel.innerHTML = '<option value="">（暂无器材：请先在预设编辑器里配置器材清单）</option>';
      return;
    }
    sel.innerHTML = ['<option value="">请选择器材</option>']
      .concat(j.data.map((e) => '<option value="' + d.esc(e.eq_id || e.eqId) + '">'
        + d.esc(e.eq_name || e.eqId || e.eq_id) + '</option>'))
      .join('');
    equipLoaded = true;
  }

  async function submit() {
    setError('');
    const seat = el('bf-seat').value;
    const eqId = el('bf-eq').value;
    const qty = el('bf-qty').value;
    // 前端就地校验：与后端规则一致，避免"点一下才报错"的来回
    const n = parseInt(seat, 10);
    if (!Number.isFinite(n) || n < 1 || n > 99) { setError('座位号请填 1~99 之间的整数'); el('bf-seat').focus(); return; }
    if (!eqId) { setError('请选择要补登的器材'); el('bf-eq').focus(); return; }
    const q = parseInt(qty, 10);
    if (!Number.isFinite(q) || q < 1 || q > 99) { setError('数量请填 1~99 之间的整数'); el('bf-qty').focus(); return; }

    const j = await d.api('POST', '/api/v1/sessions/' + sessionId + '/borrows', { seat: n, eqId, qty: q });
    if (!j || j.code !== 0) {
      const f = global.ErrorFmt && global.ErrorFmt.format(j);
      setError((f && f.title + (f.hint ? ' · ' + f.hint : '')) || '补登失败，请稍后重试');
      return;
    }
    d.logEvent((j.data && j.data.message) || ('已补登 ' + n + ' 号借用'));
    close();
    d.refreshSoon();
  }

  function init(deps) {
    d = deps || {};
    const btn = el('btn-borrow');
    if (btn) btn.onclick = () => d.withGuard('borrow', async () => { await open(); })();
    const sub = el('bf-submit');
    if (sub) sub.onclick = () => d.withGuard('borrow-submit', submit)();
    const ov = el('overlay-borrow');
    if (ov) ov.onclick = (e) => { if (e.target === ov) close(); };
    ['bf-seat', 'bf-eq', 'bf-qty'].forEach((id) => {
      const i = el(id);
      if (i) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); d.withGuard('borrow-submit', submit)(); } });
    });
    // Esc = 取消（与 dialog.js / 其它弹窗一致，保证键盘可达性）
    document.addEventListener('keydown', (e) => {
      const box = el('overlay-borrow');
      if (e.key === 'Escape' && box && !box.hidden) close();
    });
  }

  // 开课时快照会带 sessionId；也保留显式设置入口，便于测试与后续复用
  function setSession(s) {
    sessionId = (s && (s.sessionId || s.session_id)) || '';
  }

  global.DashboardBorrow = { init, setSession };
})(typeof window !== 'undefined' ? window : globalThis);