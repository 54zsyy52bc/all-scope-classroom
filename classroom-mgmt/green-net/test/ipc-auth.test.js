'use strict';
const { suite, test, eq, assert } = require('./harness');
const { senderInfo, authorize, READ_HOSTS, WRITE_HOSTS } = require('../src/main/trust');

function ev(url) {
  return { senderFrame: { url } };
}

suite('trust · 发送方识别', () => {
  test('识别 gnet 内置页并取 host', () => {
    const i = senderInfo(ev('gnet://admin/'));
    eq(i.host, 'admin');
    eq(i.kind, 'internal');
    eq(i.isShell, false);
  });
  test('识别本机外壳（file://）', () => {
    const i = senderInfo(ev('file:///C:/app/src/renderer/chrome.html'));
    eq(i.isShell, true);
    eq(i.kind, 'shell');
  });
  test('识别外网网页', () => {
    const i = senderInfo(ev('https://www.douyin.com/'));
    eq(i.kind, 'web');
    eq(i.isShell, false);
  });
  test('异常输入不抛错', () => {
    const i = senderInfo(null);
    eq(i.kind, 'unknown');
    assert(authorize('read', i).ok === false, '未知来源必须被拒绝');
  });
});

suite('trust · 授权分级', () => {
  test('外壳：读写都放行', () => {
    const shell = senderInfo(ev('file:///x/chrome.html'));
    eq(authorize('read', shell).ok, true);
    eq(authorize('write', shell).ok, true);
  });
  test('内置页读到放行、写到受限', () => {
    const home = senderInfo(ev('gnet://home/'));
    eq(authorize('read', home).ok, true, '首页可以读（要渲染导航配置）');
    eq(authorize('write', home).ok, false, '首页不能改配置');

    const admin = senderInfo(ev('gnet://admin/'));
    eq(authorize('read', admin).ok, true);
    eq(authorize('write', admin).ok, true, '只有教师管理页可以写');
  });
  test('★ 外网网页：读写全部拒绝（这是最关键的一条）', () => {
    const web = senderInfo(ev('https://evil.example.com/x'));
    eq(authorize('read', web).ok, false);
    eq(authorize('write', web).ok, false);
    eq(authorize('write', web).code, 'E-PERM-WRITE');
  });
  test('未知 gnet host 不被信任', () => {
    const bogus = senderInfo(ev('gnet://hacker/'));
    eq(authorize('read', bogus).ok, false);
    eq(authorize('write', bogus).ok, false);
  });
  test('名单常量与文档一致', () => {
    eq(WRITE_HOSTS.join(','), 'admin');
    assert(READ_HOSTS.includes('home') && READ_HOSTS.includes('ip') && READ_HOSTS.includes('siot'), '关键内置页必须可读');
  });
});
