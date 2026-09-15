# 绿网 · 测试指南

> 面向 `classroom-mgmt/green-net`。四层自动化 + 手工验收清单 + 排障。
> 命令一律在 `classroom-mgmt/green-net/` 目录下执行。

---

## 0. 前置条件

| 项 | 要求 | 怎么确认 |
|---|---|---|
| 依赖已装 | `node_modules/`（含 Electron 44） | `ls node_modules/electron/dist/electron.exe` |
| 协议契约副本 | `src/shared/topics.js` | `npm run postinstall`（安装时自动跑） |
| **SIoT 在跑** | MQTT 1883 + HTTP 8080 | `netstat -ano \| grep -E ':1883\|:8080'` |

只有 L3 / L4 需要 SIoT。启动它：

```bash
cd ../../SIoT_V2_Win_2618/SIoT_V2_Win_2618 && ./main.exe -c conf/config.json
```

---

## 1. 一条命令跑完（最快路径）

```bash
npm run verify          # = L1 单元测试 + L2 冒烟，不需要 SIoT
npm run itest           # = L3 协议级集成，需要 SIoT
npm run qy-itest        # = L4 落地级联调，需要 SIoT
```

> ⚠️ **最容易误判的一点**：L3 / L4 在**探测不到 broker 时会打印 `SKIPPED` 并以退出码 0 结束**
> （设计上为了不阻塞 CI）。所以"退出码 0"不等于"验证过了"——**必须看输出里有没有
> `✅ …通过`，只看到 `SKIPPED` 就是根本没测**。

---

## 2. 四层自动化测试

分层不是形式主义：每一层能抓到的 bug 类型不同，缺一层就有一类问题溜过去。

| 层 | 命令 | 要不要 SIoT | 耗时 | 能抓到什么 |
|---|---|---|---|---|
| L1 单元 | `npm test` | 否 | 秒级 | 纯函数逻辑错 |
| L2 冒烟 | `npm run smoke` | 否 | ~15s | 装配错、渲染层静默失效 |
| L3 协议集成 | `npm run itest` | **是** | ~10s | 接线错（纯函数对了但没用上） |
| L4 落地联调 | `npm run qy-itest` | **是** | ~30s | "收到指令"到"界面变了"之间的断链 |

### L1 · 单元测试

```bash
npm test          # 等价于 node test/run-all.js
```

8 个用例文件、84 条断言，覆盖：URL 净化 / 屏蔽引擎 / 导航配置规范化 / 口令哈希 /
本机 IP 采集 / 配置分层 / 全域指令解析 / IPC 鉴权分级。

期望输出：`通过 84/84，全部通过 ✅`

这层不碰 Electron、不碰网络，改完纯逻辑先跑它，最快。

### L2 · Electron 冒烟

```bash
npm run smoke
```

真起 Electron、真建窗口、真加载首页，然后自检并退出。

期望输出：

```
[smoke] tabs=1 active=gnet://home/
[smoke] blocklist={"enabled":true,"rules":7,"check":true,...}
[smoke] netinfo primary=192.168.x.x
[smoke] qy state=online clientId=RNET_M-xxxxxxxx
[smoke] home-dom={"groups":4,"cards":15,"quick":3,"title":"绿网 · 学生导航"}
[smoke] pageErrors=0
✅ 冒烟通过：窗口建立、首个标签加载、屏蔽引擎拦截生效
```

**`home-dom` 与 `pageErrors` 这两行是重点**。它们同时验证了四件事：`gnet://` 协议能取到
静态资源、页面脚本真的执行了、preload 桥可用、IPC 鉴权放行了内置页。任何一环断了这里都是 0。
（这条断言是补上的——之前 `gnet://` 少放行了一类静态资源，导致首页脚本静默不执行、
按钮全是死的，而当时的冒烟照样"通过"。）

启动失败时看 `data/boot-fail.log` 的完整堆栈。

