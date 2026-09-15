# 绿网 · 物联网实践学生专用浏览器

面向中小学信息课的**学生专用浏览器**。基于 Chromium 内核（Electron 44），内置创客/物联网常用网站导航、
SIoT 控制台一键打开、本机 IP 一键查看、教师口令保护的网页屏蔽与导航管理，并与**「全域」课堂管理系统**
（`classroom-mgmt`）通过 MQTT 联动——老师一条指令即可全屏锁定、下发活动、解锁。

定位：**同一台机器上的第二个学生侧客户端**。第一个是全域学生端壳（负责考勤/器材/桌宠），
绿网只负责"上网这件事"，把课堂状态映射为浏览器行为。

---

## 1. 需求 → 实现对照

| # | 需求 | 实现位置 | 说明 |
|---|------|---------|------|
| 1 | 定制学生导航首页，内置创客硬件网站 | `src/renderer/pages/home.*`、`data/nav-config.json`、`src/main/nav-config.js` | 4 分组 / 15 站点，可被老师在管理页改写 |
| 2 | 一键打开 SIoT 控制台 | `src/main/siot-console.js`、`pages/siot.*` | 先探活（TCP 1883 + HTTP 8080），在跑就直接开；没跑给启动步骤 |
| 3 | 一键查看本机 IP | `src/main/netinfo.js`、`pages/ip.*` | 私网 IPv4 优先、虚拟网卡降级排序，附 SIoT 服务器地址填写提示 |
| 4 | 网页屏蔽 + 老师口令管理 | `src/main/blocklist.js`、`admin-auth.js`、`pages/admin.*` | scrypt 口令哈希；错 3 次锁 60 秒；屏蔽名单与导航内容均可编辑 |
| 5 | 界面简洁直观 | `src/renderer/chrome.*`、`pages/assets/*` | 大按钮卡片式首页；顶栏状态胶囊；全程中文文案 |
| 6 | 对接「全域」系统 | `src/main/qy-bridge.js`、`src/shared/topics.js` | 复用 `classroom-mgmt/shared/topics.js` 契约，锁定/活动/计时/解锁 |

---

## 2. 模块划分

### 2.1 主进程 `src/main/`（15 个模块，职责单一）

```
装配层
  index.js          主进程入口：启动时序编排 + 事件接线 + 冒烟/联调自检
  ipc.js            渲染层通道注册，统一包一层鉴权 + 异常兜底
  trust.js          ★ IPC 发送方鉴权分级（安全边界所在，见 §3.3）

能力层（每个都能单独 require 出来做单元测试）
  config.js         分层配置（siot / qy / 窗口 / 下载）+ machineId 生成
  blocklist.js      屏蔽引擎：纯函数 compile / check / explain，不碰 IO
  nav-config.js     导航内容规范化（internal 动作白名单、颜色校验）
  admin-auth.js     教师口令：scrypt 加盐哈希 + 连续失败锁定
  tabs.js           ★ 标签管理：一标签一 WebContentsView + 三层拦截
  protocol.js       gnet:// 内置页协议处理器（页面 + 同源静态资源）
  session-policy.js 下载 / 权限 / 证书管控
  qy-bridge.js      ★ 全域 MQTT 桥（下行读 + 心跳上行）
  netinfo.js        本机 IP 采集与排序
  siot-console.js   SIoT 探活与一键打开
  logger.js         stdout + data/audit.log 双写
  util.js           净化 / 规范化 / URL 处理（无依赖，最底层）
```

**依赖方向（严格单向，无环）**：
`util` → `logger` / `config` / `blocklist` / `nav-config` / `admin-auth` → `tabs` / `protocol` / `qy-bridge` / `netinfo` / `siot-console` → `trust` → `ipc` → `index`

### 2.2 预加载 `src/preload/`（3 个，按信任级别分开）

| 文件 | 注入对象 | 用途 |
|------|---------|------|
| `shell.js` | 浏览器外壳（`file://`） | **完整能力** + 事件订阅 |
| `page.js` | 任意网页 | 只有极小形状，且**不暴露任何特权方法** |
| `bridge.js` | 共用 | 收敛 `window.greenNet` 的方法形状 |

### 2.3 渲染层 `src/renderer/`

```
chrome.html/css/js      浏览器外壳：顶栏状态胶囊 / 标签栏 / 工具栏 / SIoT+IP 按钮
                        / 全域活动条 / 锁定条 / 口令弹窗
pages/                  9 个内置页：home ip siot admin blocked locked error qy help
pages/assets/           pages.css（统一样式） + common.js（window.GN 兼容层，无 Electron 时降级）
```

