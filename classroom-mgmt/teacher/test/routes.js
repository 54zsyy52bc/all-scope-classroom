'use strict';
// 路由清单诊断：按 server.js 的实际挂载方式枚举所有生效路径，用于核对挂载是否正确。
// 运行：node test/routes.js
const express = require('express');

// 必须与 server.js 的挂载顺序保持一致
const MOUNTS = [
  ['/api/v1/system', require('../src/routes/system')],
  ['/api/v1', require('../src/routes/session')],
  ['/api/v1', require('../src/routes/task')],
  ['/api/v1', require('../src/routes/equipment')],
  ['/api/v1', require('../src/routes/command')],
  ['/api/v1', require('../src/routes/dashboard')],
  ['/api/v1', require('../src/routes/export')],
  ['/api/v1', require('../src/routes/preset')],
  ['/api/v1', require('../src/routes/legacy')],
];

const app = express();
for (const [mount, router] of MOUNTS) app.use(mount, router);

const routes = [];

function walk(stack, prefix) {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
      routes.push({ method: methods, path: prefix + layer.route.path });
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, prefix);
    }
  }
}

for (const [mount, router] of MOUNTS) {
  if (router && router.stack) walk(router.stack, mount === '/' ? '' : mount);
}

const counts = {};
for (const r of routes) {
  const key = r.method + ' ' + r.path;
  counts[key] = (counts[key] || 0) + 1;
}

routes.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
for (const r of routes) {
  const key = r.method + ' ' + r.path;
  const dup = counts[key] > 1 ? `   <-- 重复注册 ${counts[key]} 次` : '';
  console.log(`${r.method.padEnd(6)} ${r.path}${dup}`);
}
console.log(`\n共 ${routes.length} 条路由，其中重复 ${Object.values(counts).filter((c) => c > 1).length} 条`);