### L3 · 协议级集成（真 broker）

```bash
npm run itest     # 等价于 node test/qy-mqtt.integration.js
```

连**真的 MQTT broker**、真收发，40 项断言，含 **4 项负向用例**。

与 L1 的区别：L1 只证明 `interpretCommand()` 这个函数返回对了，L3 证明它**真的被 MQTT
消息驱动了**。举个实例——`handleSync` 的座位过滤条件读错了字段（读 `payload.seat`，
而 seat 实际在信封顶层 `env.seat`），过滤条件恒为假、**从未生效**：

- 正向用例（"发给本座位的 sync 要生效"）**全过**——因为条件恒为假反而"看起来生效"
- 只有负向用例（"发给**别的座位**的 sync 必须被忽略"）才暴露出来

所以负向用例不是凑数，是这层的主要价值。

### L4 · 落地级联调（真 Electron + 真 broker）

```bash
npm run qy-itest  # 等价于 node scripts/qy-integration.js
```

真起一个 Electron 实例（`--smoke-qy` 模式，无窗口），脚本扮演教师端下发
「锁定 → 下发活动 → 计时暂停 → 解锁」，然后核对**界面状态真的跟着变了**。

关键证据行：

```
[qy-smoke] trace=["state","connected","policy:lock","lock:on","task","timer:pause",
                  "policy:unlock","lock:off"]
[qy-smoke] seenUrls=["gnet://home/","gnet://locked/"]     ← 锁定页真的出现过
[qy-smoke] final={"locked":false,"activeUrl":"gnet://home/","taskTimerState":"paused"}
✅ 全域联动联调通过：锁定/活动/计时暂停/解锁 全部真实落地到界面
```

`seenUrls` 里出现 `gnet://locked/` 是**最有分量的一行**——它证明"收到指令"确实变成了"界面锁住"。
这一层专治"老师点了锁定、学生照样上网"这类现场最难解释的问题。

---

## 3. 手工测试

自动化覆盖不了交互与观感，下面是人工过一遍的清单。

### 3.1 起应用

```bash
npm run dev       # 开发模式：开 DevTools、放行 F12，调试用
npm start         # 普通模式：干净窗口，验收用这个
npm run kiosk     # 全屏锁定（考场/演讲场景）
```

### 3.2 六项需求逐条验收

| # | 需求 | 怎么验 | 期望 |
|---|---|---|---|
| 1 | 定制导航首页 | 启动即首页 | 4 个分组（硬件编程/物联网/学习/课堂工具）、15 张站点卡、3 个快捷按钮；点卡片在新标签打开 |
| 2 | SIoT 一键控制台 | 点右上角 **SIoT** 按钮 | 进入探活页；SIoT 在跑时显示已就绪；点「打开控制台」跳出 `127.0.0.1:8080` |
| 3 | 一键查看本机 IP | 点工具栏 **本机 IP** | 大号显示主地址、可一键复制、下方列出各网卡明细（供行空板/掌控板填地址） |
| 4 | 网页屏蔽 | 地址栏依次输入下表 URL | 命中判定如下 |
| 5 | 界面简洁 | 目测 | 顶栏状态胶囊 / 标签栏 / 工具栏分区清晰，无多余按钮，字号适合中小学生 |
| 6 | 全域对接 | 见 §3.3 | 收到指令后锁定页、活动条、倒计时有正确反应 |

**屏蔽功能的判定用例**（黑名单模式 + 13 个白名单例外）：

| 输入 | 期望 | 命中依据 |
|---|---|---|
| `https://www.taobao.com/` | ✗ 拦截 | 域名规则 r-shop-01 |
| `https://www.baidu.com/s?wd=游戏` | ✗ 拦截 | 关键词规则 r-game-01 |
| `https://www.douyin.com/` | ✗ 拦截 | 域名规则 r-sns-01 |
| `https://mindplus.cc/` | ✓ 放行 | 白名单例外 |
| `http://127.0.0.1:8080/` | ✓ 放行 | 本地地址放行（`alwaysAllowLocal`） |

