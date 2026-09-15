'use strict';
const { suite, test, eq, assert } = require('./harness');
const N = require('../src/main/nav-config');

suite('nav-config · 规范化', () => {
  test('站点 url 只接受 http(s) 或白名单内的 internal 动作', () => {
    const g = N.normGroup({
      name: 'G',
      sites: [
        { name: 'a', url: 'https://a.com/' },
        { name: 'b', url: 'internal:siot' },
        { name: 'c', url: 'internal:hack' },
        { name: 'd', url: 'javascript:alert(1)' },
      ],
    }, 0);
    eq(g.sites[0].url, 'https://a.com/');
    eq(g.sites[1].url, 'internal:siot');
    eq(g.sites[2].url, 'internal:home', '未知 internal 动作回落为 home');
    eq(g.sites[3].url, 'javascript:alert(1)', '协议过滤交给 normalizeUrl，此处仅保留原值');
  });
  test('颜色必须是合法色值，否则回落', () => {
    const g = N.normGroup({ name: 'G', color: 'red', sites: [] }, 0);
    eq(g.color, '#16a34a');
    const g2 = N.normGroup({ name: 'G', color: '#0ea5e9', sites: [] }, 0);
    eq(g2.color, '#0ea5e9');
  });
  test('按分组名的缺省值补齐 + 生成 id', () => {
    const g = N.normGroup({ sites: [{ url: 'https://a.com/' }] }, 2);
    assert(g.id, '应生成分组 id');
    eq(g.name, '分组 3');
    assert(g.sites[0].id, '应生成站点 id');
  });
  test('超长/空输入不抛错', () => {
    const c = N.normalize(null);
    eq(c.title, N.DEFAULT_CONFIG.title);
    eq(Array.isArray(c.groups), true);
  });
  test('快捷按钮动作收敛到白名单', () => {
    const c = N.normalize({ quickActions: [{ action: 'evil', name: 'x' }, { action: 'ip' }] });
    eq(c.quickActions[0].action, 'home');
    eq(c.quickActions[1].action, 'ip');
  });
});

suite('nav-config · 存储', () => {
  test('缺失时从种子恢复并落盘', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnet-nav-'));
    const f = path.join(dir, 'nav-config.json');
    const seed = path.join(dir, 'seed.json');
    fs.writeFileSync(seed, JSON.stringify({
      title: '种子标题', subtitle: 's',
      groups: [{ id: 'g1', name: 'G', sites: [{ id: 's1', name: 'A', url: 'https://a.com/' }] }],
    }));
    const store = N.createStore(f, null, seed);
    eq(store.get().title, '种子标题');
    eq(fs.existsSync(f), true, '应从种子写出一份配置');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('save / reset 往返一致', () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnet-nav2-'));
    const f = path.join(dir, 'nav-config.json');
    const seed = path.join(dir, 'seed.json');
    fs.writeFileSync(seed, JSON.stringify({ title: '出厂', subtitle: '', groups: [] }));
    const store = N.createStore(f, null, seed);
    store.save({ title: '改过的', groups: [{ name: 'X', sites: [{ name: 'A', url: 'https://a.com/' }] }] }, 'teacher');
    eq(store.get().title, '改过的');
    eq(store.get().groups.length, 1);
    eq(store.allUrls().length, 1);
    store.reset(seed);
    eq(store.get().title, '出厂');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
