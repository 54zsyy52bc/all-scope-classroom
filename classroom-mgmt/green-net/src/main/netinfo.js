'use strict';
// =============================================================================
// 本机 IP 查询（一键查看本机 IP 的落地实现）
//
// 学生实际要用的是「设备/行空板/掌控板应该填哪个地址」——所以不只是罗列网卡，
// 还要把私有局域网地址排到最前，并直接给出 SIoT 控制台 / MQTT 的完整地址。
// =============================================================================
const os = require('node:os');
const U = require('./util');

// 虚拟网卡 / 常见无关适配器：识别出来只为标注，不在筛选时静默丢弃
const VIRTUAL_HINTS = [
  'vmware', 'virtualbox', 'vethernet', 'hyper-v', 'loopback',
  'bluetooth', 'tap', 'tun', 'npcap', 'wsl', 'docker', 'radmin', 'zerotier',
];

function isVirtual(name) {
  const n = String(name || '').toLowerCase();
  return VIRTUAL_HINTS.some((h) => n.includes(h));
}

function cidrOf(address, netmask) {
  if (!netmask || !U.isIPv4(address)) return '';
  const bits = netmask.split('.').reduce((a, o) => a + (Number(o) >>> 0).toString(2).split('1').length - 1, 0);
  return `${address}/${bits}`;
}

// 排序权重：可信的私有 IPv4 优先 → 其它 IPv4 → IPv6；虚拟网卡整体降级
function rank(it) {
  let r = 100;
  if (it.family === 'IPv4') r = U.isPrivateIPv4(it.address) ? 0 : 20;
  else r = 60;
  if (it.name === '以太网' || /ethernet|以太网/i.test(it.name)) r -= 2;
  if (/wi-?fi|wlan|无线/i.test(it.name)) r -= 1;
  if (it.isVirtual) r += 40;
  return r;
}

function listInterfaces() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifaces)) {
    for (const it of ifaces[name] || []) {
      const family = it.family === 4 || it.family === 'IPv4' ? 'IPv4'
        : it.family === 6 || it.family === 'IPv6' ? 'IPv6' : String(it.family);
      const address = String(it.address || '');
      if (family === 'IPv6' && /^fe80::/i.test(address)) continue; // 链路本地地址对课堂无意义
      if (family === 'IPv6' && /^::1$/.test(address)) continue;
      out.push({
        name,
        family,
        address,
        netmask: String(it.netmask || ''),
        cidr: family === 'IPv4' ? cidrOf(address, it.netmask) : `${address}/64`,
        mac: String(it.mac || ''),
        internal: !!it.internal,
        isPrivate: family === 'IPv4' ? U.isPrivateIPv4(address) : /^f[cd]/i.test(address),
        isVirtual: isVirtual(name),
      });
    }
  }
  out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.family.localeCompare(b.family));
  return out;
}

function summarize(opts) {
  const o = opts || {};
  const siot = o.siot || {};
  const qy = o.qy || {};
  const all = listInterfaces();
  const usable = all.filter((i) => !i.internal && !i.isVirtual);
  const primary = usable.find((i) => i.family === 'IPv4' && i.isPrivate)
    || usable.find((i) => i.family === 'IPv4')
    || usable[0]
    || null;

  const httpPort = U.int(siot.httpPort, 8080, 1, 65535);
  const mqttPort = U.int(siot.mqttPort, 1883, 1, 65535);

  const hints = [];
  if (primary) {
    hints.push(`设备（行空板 / 掌控板）里的「服务器地址」填：${primary.address}`);
    hints.push(`SIoT 控制台： http://${primary.address}:${httpPort}`);
    hints.push(`MQTT 服务端口： ${primary.address}:${mqttPort}`);
    if (qy.host && qy.host !== '127.0.0.1' && qy.host !== primary.address) {
      hints.push(`全域对接当前指向：${qy.host}（若课堂收不到指令，请核对此项）`);
    }
  } else {
    hints.push('未检测到可用的局域网网卡，请检查网线 / Wi-Fi 是否连接');
  }
  if (primary && /^169\.254\./.test(primary.address)) {
    hints.push('当前是自动分配地址（169.254.x.x），说明没有拿到路由器分配的 IP，请重新插拔网线');
  }

  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    primary,
    interfaces: all,
    hints,
    collectedAt: Date.now(),
  };
}

// 纯文本导出（给"复制"按钮用）
function toPlainText(info) {
  const lines = [
    `主机名：${info.hostname}`,
    `系统：${info.platform}`,
    '',
  ];
  for (const i of info.interfaces) {
    lines.push(`${i.name}  [${i.family}]  ${i.address}${i.cidr ? '  (' + i.cidr + ')' : ''}${i.mac ? '  ' + i.mac : ''}`);
  }
  lines.push('', '使用提示：');
  for (const h of info.hints) lines.push('- ' + h);
  return lines.join('\r\n');
}

module.exports = { listInterfaces, summarize, toPlainText, isVirtual };