再验一层**导航拦截**（不只地址栏）：在已打开的页面里点一个被屏蔽的链接，应跳到拦截页。
三层拦截（地址栏 / 导航跳转 / 子资源与 302）缺一层就能被绕过，所以这层也要点一下。

### 3.3 教师管理页

入口：点外壳右上角 **🔒** 按钮，或按 **Ctrl+Shift+A**。

1. **首次进入**：`data/admin.json` 不存在 → 视为初始化，直接设置口令（≥4 位）。
   之后每次进入都要口令；**连续错 3 次锁定 60 秒**。
2. **屏蔽名单** Tab：增删规则、开关规则、加白名单例外 → 保存后**立即生效**（无需重启），
   回到地址栏马上验证。
3. **导航内容** Tab：改分组/站点/快捷按钮 → 保存后回首页看变化。改坏了可"恢复默认"。
4. **系统设置** Tab：改首页地址、SIoT 地址、**座位号**（联动测试要用）、心跳开关。

### 3.4 全域联动的手工验证

自动化那两层已经断言了链路，但"锁定页长什么样、学生看着舒不舒服"得自己看。
配套工具 `scripts/teach-sim.js` 扮演教师端——它**只往 broker 发指令，不动你的窗口**，
所以你能对着自己开着的绿网窗口肉眼看反应。

开两个终端：

```bash
# 终端 A：把绿网开起来
npm start

# 终端 B：一键跑完整剧本（锁定 → 活动 → 计时暂停 → 解锁）
node scripts/teach-sim.js seq
```

预期：A 窗口先切到「课堂锁定」页 → 解锁后回到首页 → 顶部活动条显示
「搭建智能小车」且倒计时处于暂停态。

也可以单发一条，逐条观察：

```bash
node scripts/teach-sim.js lock              # 锁定课堂
node scripts/teach-sim.js unlock            # 解除锁定
node scripts/teach-sim.js task "搭建智能小车" 5   # 下发 5 分钟活动
node scripts/teach-sim.js timer pause 240   # 倒计时停在第 240 秒
node scripts/teach-sim.js timer resume      # 恢复走时
node scripts/teach-sim.js end               # 下课：清活动 + 解锁
node scripts/teach-sim.js watch             # 只看上行：学生端心跳与上报
```

**测座位过滤**（本工程修过一个"过滤从未生效"的 bug，值得手工复验一遍）：

```bash
# 1) 先在「管理页 → 系统设置 → 座位号」把自己设成 01
# 2) 下发一条发给座位 01 的同步 → 本机应生效（锁定）
node scripts/teach-sim.js sync --seat 01 --locked
# 3) 下发一条发给座位 99 的同步 → 本机应忽略（状态不变）
node scripts/teach-sim.js sync --seat 99 --locked
```

> 注意：绿网座位号**为空时不做过滤**（任何座位的 sync 都会应用）。这是设计的默认值，
> 部署到机房前必须逐台配好座位号，否则会出现"隔壁班的状态串到我这儿"。

---

## 4. 测试脏数据

- **别在交付包里跑测试**。`teacher/`、`green-net/` 的 `data/`、`exports/` 都是
  相对**工作目录**解析的，在 `交付包_v4课堂管理系统/` 下起服务会把测试数据写进交付产物。
- 测试产生的运行期文件（`data/audit.log`、`data/boot-fail.log`）已被 `.gitignore` 排除，
  但交付前建议手工清掉，免得被当成"工程自带文件"。
- 手工测过管理页后会生成 `data/admin.json`（已忽略，不会进仓库），但**它带着你设的口令**，
  装到学生机上之前记得删掉，否则每台机器共用一个口令。

```bash
rm -f data/audit.log data/boot-fail.log data/admin.json
```