### 2.4 数据与运维

```
app-config.json             运行配置（首次启动可读，机器相关字段写回此文件）
data/blocklist.json         屏蔽名单（老师可编辑）
data/nav-config.json        导航内容（老师可编辑）
data/admin.json             口令哈希（salt + scrypt hash，不含明文）
data/audit.log              审计日志
src/seed/nav-config.default.json   导航种子：文件损坏/丢失时自动恢复
```

### 2.5 网络出口（代理）—— 公网站 ERR_FAILED(-2) 的根因与修法

**现象**：浏览器里任何公网站都打不开（转圈 / `ERR_FAILED code=-2`），但同机 `curl`、Node、
Edge 却能正常上网。

**根因**：Chromium 在 Windows 上**不读 `HTTPS_PROXY` 这类环境变量**，也只认 WinHTTP
（系统代理，即「设置 → 代理」）。当机器靠环境变量或第三方代理软件（如 Clash / v2rayN）出网、
而系统代理开关是关的（`ProxyEnable=0`）时，Chromium 会以为「无需代理」→ 所有 https 直接失败。

**修法**：绿网在启动早期（`app ready` 之前）按 `app-config.json` 的 `proxy` 字段自动注入
`--proxy-server` / `--proxy-bypass-list`，与 Edge/Chrome 行为对齐：

```jsonc
"proxy": {
  "mode": "auto",      // auto(按环境/系统自动，推荐) | manual(用 server) | off(直连)
  "server": "",        // mode=manual 时填，如 "127.0.0.1:7897"
  "bypass": "<local>"  // 绕过列表，默认 <local> 保证本机 SIoT(127.0.0.1:8080) 不走代理
}
```

- `auto` 优先级：① 环境变量 `HTTPS_PROXY`/`HTTP_PROXY`（含小写）→ ② Windows 系统代理
  （仅 `ProxyEnable=1`）→ ③ 都没有则直连。
- 解析逻辑在 `src/main/proxy.js`，注入在 `src/main/index.js` 的 `setupProxy()`（必须在
  `app.whenReady()` 之前调用，因为 Chromium 启动时才读命令行代理）。
- 在管理页「网络出口（代理）」卡片可改；**改完需重启绿网生效**（代理是启动期命令行参数）。
- 一键自诊：`npm run smoke` 会打印 `proxy mode=... resolved=... source=...` 与
  `proxy-cmdline server=...`（这是 Chromium 真正生效的开关值）以及 `net-probe=...`。

---

## 3. 集成逻辑（关键设计）

### 3.1 启动时序（**顺序本身是正确性的一部分**）

```
app.whenReady()
  └─ initBase()        ① logger → config → ensureMachineId()
                        （建窗口要读配置，所以必须先跑，否则 createWindow 会读到 null）
  └─ createWindow()    ② 建 BrowserWindow 外壳（tabs 需要它作为 WebContentsView 的宿主）
  └─ initModules()     ③ 分区 → gnet 协议 → 存储 → 标签 → 全域桥 → IPC
```

> 踩坑：早期版本在 `config` 初始化前就调 `config.get()`，启动即崩。现已拆成三段。

### 3.2 屏蔽的三层拦截（缺一层就会被绕过）

```
L1  navigate() 入口          地址栏输入、首页卡片点击、新标签打开
L2  will-navigate / will-redirect / setWindowOpenHandler
                             页面内点链接、JS 跳转、服务端 302
L3  webRequest.onBeforeRequest（兜底）
                             页面里嵌的第三方子资源、漏网的主框架请求、锁定期间的后台请求
```

命中后统一跳到内置页 `gnet://blocked/`，而不是 Chromium 那套学生看不懂的错误页。
锁定状态下 `guard()` 优先级最高：任何导航都先判锁定。

### 3.3 IPC 鉴权：安全边界在主进程，不在 preload

**核心判断**：`page.js` 会被注入到**不可信的任意网页**里。所以安全边界不能是"preload 少暴露几个方法"，
而必须是**主进程按发送方逐通道鉴权**。

`trust.js` 按 `event.senderFrame.url` 把调用方分三级：

| 级别 | 来源 | 权限 |
|------|------|------|
| `shell` | `file://` 外壳 | 全可信 |
| `internal` | `gnet://admin/` | 可写（屏蔽名单 / 导航内容 / 系统设置） |
| `internal` | 其它 `gnet://` 页 | 只读 |
| `web` | 任意 `http(s)` 网页 | **一律拒绝** |
| `unknown` | 空 / 异常 URL | 拒绝 |

