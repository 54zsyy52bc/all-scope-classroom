'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { suite, test, eq, assert } = require('./harness');
const { createAuth } = require('../src/main/admin-auth');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnet-auth-'));
  return { dir, file: path.join(dir, 'admin.json') };
}

suite('admin-auth · 初始化与校验', () => {
  test('首次使用：未初始化，可直接设置口令', () => {
    const { dir, file } = tmpFile();
    const a = createAuth(file, null);
    eq(a.initialized(), false);
    const r = a.setPassword('lvwang1234', '');
    eq(r.ok, true);
    eq(a.initialized(), true);
    eq(a.verify('lvwang1234').ok, true);
    eq(a.verify('wrong').ok, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('口令太短被拒', () => {
    const { dir, file } = tmpFile();
    const a = createAuth(file, null);
    eq(a.setPassword('123', '').ok, false);
    eq(a.initialized(), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('改口令需要原口令', () => {
    const { dir, file } = tmpFile();
    const a = createAuth(file, null);
    a.setPassword('first1234', '');
    eq(a.setPassword('second1234', 'nope').ok, false);
    eq(a.verify('first1234').ok, true);
    eq(a.setPassword('second1234', 'first1234').ok, true);
    eq(a.verify('second1234').ok, true);
    eq(a.verify('first1234').ok, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('连续错 3 次锁 60 秒', () => {
    const { dir, file } = tmpFile();
    const a = createAuth(file, null);
    a.setPassword('abcd1234', '');
    eq(a.verify('x').ok, false);
    eq(a.verify('x').ok, false);
    const third = a.verify('x');
    eq(third.ok, false);
    eq(third.locked, true);
    const locked = a.verify('abcd1234'); // 正确口令在锁定期内也被拒
    eq(locked.ok, false);
    eq(locked.locked, true);
    const st = a.state();
    eq(st.locked, true);
    assert(st.lockedRemainSec > 0 && st.lockedRemainSec <= 60, '锁定剩余时间应在 1..60 秒');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('哈希落盘，文件里没有明文口令', () => {
    const { dir, file } = tmpFile();
    const a = createAuth(file, null);
    a.setPassword('SuperSecret123', '');
    const raw = fs.readFileSync(file, 'utf8');
    assert(!raw.includes('SuperSecret123'), '文件中不能出现明文口令');
    const obj = JSON.parse(raw);
    eq(obj.algo, 'scrypt');
    assert(obj.salt && obj.hash, 'salt/hash 必须存在');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('换 salt：同一口令两次设置的哈希不同', () => {
    const { dir, file } = tmpFile();
    const a = createAuth(file, null);
    a.setPassword('same1234', '');
    const h1 = JSON.parse(fs.readFileSync(file, 'utf8')).hash;
    a.setPassword('same1234', 'same1234');
    const h2 = JSON.parse(fs.readFileSync(file, 'utf8')).hash;
    assert(h1 !== h2, '随机 salt 应使哈希不同');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test('未初始化时 verify 给出可读提示', () => {
    const { dir, file } = tmpFile();
    const a = createAuth(file, null);
    const r = a.verify('x');
    eq(r.ok, false);
    assert(String(r.err).includes('尚未设置'), '提示应说明需要先初始化');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