---

## 5. 部署前验收（装到学生机之前必做）

自动化测试全绿 ≠ 可以装到机房。产物本身还要过一遍下面几项——这几条都是"测试环境里
看不出来、一旦装到 N 台机器上才炸"的类型。

### 5.1 一条命令查产物

```bash
node scripts/prepack.js --verify-only     # 退出码 0 = 可部署
```

它检查两件事：产物内 `machineId` 为空、`data/` 里没有运行期文件。

### 5.2 为什么 machineId 必须为空（**最容易漏、后果最重**）

`machineId` 决定 MQTT clientId（`RNET_<machineId>`）。开发机上跑过之后，工程里的
`app-config.json` 会被写入这台机器的 ID，打包时被一起复制进产物——**于是每台学生机
都是同一个 machineId、同一个 clientId**。

同一个 broker 上 clientId 相同会**互相踢下线**，结果就是：机房里只有最后一台能收到
教师端指令。现场表现是"装第一台好使，装完全都不好使"，极难当场定位。

`npm run pack` 已经内置了这项处理（临时清空 → 打包 → 恢复工程文件 → 校验产物）。
**所以不要绕过 `npm run pack` 直接调 `electron-builder`。**

装好后可以抽查一台，确认它自派生出了唯一 ID：

```bash
# 跑一次应用后，看本机配置里的 machineId 是否非空、且各台互不相同
node -e "console.log(require('C:/Program Files/绿网/resources/app/app-config.json').machineId)"
```

### 5.3 还要检查的三项配置

| 项 | 默认值 | 部署要求 |
|---|---|---|
| `seat` | `""` 空 | **逐台配好座位号**。为空时座位过滤不生效，会出现"隔壁班状态串过来" |
| `secret` | `change-me-before-deploy` | 换成正式值（仅作"是否已配置"的标志位，不加密数据） |
| `qy.host` | `127.0.0.1` | 若 SIoT 跑在教师机而非本机，改成教师机 IP |

这三项都能在**管理页 → 系统设置**里改（外壳右上角 🔒 或 Ctrl+Shift+A），改完重启绿网生效。

### 5.4 验收顺序建议

1. 本机 `npm run verify:all` 四层全绿
2. `npm run pack` → 打包 + 产物校验通过
3. 拷到**一台**学生机装好，手工点一遍 §3.2 的六项
4. 配好座位号，用 `npm run teach -- seq` 从教师机发一遍指令，确认这台能收到
5. 再装第二台，**确认两台用不同 machineId**、都能同时收到指令（这一步专门验互踢问题）
6. 全量铺开

---