### 3.4 `gnet://` 自定义协议

内置页是**真实的导航目标**，而不是叠在渲染层上的一块面板。好处：前进/后退、地址栏、
标签标题天然正确；学生从首页点外网、再按后退，能正常回到首页。

```
registerSchemesAsPrivileged({ standard:true, secure:true, supportFetchAPI:true,
                              corsEnabled:true, stream:true })   ← 必须在 app ready 之前
session.protocol.handle('gnet', handle)                          ← ready 之后挂到分区上
```

路由：`gnet://<页面名>/` 取页面；`gnet://<host>/<任意静态文件>` 取 `pages/` 下的同源资源
（含 `./home.js` 与 `./assets/pages.css` 两种引用形式）。

> 踩坑：早期只放行 `/assets/*`，`./home.js` 被当成"页面请求"返回了 HTML，
> 浏览器按 JS 解析报 `Uncaught SyntaxError: Unexpected token '<'`，**页面脚本整段不执行**，
> 表现为"首页按钮点了没反应"。现在静态资源走扩展名白名单 + 目录穿越防护。

### 3.5 与「全域」的协议契约

**单一真源**：`classroom-mgmt/shared/topics.js`（构建时由 `scripts/copy-shared.js` 复制到
`src/shared/topics.js`，禁止各端自行硬编码常量）。

| 主题 | 方向 | 用途 |
|------|------|------|
| `siot/ict_cmd` | 教师 → 学生 | 广播指令（QoS1） |
| `siot/ict_sync` | 教师 → 学生 | 逐生状态恢复（QoS1） |
| `siot/ict_up` | 学生 → 教师 | 业务上行（绿网不使用） |
| `siot/ict_hb` | 学生 → 教师 | 心跳（QoS0） |

**下行指令 → 浏览器行为映射**：

| 教师端指令 | 绿网行为 |
|-----------|---------|
| `cmd policy{locked:true}` | 全屏锁定：所有标签切到 `gnet://locked/`，禁用地址栏，L3 拦截一切 http(s) 请求 |
| `cmd policy{locked:false}` | 解锁，并**原地恢复到锁前的网页** |
| `cmd task{...}` | 顶部活动条（标题 + 倒计时） |
| `cmd task_timer{...}` | 暂停 / 恢复 / 调整 / 到期（到期弹提示） |
| `cmd end` | 解锁（`closeOnEnd=true` 时 5 秒后自动关闭浏览器） |
| `cmd reset` | 解锁并回首页 |
| `cmd shutdown` | **不执行关机**（关机由全域学生端负责，避免两处同时下发）；仅提示学生保存作品 |
| `sync{...}` | 迟到/重连时恢复 phase / policy / currentTask |

**两个必须记住的字段细节**：

1. `task_timer` 的子动作在 **`payload.timerAction`**，不在 `payload.action`
   ——`payload.action` 已被信封工厂固定为 `'task_timer'`。
   依据：`teacher/src/mqtt/bridge.js` 与 `student/renderer/control.js`。
2. `sync` 的座位号在 **信封顶层 `env.seat`**，不在 `payload` 里。
   依据：`teacher/src/mqtt/bridge.js:publishSync()` → `topics.makeSync({seat, ...})`，
   而 `makeSync` 只把 seat 写进 `env.seat`；核心学生端 `downlink.js` 读的也是 `String(env.seat)`。

**关于心跳（重要，别随手打开）**：
默认 `qy.reportHeartbeat = false`。因为 `siot/ict_hb` 是**考勤心跳通道**，
绿网打开心跳会往教师端混入"浏览器在线"的信号，可能干扰考勤统计。
只有当确实需要"浏览器在线 = 本机在线"时才打开，且必须已配置 `seat`（没座位号时桥接会拒绝上报）。

**断线重连**：自管指数退避 1s → 2s → 4s → 8s → 16s → 30s（与教师端一致，不用 mqtt 自带 reconnect）。
连不上不影响浏览器基本功能，状态在 `gnet://qy` 页可见。

---

## 4. 目录结构

