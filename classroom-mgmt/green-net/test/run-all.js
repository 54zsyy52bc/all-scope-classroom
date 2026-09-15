'use strict';
// 测试入口：依次加载全部用例文件 → 汇总输出 → 有失败则退出码 1
const fs = require('node:fs');
const path = require('node:path');
const H = require('./harness');

const FILES = [
  'util.test.js',
  'blocklist.test.js',
  'nav-config.test.js',
  'admin-auth.test.js',
  'netinfo.test.js',
  'config.test.js',
  'qy-bridge.test.js',
  'ipc-auth.test.js',
];

const dir = __dirname;
let loaded = 0;
for (const f of FILES) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) {
    // eslint-disable-next-line no-console
    console.error('缺少用例文件：' + f);
    process.exit(1);
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  require(p);
  loaded += 1;
}

// eslint-disable-next-line no-console
console.log(`\n绿网 · 单元测试（${loaded} 个用例文件，${H.cases.length} 条断言组）\n`);
const r = H.run();
// eslint-disable-next-line no-console
console.log(`\n通过 ${r.pass}/${r.total}${r.fail ? `，失败 ${r.fail}` : '，全部通过 ✅'}`);
if (r.total === 0) {
  // eslint-disable-next-line no-console
  console.error('没有执行任何用例（用例文件未注册 test）');
  process.exit(1);
}
process.exit(r.fail ? 1 : 0);