## 6. 故障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `require("electron")` 返回一串路径字符串 | 宿主注入了 `ELECTRON_RUN_AS_NODE=1`，electron.exe 退化成纯 Node | 用 `npm run smoke`（脚本内已剥离该变量）。详见 §6 |
| 冒烟报 `TypeError: ... is not a function` 但单测全绿 | 装配期错误，L2 才能抓 | 看 `data/boot-fail.log` 堆栈 |
| 首页能显示但按钮点了没反应 | 页面 JS 没执行（协议层没回对 MIME） | 看冒烟的 `pageErrors` 与 `home-dom` 是否为 0 |
| L3/L4 显示 `SKIPPED` | broker 没起 | 启动 SIoT 后重跑；**别当成通过** |
| 锁定状态没反应 | `lockOnPolicy` 关了，或座位号对不上 | 查管理页系统设置 |
| `node -e "...require(...).machineId"` 返回 `M-d0d44063` 而不是开发机的派生值 | 你跑过 `npm start` / 手动启动过 exe | 用 `npm run pack`（会临时清空并校验）；不要再用 `npm start` 跑打包后的产物 |
| `npm run pack` 报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` | electron-builder 清空输出目录时单次删 50+ 个文件，撞上沙箱保护 | `mv dist/win-unpacked /tmp/old` 后重跑；或加 `-c.electronDist=node_modules/electron/dist` 完全跳过下载 |
| `mv dist/win-unpacked /tmp/x` 报 `Device or resource busy` | exe 启动后有 5 个 `electron.exe` 子进程，持有输出目录的句柄 | `taskkill /IM electron.exe /F` 后重试 |
| `machineId` 部署到机房后每台都是同一个值 | 包内 `machineId` 没被清空就跑到了学生机上 | `node scripts/prepack.js --verify-only` 必须 0；详见解 §5.2 |
| 任何公网站都打不开 / 转圈，`ERR_FAILED code=-2` | Chromium 在 Windows 不读 `HTTPS_PROXY`、也不认系统代理（ProxyEnable=0）时以为无代理直连 | 见下「公网站 ERR_FAILED 排查」；绿网已自动注入 `--proxy-server`，多数情况改 `proxy.mode=auto` 即可 |
| 管理页改了代理但仍打不开 | 代理是**启动期**命令行参数，改完要**重启绿网**才生效 | 保存后退出绿网重开；`npm run smoke` 看 `proxy-cmdline server=` 是否为空 |
| 设了手动代理却 `ERR_PROXY_CONNECTION_FAILED` | 填的代理地址不可达 / 端口错 / 那是 SOCKS 而非 HTTP 代理 | 用 `curl -x http://地址 站点` 验证代理本身能出网；绿网只支持 HTTP(S) 正向代理 |
| `npm run smoke` 的 `net-probe` 失败但 `home-dom` 正常 | 只是外网探针失败，应用本体没问题（沙箱网络隔离也会这样） | 真机用 `proxy.mode=auto` 复测；别把沙箱 ERR_FAILED 当成代码 bug |

### 公网站 ERR_FAILED 排查（关键）

`npm run smoke` 输出的 `net-probe` / `proxy-cmdline` 两行即可定位：

```
[smoke] proxy mode=auto resolved=(直连) source=none
[smoke] proxy-cmdline server=(无) bypass=(无)
[smoke] net-probe=✗ did-fail-load code=-2 desc=ERR_FAILED
```

- `resolved=(直连) source=none` + `net-probe=✗ ERR_FAILED`：本机没配代理且 Chromium 以为直连
  → 多半是「机器靠环境变量/第三方代理出网，但系统代理关着」。改 `proxy.mode=manual` 填实际代理，
  或确认 `auto` 能读到 `HTTPS_PROXY`（真实运行时 shell 通常带着它）。
- `proxy-cmdline server=127.0.0.1:xxxx` 非空但 `net-probe` 仍失败：代理注入成功了，是代理本身
  不可达（见上表 `ERR_PROXY_CONNECTION_FAILED`）。
- `locked=true` 时 `net-probe` 超时：是课堂锁定把 http(s) 全拦了，不是网络问题。

---

## 6. 关于 Electron 环境坑（改测试脚本前必读）

本机沙箱会给子进程注入 `ELECTRON_RUN_AS_NODE=1` 与 `NODE_OPTIONS`，导致 `electron.exe`
**退化成纯 Node**：Electron 内建模块不再注册，`require('electron')` 落到 npm 包上，
拿到的是 exe 路径字符串，之后每个模块都以 `undefined is not a function` 炸开。

因此所有拉起 Electron 的脚本都必须先净化环境变量——`scripts/smoke.js` 与
`scripts/qy-integration.js` 里的 `sanitizeEnv()` 就是干这个的。**新写脚本时照抄**，
不要图省事直接用 `process.env`。

另外：**在交互式 shell 里 `env | grep -i electron` 看不到这两个变量是正常的**，
宿主是在 spawn 子进程那一刻注入的。要确认 Electron 自己看到了什么，用用户级技能
`electron-app-verify` 里的探针应用，或直接看 `src/main/index.js` 顶部的自检守卫输出。
