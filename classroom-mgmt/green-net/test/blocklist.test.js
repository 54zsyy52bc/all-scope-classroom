'use strict';
const { suite, test, eq, assert } = require('./harness');
const B = require('../src/main/blocklist');

function engine(raw) { return B.compile(raw); }

const BASE = {
  enabled: true,
  mode: 'blacklist',
  alwaysAllowLocal: true,
  allowDomains: ['mindplus.cc'],
  rules: [
    { id: 'r1', type: 'domain', value: 'game.com', note: '游戏', enabled: true },
    { id: 'r2', type: 'keyword', value: '游戏', note: '关键词', enabled: true },
    { id: 'r3', type: 'url', value: 'https://x.com/blocked', note: '前缀', enabled: true },
    { id: 'r4', type: 'regex', value: '/(evil|bad)\\.net/', note: '正则', enabled: true },
    { id: 'r5', type: 'domain', value: 'off.com', note: '已停用', enabled: false },
  ],
};

suite('blocklist · 域名规则', () => {
  test('域名命中自身与所有子域名', () => {
    eq(B.check(engine(BASE), 'https://game.com/').blocked, true);
    eq(B.check(engine(BASE), 'https://www.game.com/').blocked, true);
    eq(B.check(engine(BASE), 'https://a.b.game.com/x').blocked, true);
  });
  test('不误伤相似域名', () => {
    eq(B.check(engine(BASE), 'https://notgame.com/').blocked, false);
    eq(B.check(engine(BASE), 'https://game.com.cn/').blocked, false);
  });
  test('停用的规则不生效', () => {
    eq(B.check(engine(BASE), 'https://off.com/').blocked, false);
  });
  test('允许清单优先级最高（压过黑名单）', () => {
    const e = engine(Object.assign({}, BASE, {
      rules: [{ id: 'x', type: 'domain', value: 'mindplus.cc', enabled: true }],
    }));
    const r = B.check(e, 'https://www.mindplus.cc/download');
    eq(r.blocked, false);
    eq(r.reason, 'allow-list');
  });
});

suite('blocklist · 关键词 / 前缀 / 正则', () => {
  test('关键词对完整 URL 做不区分大小写包含', () => {
    eq(B.check(engine(BASE), 'https://a.com/游戏').blocked, true);
    eq(B.check(engine(BASE), 'https://a.com/other').blocked, false);
  });
  test('网址前缀匹配（含"域名+路径"写法）', () => {
    eq(B.check(engine(BASE), 'https://x.com/blocked/1').blocked, true);
    eq(B.check(engine(BASE), 'https://x.com/ok').blocked, false);
  });
  test('正则规则生效', () => {
    eq(B.check(engine(BASE), 'https://evil.net/a').blocked, true);
    eq(B.check(engine(BASE), 'https://bad.net/').blocked, true);
    eq(B.check(engine(BASE), 'https://good.net/').blocked, false);
  });
  test('非法正则不命中也不抛错', () => {
    const e = engine({ enabled: true, mode: 'blacklist', rules: [{ type: 'regex', value: '([', enabled: true }] });
    eq(B.check(e, 'https://a.com/').blocked, false);
  });
});

suite('blocklist · 模式与例外', () => {
  test('关闭屏蔽后全部放行', () => {
    const e = engine(Object.assign({}, BASE, { enabled: false }));
    const r = B.check(e, 'https://game.com/');
    eq(r.blocked, false);
    eq(r.reason, 'off');
  });
  test('白名单模式：不在允许清单就拦', () => {
    const e = engine(Object.assign({}, BASE, { mode: 'whitelist' }));
    eq(B.check(e, 'https://www.unknown.com/').blocked, true);
    eq(B.check(e, 'https://www.unknown.com/').reason, 'not-allowlisted');
    eq(B.check(e, 'https://mindplus.cc/').blocked, false);
  });
  test('alwaysAllowLocal 放行 SIoT 控制台', () => {
    const e = engine(BASE);
    eq(B.check(e, 'http://127.0.0.1:8080/').blocked, false);
    eq(B.check(e, 'http://localhost:8080/').reason, 'local');
    const off = engine(Object.assign({}, BASE, {
      alwaysAllowLocal: false,
      rules: [{ type: 'domain', value: '127.0.0.1', enabled: true }],
    }));
    eq(B.check(off, 'http://127.0.0.1:8080/').blocked, true);
  });
  test('非 http(s) 与 internal 一律不拦（由协议层把关）', () => {
    const e = engine(BASE);
    eq(B.check(e, 'internal:home').blocked, false);
    eq(B.check(e, 'gnet://home/').blocked, false);
    eq(B.check(e, 'file:///c:/x').blocked, false);
  });
  test('explain 给出可读理由', () => {
    const r = B.explain(engine(BASE), 'https://game.com/');
    eq(r.blocked, true);
    assert(r.message.includes('domain = game.com'), '说明里应包含命中的规则');
  });
});

suite('blocklist · 规范化与落盘', () => {
  test('normalize 去掉域名噪声与空规则', () => {
    const n = B.normalize({
      allowDomains: [' HTTPS://WWW.Foo.com/path ', '', '*.bar.com', '  ', 'http://192.168.1.10:8080/'],
      rules: [
        { type: 'domain', value: '  a.com ' },
        { type: 'weird', value: 'x' },
        { type: 'keyword', value: '   ' },
      ],
    });
    eq(n.allowDomains.join(','), 'www.foo.com,bar.com,192.168.1.10', '整段粘贴的 URL 应被还原成域名');
    eq(n.rules.length, 2, '空内容规则应被丢弃');
    eq(n.rules[0].value, 'a.com');
    eq(n.rules[0].type, 'domain');
    eq(n.rules[1].type, 'keyword', '未知类型回落为 keyword');
  });
  test('createStore 读写一致', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnet-bl-'));
    const f = path.join(dir, 'blocklist.json');
    const store = B.createStore(f, null);
    store.save({ mode: 'whitelist', rules: [{ type: 'domain', value: 'x.com' }] }, 'teacher');
    const again = B.createStore(f, null);
    eq(again.get().mode, 'whitelist');
    eq(again.get().rules.length, 1);
    eq(again.check('https://y.com/').blocked, true, '白名单模式应拦截未列出的站点');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
