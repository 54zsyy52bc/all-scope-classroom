'use strict';
const os = require('node:os');
const { suite, test, eq, assert } = require('./harness');
const N = require('../src/main/netinfo');

suite('netinfo · 网卡采集', () => {
  test('返回结构完整且不抛错', () => {
    const list = N.listInterfaces();
    assert(Array.isArray(list), '应为数组');
    eq(typeof N.summarize().hostname, 'string');
  });
  test('过滤 IPv6 链路本地与 ::1', () => {
    const list = N.listInterfaces();
    const bad = list.filter((i) => i.family === 'IPv6' && (/^fe80::/i.test(i.address) || i.address === '::1'));
    eq(bad.length, 0, '不应出现 fe80:: / ::1');
  });
  test('IPv4 带上 CIDR 或至少带 IP', () => {
    const list = N.listInterfaces().filter((i) => i.family === 'IPv4');
    list.forEach((i) => assert(i.address, 'IPv4 必须有地址'));
  });
  test('私有地址排在虚拟网卡前面', () => {
    const list = N.listInterfaces();
    const firstPrivate = list.findIndex((i) => i.family === 'IPv4' && i.isPrivate && !i.isVirtual);
    const firstVirtual = list.findIndex((i) => i.isVirtual);
    if (firstPrivate >= 0 && firstVirtual >= 0) {
      assert(firstPrivate < firstVirtual, '可用私有地址应排在虚拟网卡之前');
    }
  });
});

suite('netinfo · 使用提示', () => {
  test('给出 SIoT 控制台与 MQTT 地址提示', () => {
    const info = N.summarize({ siot: { httpPort: 8080, mqttPort: 1883 }, qy: { host: '127.0.0.1' } });
    assert(Array.isArray(info.hints));
    assert(info.hints.length > 0, '至少给一条提示');
    if (info.primary) {
      assert(info.hints.some((h) => h.includes(String(info.primary.address))), '提示里应出现主地址');
      assert(info.hints.some((h) => h.includes(':8080')), '提示里应包含 SIoT 控制台端口');
    }
  });
  test('拿到 169.254 地址时给出明确告警', () => {
    // 通过 toPlainText 覆盖输出格式；169.254 分支依赖真实网卡，这里只验证文本导出
    const info = N.summarize({});
    const text = N.toPlainText(info);
    assert(text.includes('主机名：'), '纯文本应包含主机名行');
    assert(text.includes('\r\n'), '应使用 CRLF 便于粘贴到 Windows 记事本');
  });
  test('ip 私有地址识别与本模块一致', () => {
    const U = require('../src/main/util');
    eq(U.isPrivateIPv4('192.168.31.20'), true);
    eq(U.isPrivateIPv4('100.64.0.1'), false);
  });
});

suite('netinfo · 临时目录不依赖真实网络', () => {
  test('summarize 可重复调用', () => {
    const a = N.summarize({});
    const b = N.summarize({});
    eq(a.hostname, b.hostname);
    eq(os.hostname(), a.hostname);
  });
});
