'use strict';
// postinstall：把 mqtt 的浏览器包复制到 student/vendor/mqtt.min.js，供 renderer 离线引用。
// 若 mqtt 未安装或路径不同，静默跳过（renderer 会自动回退到 import 'mqtt'）。
const fs = require('fs');
const path = require('path');

const roots = [
  path.join(__dirname, '..', 'node_modules', 'mqtt', 'dist', 'mqtt.min.js'),
  path.join(__dirname, '..', 'node_modules', 'mqtt', 'dist', 'mqtt.js'),
  path.join(__dirname, '..', 'node_modules', 'mqtt', 'build', 'mqtt.min.js'),
];

const destDir = path.join(__dirname, '..', 'vendor');
const dest = path.join(destDir, 'mqtt.min.js');

try {
  fs.mkdirSync(destDir, { recursive: true });
  for (const src of roots) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      // eslint-disable-next-line no-console
      console.log('[copy-mqtt] 已复制', src, '->', dest);
      process.exit(0);
    }
  }
  // eslint-disable-next-line no-console
  console.warn('[copy-mqtt] 未找到 mqtt 浏览器包，renderer 将回退到 import "mqtt"（需构建期打包）。');
} catch (e) {
  // eslint-disable-next-line no-console
  console.warn('[copy-mqtt] 复制失败（可忽略）:', e.message);
}