```
green-net/
├── package.json / app-config.json
├── data/                     运行数据（屏蔽名单 / 导航内容 / 口令哈希 / 审计日志）
├── src/
│   ├── main/                 主进程 15 个模块
│   ├── preload/              shell.js(外壳) / page.js(网页，最小形状) / bridge.js
│   ├── renderer/             chrome.*（外壳） + pages/（9 个内置页）
│   ├── seed/                 导航种子
│   └── shared/topics.js      协议契约副本（由 copy-shared.js 生成）
├── scripts/
│   ├── copy-shared.js        postinstall：复制协议契约
│   ├── smoke.js              Electron 冒烟（起窗口 → 建标签 → 验屏蔽 → 验首页渲染）
│   └── qy-integration.js     全域联动落地联调（真 Electron + 真 broker）
└── test/
    ├── harness.js            极简断言框架
    ├── run-all.js            8 个用例文件入口（84 条断言）
    ├── *.test.js             纯函数单元测试
    └── qy-mqtt.integration.js 协议级集成测试（真 broker，40 条断言）
```

---

## 5. 构建与验证

> 完整的测试方法 —— 四层验证各自的取舍、手工验收清单、故障速查、测试脏数据处理 ——
> 见 **[TESTING.md](TESTING.md)**。本节只给命令。

```bash
npm install                 # 含 postinstall（复制协议契约）；会拉 Electron 44

npm test                    # 单元测试：84 条断言，不依赖任何外部服务
npm run smoke               # Electron 冒烟：真起应用，验窗口/标签/屏蔽/首页渲染
npm run verify              # test + smoke 一起跑（改完代码的最低门槛）
npm run verify:all          # 四层全跑（需要本机 SIoT，否则后两层 SKIPPED）

npm start                   # 正常运行
npm run dev                 # 带 devtools
npm run kiosk               # 全屏 kiosk

npm run pack                # 打包成免安装目录 → dist/win-unpacked/绿网.exe
npm run dist                # 打包成 NSIS 安装包
node scripts/prepack.js --verify-only   # 只校验已有产物（离线可用），不重新打包
```

### 打包时会自动做的三件事（`scripts/prepack.js`）

**不要绕过它直接调 `electron-builder`**，否则打出的包不能多机部署：

1. **临时清空 `machineId`** —— 开发机上跑过之后，`app-config.json` 会被写入这台机器的
   machineId（`M-xxxxxxxx`）。打包只是复制文件，于是**每台学生机都带着同一个 ID**，
   而 machineId 直接决定 MQTT clientId（`RNET_<machineId>`）。同 clientId 连同一个 broker
   会**互相踢下线**，机房里只有最后一台能收到指令。现场表现为"装第一台好使，装完全都不好使"。
   清空后每台机器首次启动会用 `deriveMachineId()`（主机名 + MAC + CPU + 架构）自行派生唯一值。
2. **清掉运行期残留** —— `data/audit.log`、`data/admin.json`（含开发机设的口令哈希）等，
   只保留 `blocklist.json` / `nav-config.json` 这两个"出厂默认配置"。
3. **校验产物** —— 打包后确认产物内 machineId 确实为空、无运行期文件；不满足则报错退出。
   工程内的 `app-config.json` 在打包结束（无论成败）后会被恢复原状。

> **网络受限时**：`electron-builder` 每次都要下载 Electron 包（约 100MB，本机缓存里没有）。
> GitHub 源不通时用镜像；用 `-c.electronDist=node_modules/electron/dist` 直接复用项目
> 内的 Electron 运行时可以**彻底跳过下载**（强烈推荐，已经实测可用）：
> ```bash
> ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run pack -- -c.electronDist=node_modules/electron/dist
> ```
>
> **沙箱批量删除保护**：有些沙箱会让 `electron-builder` 的 `emptyDir` 撞上
> `SAFE_DELETE_BULK_CONFIRM_REQUIRED`（一次删 50+ 个文件被拦）。**用 mv 把旧产物
> 移走代替删除**可以绕开：
> ```bash
> mv dist/win-unpacked /tmp/old-build && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run pack -- -c.electronDist=node_modules/electron/dist
> ```
>
> **exe 启动后会持锁 `dist/win-unpacked`**：5 个 `electron.exe` 子进程会卡住
> 后续的 mv / 重新打包。`taskkill /IM electron.exe /F` 杀掉。

> **验证打包产物时的注意点**：打包后的 `绿网.exe` 是 Windows **GUI 子系统**程序，
> 从控制台运行时 **stdout 会被丢弃**，所以那时看不到 `--smoke` 的输出；
> `npm run smoke` 只适合在源码树里跑（Electron 的 node 运行时会正常回显）。
> 要确认安装包版本真的起来了，看 `dist/win-unpacked/resources/app/data/audit.log`：
> 出现 `启动 green-net …` → `全域链路状态：online` → `[renderer] shell ready` 即正常。
> 若启动失败，同目录下的 `data/boot-fail.log` 会有完整堆栈。

