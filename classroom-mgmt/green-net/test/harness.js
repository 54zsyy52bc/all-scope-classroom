'use strict';
// 极简断言 + 用例收集（不引第三方依赖，node 直接跑）
const cases = [];
let current = '';

function suite(name, fn) {
  current = name;
  fn();
  current = '';
}

function test(name, fn) {
  cases.push({ suite: current, name, fn });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '值不相等') + `\n  实际: ${JSON.stringify(a)}\n  期望: ${JSON.stringify(b)}`);
}

function deepEq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || '对象不相等') + `\n  实际: ${sa}\n  期望: ${sb}`);
}

function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch (_e) { threw = true; }
  if (!threw) throw new Error(msg || '期望抛出异常但没有');
}

function run() {
  let pass = 0;
  const fails = [];
  let lastSuite = '';
  for (const c of cases) {
    if (c.suite !== lastSuite) { lastSuite = c.suite; /* 分组标题由 runner 打印 */ }
    try {
      c.fn();
      pass += 1;
      process.stdout.write('.');
    } catch (e) {
      fails.push({ ...c, err: e });
      process.stdout.write('F');
    }
  }
  process.stdout.write('\n');
  for (const f of fails) {
    // eslint-disable-next-line no-console
    console.error(`\n✗ [${f.suite}] ${f.name}\n  ${String(f.err.message).split('\n').join('\n  ')}`);
  }
  return { pass, fail: fails.length, total: cases.length, fails };
}

module.exports = { suite, test, assert, eq, deepEq, throws, run, cases };
