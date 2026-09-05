# 课堂管理系统 · 学生机客户端（Electron）

初二信息技术硬件实践课课堂管理系统的学生机端：Electron 桌面应用，通过 WebSocket
（`ws://<siotIp>:1888/ws`）连接 SIoT2，完成课前登记 / 课中任务状态上报 / 课后器材归还确认，
并响应教师端指令（开始上课、任务、下课、复位、关机）。

## 技术栈（锁定）
Electron 44.0.0 / mqtt 5.15.2（浏览器包，经 `scripts/copy-mqtt.js` 复制到 `vendor/` 供渲染层离线引用）

## 目录结构
```
student/
├── main.js              主进程：窗口、preload、IPC（关机执行 / 读 machineId / 保存座位）
├── preload.js           contextBridge：暴露受限 API（contextIsolation 开启）
├── renderer/            UI 三阶段页面 + 控制器
│   ├── index.html       页面骨架（脚本按依赖顺序加载）
│   ├── styles.css       设计 Token + 布局（深色/浅色跟随系统）
│   ├── equipment.js     器材清单（eqId 与 teacher/seeds/equipment.json 逐字一致）
│   ├── net.js           MQTT 客户端：WS 1888/ws、协议 4→3.1.1 降级、指数退避重连
│   ├── views.js         纯渲染模板（无 DOM 依赖）
│   ├── downlink.js      下行指令处理（cmd/sync 语义、阶段机、关机倒计时）
│   ├── actions.js       业务动作（登记 / 任务状态 / 归还 / 事件委托）
│   └── app.js           控制器装配（状态、上行、连接生命周期）
├── vendor/mqtt.min.js   postinstall 生成（勿手改）
├── app-config.json      部署配置（见下）
└── test/                协议 / 真机 broker / 渲染层无头验证
```

## 安装与运行
```bash
npm install                 # 装 mqtt + electron；postinstall 自动复制 vendor/mqtt.min.js
npm start                   # 启动学生端
```

## 打包（Win10/11 64 位）
```bash
npx electron-builder --win portable    # 单文件便携版（免安装）
npx electron-builder --win nsis        # 安装版
```
构建目标仅 Win10/11 64 位（Win7 支持已正式作废）。建议在目标机房系统上先跑 `npm start`
验证，再打包分发。

## 配置（app-config.json）
| 字段 | 说明 | 默认 |
|------|------|------|
| `siotIp` | SIoT2 所在主机 IP（机房场景填教师机/服务器 IP） | `127.0.0.1` |
| `siotWsPort` | SIoT2 WebSocket 端口 | `1888` |
| `username` / `password` | SIoT2 登录凭据 | `siot` / `dfrobot` |
| `secret` | HMAC 关机令牌密钥，**必须与教师端 `HMAC_SECRET` 一致**，部署前务必修改 | `change-me-before-deploy` |
| `machineId` | 本机唯一编号（留空则首次启动自动生成并持久化，格式 `M-xxxxxxxx`） | `""` |
| `dryRun` | 关机演练开关（缺省 `true`）；`secret` 为占位值时**强制** dry-run | `true` |

## 关机安全
关机指令带 HMAC 签名（`sessionId + ts + token`），主进程校验通过且时间窗 ≤60s 才执行
`shutdown /s /t 60`。三重防护：① 阶段闸门（仅 return/closed 阶段）；② HMAC 签名校验；
③ dry-run 兜底——`app-config.json` 的 `dryRun` 保持 `true` 或 `secret` 仍是占位值时，
只打印日志不真关机。**要启用真实关机**：把 `dryRun` 置 `false`，并把 `secret` 改为与
教师端 `HMAC_SECRET` 相同的强随机值（两端必须一致）。

## 测试
```bash
node test/protocol.test.js         # 协议语义 + HMAC（无 broker，需 teacher 模块）
node test/renderer.dom.test.js     # 渲染层三阶段流程（DOM 桩，无 broker）
node test/net.broker.test.js       # 真实 SIoT2 联调（需 broker 在跑）
```

## 通信协议（Plan B，勿改）
- 上行 `siot/ict_up`（QoS1）：`checkin` / `task` / `return` / `hello`
- 心跳 `siot/ict_hb`（QoS0）：`status`（15s 发、教师端 45s 判离线）
- 下行 `siot/ict_cmd`：`start` / `task` / `end` / `reset` / `shutdown`
- 同步 `siot/ict_sync`：`sync`（只认 `seat` 匹配自己的广播；用于服务端真值校正）
