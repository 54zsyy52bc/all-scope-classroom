'use strict';
// 浏览器外壳（工具栏/标签栏）的预加载：完整能力 + 全部事件订阅。
// 载体是本机文件 src/renderer/chrome.html（受信任）。
require('./bridge').expose('shell', true);
