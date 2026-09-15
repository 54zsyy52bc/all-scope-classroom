'use strict';
const { suite, test, eq, assert } = require('./harness');
const U = require('../src/main/util');

suite('util · 输入净化', () => {
  test('str 去空格并截断', () => {
    eq(U.str('  abc  ', 10), 'abc');
    eq(U.str('abcdef', 3), 'abc');
    eq(U.str(null, 5), '');
  });
  test('int 夹取范围', () => {
    eq(U.int('200', 1883, 1, 65535), 200);
    eq(U.int('-5', 10, 1, 65535), 1);
    eq(U.int('abc', 10, 1, 65535), 10);
    eq(U.int('1e9', 10, 1, 65535), 65535);
  });
  test('bool 支持字符串真值', () => {
    eq(U.bool('true', false), true);
    eq(U.bool('0', true), false);
    eq(U.bool(undefined, true), true);
  });
  test('pick 只保留白名单键', () => {
    const r = U.pick({ a: 1, b: 2, __proto__: 3 }, ['a']);
    eq(Object.keys(r).length, 1);
    eq(r.a, 1);
  });
});

suite('util · URL 处理', () => {
  test('补协议并识别 http/https', () => {
    eq(U.normalizeUrl('mindplus.cc').url, 'https://mindplus.cc/');
    eq(U.normalizeUrl('http://a.com/x').ok, true);
  });
  test('拒绝危险协议', () => {
    eq(U.normalizeUrl('file:///C:/Windows').ok, false);
    eq(U.normalizeUrl('javascript:alert(1)').ok, false);
    eq(U.normalizeUrl('data:text/html,<h1>x</h1>').ok, false);
  });
  test('internal: 原样通过（由调用方决定是否放行）', () => {
    const r = U.normalizeUrl('internal:ip');
    eq(r.ok, true);
    eq(r.url, 'internal:ip');
    eq(U.internalAction('internal:siot'), 'siot');
  });
  test('hostOfUrl / isLocalHost', () => {
    eq(U.hostOfUrl('https://WWW.Foo.com/a'), 'www.foo.com');
    eq(U.isLocalHost('127.0.0.1'), true);
    eq(U.isLocalHost('192.168.1.5'), false);
  });
  test('私有地址判定', () => {
    eq(U.isPrivateIPv4('192.168.1.5'), true);
    eq(U.isPrivateIPv4('10.0.0.7'), true);
    eq(U.isPrivateIPv4('172.20.3.4'), true);
    eq(U.isPrivateIPv4('172.32.3.4'), false);
    eq(U.isPrivateIPv4('8.8.8.8'), false);
  });
});

suite('util · 原子写', () => {
  test('writeJsonAtomic 后 readJsonSafe 能读回', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnet-'));
    const f = path.join(dir, 'x.json');
    U.writeJsonAtomic(f, { a: 1, 中文: '值' });
    const back = U.readJsonSafe(f, null);
    eq(back.a, 1);
    eq(back['中文'], '值');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('损坏文件返回 fallback 而不是抛错', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnet-'));
    const f = path.join(dir, 'bad.json');
    fs.writeFileSync(f, '{ 不是合法 JSON');
    eq(U.readJsonSafe(f, 'fallback'), 'fallback');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
