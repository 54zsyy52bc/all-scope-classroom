'use strict';
// 网页 / 内置页的预加载。
//
// ★ 这个脚本会注入到**不可信的网页**里，因此：
//   · 它的能力表面（bridge.js）不是安全边界
//   · 真正的边界在主进程 ipc.js —— 每个通道都会检查 event.senderFrame.url，
//     只有 gnet:// 内置页与本机外壳能通过；http(s) 网页调用一律被拒绝并记日志
require('./bridge').expose('page', true);
