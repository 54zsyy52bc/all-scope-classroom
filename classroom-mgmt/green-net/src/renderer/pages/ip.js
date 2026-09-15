'use strict';
// 本机 IP 页：主地址大号展示 + 一键复制 + 全部网卡明细
(function () {
  const { api, esc, el, toast, copy, log } = window.GN;
  let info = null;

  function plainText() {
    if (!info) return '';
    const lines = ['主机名：' + info.hostname, '系统：' + info.platform, ''];
    (info.interfaces || []).forEach((i) => {
      lines.push(`${i.name}  [${i.family}]  ${i.address}${i.cidr ? '  (' + i.cidr + ')' : ''}${i.mac ? '  ' + i.mac : ''}`);
    });
    if (info.hints && info.hints.length) {
      lines.push('', '使用提示：');
      info.hints.forEach((h) => lines.push('- ' + h));
    }
    return lines.join('\r\n');
  }

  function render() {
    if (!info) return;
    const p = info.primary;
    const ipEl = document.getElementById('primary-ip');
    const lblEl = document.getElementById('primary-lbl');
    if (p) {
      ipEl.textContent = p.address;
      lblEl.textContent = p.name + '　·　' + (p.isPrivate ? '局域网地址（推荐）' : '非局域网地址');
    } else {
      ipEl.textContent = '未检测到';
      lblEl.textContent = '没有可用网卡';
    }

    const hints = document.getElementById('hints');
    hints.innerHTML = '';
    (info.hints || []).forEach((h) => {
      const li = el('li', {}, esc(h).replace(/(\d+\.\d+\.\d+\.\d+)/g, '<code>$1</code>'));
      hints.appendChild(li);
    });

    const tb = document.getElementById('ifaces');
    tb.innerHTML = '';
    const list = info.interfaces || [];
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="6" class="muted">没有检测到网络接口</td></tr>';
      return;
    }
    list.forEach((i) => {
      const note = i.internal ? '系统内部' : (i.isVirtual ? '虚拟网卡（一般不用）' : (i.isPrivate ? '可用' : '公网/其它'));
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(i.name) + '</td>'
        + '<td>' + esc(i.family) + '</td>'
        + '<td class="mono">' + esc(i.address) + '</td>'
        + '<td class="mono">' + esc(i.cidr || '-') + '</td>'
        + '<td class="mono">' + esc(i.mac || '-') + '</td>'
        + '<td class="muted">' + esc(note) + '</td>';
      tb.appendChild(tr);
    });
  }

  async function load() {
    try {
      const r = await api.getNetInfo();
      if (r && r.ok) { info = r.info; render(); }
      else toast((r && r.err) || '读取网卡信息失败', 'warn');
    } catch (e) { toast('读取网卡信息失败', 'warn'); log('getNetInfo 异常：' + (e && e.message)); }
  }

  function bind() {
    document.getElementById('btn-refresh').onclick = load;
    document.getElementById('btn-copy').onclick = () => copy(plainText());
    document.getElementById('btn-copy-ip').onclick = () => {
      if (info && info.primary) return copy(info.primary.address);
      toast('还没有检测到可用地址', 'warn');
      return undefined;
    };
  }

  window.addEventListener('DOMContentLoaded', () => { bind(); load(); });
})();
