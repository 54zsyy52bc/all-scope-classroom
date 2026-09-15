'use strict';
// SIoT 控制台引导页：先探活（TCP 1883 + HTTP 8080），在跑就直接一键进控制台；
// 没跑就给可执行的启动步骤，并保留"仍然尝试打开"的出口（老师知道自己在干什么时用）。
(function () {
  const { api, esc, el, toast, log } = window.GN;
  const DEFAULT_GUIDE = [
    '找到 SIoT 文件夹（通常在桌面或 D 盘，名字类似 SIoT_V2_Win_2618）。',
    '双击里面的 start SIoT.bat 启动服务（不要直接双击 main.exe）。',
    'Windows 弹出网络提示时，把「专用网络」「公用网络」都勾上再点允许。',
    '回到绿网，点上面的「重新检测」，看到绿色就说明服务起来了。',
  ];

  let last = null;

  function paint() {
    const box = document.getElementById('status');
    const txt = document.getElementById('status-text');
    const openBtn = document.getElementById('btn-open');
    const urlLine = document.getElementById('url-line');

    if (!last) {
      box.className = 'state info';
      txt.textContent = '正在检测本机 SIoT 服务…';
      return;
    }
    urlLine.textContent = '控制台地址：' + last.consoleUrl;
    if (last.running) {
      box.className = 'state ok';
      txt.textContent = last.hint;
      openBtn.disabled = false;
      document.getElementById('guide-card').hidden = true;
    } else {
      box.className = 'state warn';
      txt.textContent = last.hint;
      openBtn.disabled = true;
      document.getElementById('guide-card').hidden = false;
    }

    const d = document.getElementById('detail');
    d.innerHTML = ''
      + '<dt>MQTT 端口</dt><dd class="mono">' + esc(last.host + ':' + last.mqttPort)
      + (last.mqtt.ok ? '　✅ 已监听（' + last.mqtt.ms + 'ms）' : '　❌ ' + esc(last.mqtt.err || '未响应')) + '</dd>'
      + '<dt>网页端口</dt><dd class="mono">' + esc(last.host + ':' + last.httpPort)
      + (last.http.ok ? '　✅ HTTP ' + last.http.status + '（' + last.http.ms + 'ms）' : '　❌ ' + esc(last.http.err || '未响应')) + '</dd>';

    const g = document.getElementById('guide');
    g.innerHTML = '';
    (last.guidance && last.guidance.length ? last.guidance : DEFAULT_GUIDE).forEach((s) => {
      g.appendChild(el('li', {}, esc(s).replace(/([A-Za-z0-9_\-]+\.bat)/g, '<code>$1</code>')));
    });
  }

  async function probe() {
    try {
      const r = await api.probeSiot();
      if (r && r.result) { last = r.result; paint(); }
      else toast((r && r.err) || '检测失败', 'warn');
    } catch (e) { toast('检测失败', 'warn'); log('probeSiot 异常：' + (e && e.message)); }
  }

  function bind() {
    document.getElementById('btn-recheck').onclick = probe;
    document.getElementById('btn-open').onclick = async () => {
      await api.openSiotConsole(true);
    };
    document.getElementById('btn-force').onclick = async () => {
      const r = await api.openSiotConsole(true);
      if (r && r.opened) toast('已尝试打开，如果页面打不开说明服务还没启动');
    };
  }

  window.addEventListener('DOMContentLoaded', () => { bind(); probe(); });
})();