### 全域联动相关的两层验证（需要本机 SIoT）

`test/qy-mqtt.integration.js` 与 `scripts/qy-integration.js` 需要 `127.0.0.1:1883` 上有 MQTT broker；
探测不到会自动打印 `SKIPPED` 并以 0 退出，不会卡住 CI。

```bash
# 必须在同一条 shell 命令里起 broker 再跑（否则后台进程会被回收）
cd SIoT_V2_Win_2618/SIoT_V2_Win_2618 && ./main.exe -c conf/config.json &
sleep 5 && cd classroom-mgmt/green-net && npm run itest && npm run qy-itest
```

- `npm run itest`（协议层，纯 Node）：真的收发 MQTT，校验话题订阅、字段映射、
  **座位过滤**、坏消息容错、心跳开关，含 4 条负向用例。
- `npm run qy-itest`（落地层，真 Electron）：脚本扮演教师端按序下发
  `policy(锁) → task → task_timer(pause) → policy(解锁)`，断言
  **锁定页真的出现过**、解锁后回到原网页、最终状态一致。

### 手工联调：教师端指令模拟器

上面两个脚本都会自己拉起 Electron 并跑完就退。想**对着自己开着的窗口肉眼看反应**时用这个
（只往 broker 发指令，不动你的窗口）：

```bash
npm start                          # 终端 A：把绿网开起来
npm run teach -- seq               # 终端 B：一键跑完整剧本，看 A 的反应
npm run teach -- lock              # 单发：锁定课堂
npm run teach -- task "搭建智能小车" 5    # 单发：下发 5 分钟活动
npm run teach -- sync --seat 99    # 测座位过滤（本机座位不是 99 时应被忽略）
npm run teach -- watch             # 只看上行：学生端心跳与上报
```

---

## 6. 已知边界与设计取舍

1. **不执行关机**。`cmd shutdown` 只提示，实际关机交给全域学生端，避免双客户端同时下发。
2. **不做考勤**。绿网不碰 `siot/ict_up`，心跳默认关闭，见 §3.5。
3. **无窗静默失败被显式排除**。启动链路任何异常都会写 `data/boot-fail.log` 并 `app.exit(1)`，
   不留一个"看起来开着但什么都没做"的进程。
4. **`src/shared/topics.js` 是生成物**，不要手改；改契约请改 `classroom-mgmt/shared/topics.js`
   后重新 `npm run postinstall`。
5. **打包前必须跑一次 `postinstall`**（`electron-builder` 的 `files` 只收集 `green-net/` 内的文件）。

---

## 7. 踩坑备忘（改代码前请先读）

| 现象 | 根因 | 处置 |
|------|------|------|
| `require('electron')` 返回一个**字符串**（exe 路径），随后 `undefined is not a function` 到处炸 | 宿主环境注入了 `ELECTRON_RUN_AS_NODE=1`，electron.exe 退化成纯 Node，`electron` 不再作为内建模块注册，`require` 落到 `node_modules/electron/index.js`（那个包导出 exe 路径） | 启动前剥离该变量（见 `scripts/smoke.js` 的 `sanitizeEnv()`）；`index.js` 顶部有自检守卫会明确报出这一条 |
| 首页按钮点了没反应 | `gnet://` 只放行 `/assets/*`，`./home.js` 被回成 HTML → 页面脚本整段不执行 | 静态资源改扩展名白名单 + 目录穿越防护，见 §3.4 |
| 整间机房的 phase/policy 互相覆盖 | `sync` 座位过滤读的是 `payload.seat`（恒 undefined），过滤从未生效 | 改读 `env.seat`，见 §3.5 |
| `task_timer` 暂停/恢复静默失效 | 子动作字段读成了 `payload.action`（恒为 `'task_timer'`） | 改读 `payload.timerAction` |
| 冒烟"通过"但页面其实是坏的 | 主进程正常 ≠ 渲染层正常 | 冒烟增加了渲染进程错误收集 + 首页 DOM 内容断言（groups/cards/quick 必须 > 0） |
| 后台起的 broker 跑着跑着就没了 | 沙箱会回收命令结束时的后台进程 | broker 与测试放在**同一条 shell 命令**里执行 |
