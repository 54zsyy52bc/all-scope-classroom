# 初二信息技术硬件实践课课堂管理系统
## 架构交付物 ARCH_v1（技术栈锁定 + SIoT2 核实 + ADR + 风险）

| 项目 | 内容 |
| --- | --- |
| 文档编号 | ARCH-ICT-ClassMgmt-v1 |
| 版本 | v1.0 |
| 编写日期 | 2026-08-30 |
| 编写 | 首席架构师 高见远 |
| 上游文档 | 01 需求规格、02 系统架构、03 数据库设计、04 接口设计 |
| 定位 | 本文**不推翻** 02/03/04，而是在其之上补齐三件事：SIoT2 实参核实、技术栈与版本锁定、可执行的工程约束与风险闸口 |

---

## 0. 本版相对 02/03/04 的实质性修正

以下 5 条是核实 SIoT2 官方资料后**必须修正**的既有假设，不修正会在 Phase 3 直接踩坑：

| # | 02/03/04 原假设 | 核实后结论 | 处理 |
| --- | --- | --- | --- |
| 1 | 学生机/看板均连 `tcp://IP:1883` | 浏览器与 Electron 渲染进程**不能**用 MQTT TCP，必须走 WebSocket `ws://IP:1888/ws` | 见 §2、§5.1、ADR-004 |
| 2 | 「可选开启消息持久化以支持断线补发」 | SIoT V2 **用 QoS 区分是否入库**：QoS 1 = 转发并存数据库，QoS 0 = 只转发不存。没有独立的"持久化开关" | 见 §2、§5.4 |
| 3 | 主题用三级 `ICTClass/STU_07/checkin` | SIoT V2 Web 端建的主题是 `siot/{设备名}` 两级，`siot` 前缀**平台固定、不可自定义**。三级自定义主题能否被转发/通配符订阅**未经证实** | 引入 topicMap 映射层 + P0 验证脚本，见 §6、§10 |
| 4 | 依赖 `cleanSession=false` 做离线补发；retained message 给新学生机补状态 | SIoT V2 对会话保持与 retained 的支持**无官方说明，不可依赖** | 改为应用层状态同步 + 客户端本地队列，见 §5.5、§5.6 |
| 5 | clientId 固定为 `STU_{seat}` | SIoT 官方明确：**相同 clientId 后连者会把前者挤下线**。机房克隆镜像极易导致座位号重复 → 两台机器互踢死循环 | clientId 加机器随机后缀 + 座位冲突检测，见 §7.2、R-02 |

---

## 1. 已核实的 SIoT2 事实基线

> 核实日期 2026-08-30。来源：DFRobot 官方产品资料库（wiki.dfrobot.com.cn）、Mind+ 官方文档（mindplus.dfrobot.com.cn/dashboard）、SIoT 官方使用手册（siot.readthedocs.io）、DFRobot 官方教程（learn.dfrobot.com）、DF 创客社区实测帖。

### 1.1 端口与凭据（已确认）

| 项 | 值 | 置信度 | 说明 |
| --- | --- | --- | --- |
| MQTT TCP 端口 | `1883` | 已确认 | 硬件端（掌控板/行空板/micro:bit）与 Node 进程用此端口 |
| MQTT WebSocket 端口 | `1888`，路径 `/ws` | 已确认 | 完整地址 `ws://<IP>:1888/ws`；浏览器与 Electron 渲染进程唯一可用通道 |
| Web 管理端口 | `8080` | 已确认 | `http://<IP>:8080`，本机可用 `127.0.0.1:8080` |
| 默认用户名 | `siot`（全小写） | 已确认 | 前后不可有空格，否则报"需要授权" |
| 默认密码 | `dfrobot`（全小写） | 已确认 | 可改，见 §1.4 |
| 公网/跨网段需放行端口 | `8080`、`1883`、`1888` | 已确认 | 官方 FAQ 明示这三个端口 |
| 支持的协议 | MQTT、WS、MQTTS | 已确认 | 启动黑窗输出中列出三者 |

### 1.2 QoS 与消息存储机制（关键，与直觉不同）

SIoT V2 把 QoS 复用成了"是否入库"的开关，这是它与标准 broker 最大的行为差异：

| QoS | SIoT V2 行为 | 对应 Python siot 库 | 对应 Mind+ 积木 |
| --- | --- | --- | --- |
| 0 | 仅转发，**不写数据库**，速度快 | `publish()` | 「发送消息到主题」 |
| 1 | 转发 **且写入数据库**，Web 页面/图表组件可见 | `publish_save()` | 「发送消息到主题并保存到数据库」 |

官方原文佐证："SIoT V2 ... 使用 QOS 区分了快速数据以及存入数据的数据以应对不同的使用场景"；"只有『发送并保存』的消息，才能存储在数据库中"；"MQTT 发送的消息需要保存到数据库（QOS1）才能被图表组件显示出来"。

**对本系统的影响（正向）**：02 文档已定的 QoS 分级恰好与此机制吻合，且获得了第二条更硬的理由——

- 业务消息（checkin/task/return/cmd）用 QoS 1 → 顺带在 SIoT 侧留一份可查的原始报文，排障时可在 Web 页面直接看到学生发了什么，无需加日志。
- 心跳用 QoS 0 → **避免 SIoT 数据库写放大**。测算：50 台 × 每 15s 一次 × 45 分钟 = **9000 条/节课**，若用 QoS 1 全部落盘，一学期会把 SIoT 内置库撑爆且毫无价值。业务消息 QoS 1 全量仅约 250 条/节课，完全无压力。

### 1.3 主题（Topic）规则（重要约束）

| 版本 | 主题创建方式 | 命名形态 |
| --- | --- | --- |
| SIoT V1 | 程序端首次 publish 即自动建立项目/设备 | `项目名/设备名`，如 `xzr/001` |
| SIoT V2 | 通常在 Web 管理界面创建 | 用户只填**设备名**，平台自动补成 `siot/{设备名}` |

官方原文："其中 `siot` 表示项目名称，在 SIoT V2 中这一部分**由平台固定生成，不能自定义**；`temp` 表示设备名称，这一部分由用户自己填写。"

同时另有实践资料指出：MQTT 协议本身不需要预先建立主题，"网页调用 `subscribe()` 后开始监听，设备第一次 `publish()` 后，SIoT 就会转发这条消息"。

**结论（如实标注）**：SIoT V2 作为 broker 的**纯转发**能力大概率不限制主题层级，但"Web 可见 / 入库 / 通配符订阅"三项在三级自定义主题下**未经证实**。这不是可以靠推理解决的问题，只能实测。因此本架构不赌任何一边，而是引入 topicMap 映射层（§6.3）+ Phase 2 前置验证脚本（§10）。

### 1.4 配置文件

启动命令实为 `main.exe -c conf/config.json`。V1 官方文档给出的字段结构：

```json
{
  "User": "scope",
  "Password": "scope",
  "WebServerAdrr": "0.0.0.0:8080",
  "MqttAdrr": "0.0.0.0:1883",
  "OnlyLocalURD": false
}
```

- 用户名/密码/Web 端口均可改，**重启后生效**。
- `WebServerAdrr` 设 `127.0.0.1:8080` 可限制仅本机登录管理页。
- `OnlyLocalURD=true` 时非本机无法看到/删除项目与设备，只能发消息——多人环境下防误删。
- V2 的 `conf/config.json` 字段可能新增 WS 监听地址，**以实机文件为准**，Phase 2 需实际打开确认。

### 1.5 启动方式与已知坑

- Windows：解压后双击 **`start SIoT.bat`**，不要直接跑 `main.exe`（官方两处明确强调）。
- 必须把 SIoT 加入 Windows 防火墙允许列表，勾选专用+公用网络，否则外部设备连不上。
- 机房必须给运行 SIoT 的机器设**固定 IP**，否则 DHCP 变更后 50 台学生机全部失联。
- 建议运行在行空板 M10 上（官方推荐，规避 Windows 防火墙问题、可 24h 运行）；本项目教师机常驻，跑 Windows 版亦可，但需接受防火墙配置成本。
- 版本选择：需 **2618 及以后**版本，早期版本有"APP 被您禁用了"弹窗缺陷。
- 实测帖显示 MQTTX 连接时选的是 **MQTT 3.1**，MQTT.js 默认走 3.1.1（protocolVersion 4）。协议版本兼容性列为 R-04，验证脚本覆盖。

### 1.6 额外可用能力：HTTP WebAPI（降级通道）

V1 文档记载 SIoT 提供 HTTP 接口，可作教师端**健康探测与降级发指令**用：

```
发布：http://<IP>:8080/publish?topic=xzr/001&msg=on&iname=siot&ipwd=dfrobot
     返回 {"code":1,"msg":"数据已发送"}
取最新：http://<IP>:8080/lastmessage?...
```

V2 是否保留未证实，列入 §10 验证清单。若保留，教师端"SIoT 存活探测"用它比开一条 MQTT 连接更轻。

---

## 2. 技术栈锁定

### 2.1 版本表（2026-08-30 从 npm registry 实查）

| 层 | 组件 | 锁定版本 | 安装方式 | 备注 |
| --- | --- | --- | --- | --- |
| Broker | DFRobot SIoT V2 | 2618 及以后版本 | 官方网盘下载解压，`start SIoT.bat` | 不走包管理，随文档附带二进制 |
| 运行时 | Node.js | **22.x LTS**（实测环境 22.22.2） | 官网 MSI 安装 | 教师端与构建工具链共用 |
| 学生端 | Electron | **44.0.0** | `npm i -D electron@44.0.0` | 主进程调 OS 关机 |
| 学生端 | mqtt (MQTT.js) | **5.15.2** | `npm i mqtt@5.15.2` | 纯 JS，无原生依赖 |
| 学生端 | electron-builder | **26.15.3** | `npm i -D electron-builder@26.15.3` | 出 Windows 免安装绿色包 |
| 学生端 UI | 原生 HTML + CSS + ES Module | — | 无框架 | 见 §2.3 决策理由 |
| 教师端 | Express | **4.22.2**（`latest-4` 标签） | `npm i express@4.22.2` | 见 §2.4 为何不用 5.x |
| 教师端 | better-sqlite3 | **13.0.3** | `npm i better-sqlite3@13.0.3` | 同步 API，教师端单进程最合适 |
| 教师端 | mqtt (MQTT.js) | **5.15.2** | 同上 | 与学生端同版本，减少行为差异 |
| 教师端 | xlsx (SheetJS) | **0.18.5** | `npm i xlsx@0.18.5` | npm 上最后一个发布版，见 §2.5 |
| 教师端 | papaparse | **5.7.0** | `npm i papaparse@5.7.0` | CSV 导出 |
| 通用 | uuid | **14.0.2** | `npm i uuid@14.0.2` | msgId 生成；亦可用内置 `crypto.randomUUID()` 省掉此依赖 |
| 图标 | Lucide（`lucide-static` SVG） | 最新稳定版 | `npm i lucide-static` | **全项目唯一图标源，禁止 emoji 当图标**；离线内联 SVG |

> uuid 依赖可裁掉：Node 22 与 Electron 44 的 Chromium 均内置 `crypto.randomUUID()`。建议直接用内置，依赖数减一，本表保留仅作备选。

### 2.2 最关键的一条选型纪律：学生端零原生依赖

Electron 打包最大的坑是原生模块（node-gyp / electron-rebuild / ABI 版本不匹配），在机房 50 台机器分发场景下一旦踩上就是灾难。本架构用一条硬约束绕开：

```
学生端依赖清单只允许纯 JS：Electron 自身 + mqtt.js
better-sqlite3（唯一原生模块）只出现在教师端 Node 进程，绝不进 Electron
```

学生机本地缓存（断线队列/座位配置）用 **`fs` 写 JSON 文件**，不用 SQLite、不用 IndexedDB。数据量级：断线期间最多缓存数十条消息，JSON 文件完全够用。

收益：学生端 `npm i` 不触发任何编译，`electron-builder` 直接出免安装目录包，拷进机房即可运行，无需 VC++ 运行库、无需 rebuild。**这条纪律不允许在 Phase 3 被"顺手加个库"破坏。**

### 2.3 学生端 UI 为何不用框架

- 界面总量：4 个阶段视图（等待/登记/任务/归还）+ 1 个常驻状态条，无路由、无复杂状态派生。
- 引入 Vue/React 会带来构建步骤（Vite/webpack），而机房环境需要的是"拷贝即运行"的绿色包。
- 原生 ES Module + `<script type="module">` 在 Electron 44 的 Chromium 中原生支持，**零构建**。
- 硬约束仍然生效：单文件 ≤300 行，按视图拆文件（§4.3）。

### 2.4 Express 选 4.22.2 而非 5.2.1

Express 5 已 stable，但对本项目是净负债：

- 教师端只用到静态托管、几个 JSON 端点、一条 SSE——Express 5 的新特性（Promise 错误传播、路由匹配变更）一条都用不上。
- 5.x 的 breaking change（路径匹配语法、`req.query` 行为、移除若干别名方法）会让搜到的绝大多数示例代码失效，对 MVP 是纯摩擦。
- 4.22.2 处于 `latest-4` 维护标签下，安全更新持续。

**若 Phase 3 有人想升 5.x，需先提 ADR，不得直接改。**

### 2.5 SheetJS 版本说明（必读，否则会装错）

- npm 上 `xlsx` 的最后一个发布版本是 **0.18.5**，SheetJS 官方此后改为在自有 CDN（`cdn.sheetjs.com`）发布新版，npm 包不再更新。
- 本项目导出需求为"多 Sheet + 表头 + 中文"，0.18.5 完全覆盖，**锁 0.18.5，走 npm**，不引入 CDN 依赖（机房可能无外网）。
- CSV 导出用 PapaParse，并按 04 文档 §3.3 要求写 **UTF-8 with BOM**（`\uFEFF` 前缀），否则 Excel 打开中文乱码。

### 2.6 被否决的方案（留档，避免重复讨论）

| 方案 | 否决理由 |
| --- | --- |
| 学生端用浏览器打开网页 | 无法调用 OS 关机（核心需求），已被锁定决策排除 |
| 学生端 Python + WebView（02 文档备选） | 机房需装 Python 运行时；打包体积与分发复杂度不低于 Electron；团队 JS 栈统一性更好 |
| 教师端看板浏览器直连 MQTT 1888 做聚合 | 聚合逻辑会在浏览器与 Node 两处重复；刷新页面即丢全量状态；SQLite 落地无从下手。见 ADR-003 |
| 教师端用 WebSocket（ws 库）推看板 | SSE 已够（单向推送），且浏览器原生 `EventSource` 自带重连，少一个依赖 |
| 用 SIoT retained message 给新连入学生机补状态 | SIoT V2 retained 支持无官方说明，不可依赖。改用应用层 sync（§5.6） |
| 学生端存 SQLite/IndexedDB | 违反 §2.2 零原生依赖纪律；JSON 文件足够 |

---

## 3. 系统架构

### 3.1 部署拓扑（修正端口与通道）

```
                    ┌──────────────────────────────────────────┐
                    │        DFRobot SIoT V2  (教师机或行空板M10)  │
                    │  MQTT TCP 1883 │ WS 1888/ws │ Web 8080     │
                    │  账号 ${SIOT_USER} / ${SIOT_PASS}           │
                    │  固定 IP: ${SIOT_IP}                        │
                    └───┬───────────────────────────────┬────────┘
             ws://…:1888/ws                    mqtt://…:1883
                        │                               │
        ┌───────────────┼───────────────┐               │
        │               │               │               │
   ┌────┴────┐    ┌────┴────┐    ┌────┴────┐    ┌──────┴──────────────┐
   │ 学生机#1 │    │ 学生机#2 │ …  │ 学生机#50│    │ 教师端 Node 进程      │
   │ Electron │    │ Electron │    │ Electron │    │ Express + MQTT 桥接   │
   │ mqtt.js  │    │ mqtt.js  │    │ mqtt.js  │    │ better-sqlite3        │
   └──────────┘    └──────────┘    └──────────┘    └──────┬──────────────┘
                                                           │ SSE + HTTP
                                                    ┌──────┴──────┐
                                                    │ 大屏看板浏览器 │
                                                    │ (投影/教师机) │
                                                    └─────────────┘
```

要点：

- 学生机走 **WS 1888**（渲染进程内的 Chromium 不能开 TCP）。
- 教师端 Node 进程走 **TCP 1883**（Node 无此限制，TCP 比 WS 少一层封装，更稳）。
- 看板浏览器**不直连 MQTT**，只与本机 Node 通信（SSE 收状态，HTTP POST 发指令）。理由见 ADR-003。
- SIoT 与教师端 Node 可同机部署（生产推荐），也可分机；地址一律走 `${SIOT_IP}` 配置项，不硬编码。

### 3.2 分层架构与依赖方向

```
┌─────────────────────────────────────────────────────────────┐
│ 表现层                                                        │
│  学生端 renderer/views/*     教师端 routes/ + controllers/     │
│  只做：渲染、事件绑定、参数校验、组装响应                          │
└───────────────────────────┬─────────────────────────────────┘
                            ↓ 单向依赖
┌─────────────────────────────────────────────────────────────┐
│ 业务层 services/                                              │
│  会话状态机、聚合模型、关机闸门、导出编排、幂等判定                 │
│  禁止 import req/res，禁止碰 DOM，只返回业务结果或抛业务异常        │
└───────────────────────────┬─────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 数据层 repositories/   +   通信层 mqtt/                        │
│  SQL 读写（无业务判断）      topic 解析、收发、重连、队列          │
└───────────────────────────┬─────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 基础设施  better-sqlite3 连接 │ mqtt.js client │ OS shutdown   │
└─────────────────────────────────────────────────────────────┘
```

铁律（引自团队《代码组织规范》，Phase 3 验收按此判定）：

- 依赖**只能向下**，下层禁止反向 import 上层。
- controller **禁止**直接执行 SQL，必须经 service。
- service **禁止** import `req`/`res`，**禁止**返回 HTTP 响应。
- repository **禁止**含业务判断（如"若已归还则…"）。
- MQTT handler 属通信层，解析报文后调 service，**不得**在 handler 里写业务或 SQL。
- 入口文件（`app.js` / `main.js`）**只装配**，行数 < 100。
- 单文件 ≤ **300 行**（不含空行注释），超限拆分。

### 3.3 数据权威性

| 数据 | 权威存储 | 说明 |
| --- | --- | --- |
| 会话/登记/任务/借还/日志 | **教师端 `data/classroom.db`（SQLite）** | 唯一权威源，导出唯一依据 |
| 实时看板视图模型 | 教师端 Node 内存对象 | 由 DB + MQTT 增量维护，进程重启从 DB 重建 |
| 原始报文副本 | SIoT 内置库（QoS 1 自动落盘） | 只用于排障取证，**不作业务依据** |
| 断线待发队列 / 座位号 | 学生机 `userData/outbox.json`、`config.json` | 极小，重连后清空 |

学生机保持 02 文档确立的"无状态上报"原则不变。

---

## 4. 目录结构（可执行约束）

### 4.1 仓库布局

```
课堂管理系统/
├── student-client/          # 学生端 Electron
├── teacher-server/          # 教师端 Node + Express + SQLite + 看板
├── siot/                    # SIoT V2 二进制 + conf/config.json 模板 + 启动说明
├── docs/                    # 01–04 + ARCH_v1 + ADR
└── scripts/
    ├── test-forward.mjs     # §10 实测脚本：TCP 1883 转发验证（Phase 2 闸口实际执行）
    ├── test-ws.mjs          # §10 实测脚本：WS 1888/ws 转发验证（Electron 渲染进程通道）
    └── siot-spike.mjs       # 已被 test-* 取代（含 subscribeAsync bug + 旧 broker workerNum=4096 崩溃问题），仅留作历史参考
```

### 4.2 教师端

```
teacher-server/
├── package.json
├── data/classroom.db                  # 运行时生成，不入库
├── public/                            # 大屏看板（静态，Express 托管）
│   ├── index.html
│   ├── styles.css
│   ├── app.js                         # 入口装配
│   ├── sse-client.js                  # EventSource 订阅
│   ├── views/{matrix,stats,eventfeed}.view.js
│   └── icons/                         # lucide-static 内联 SVG，禁 emoji
└── src/
    ├── app.js                         # 入口：装中间件+挂路由+启动，<100 行
    ├── config/
    │   ├── index.js                   # 读 .env / config.json，含 topicMap
    │   └── db.js                      # better-sqlite3 连接 + migrate
    ├── routes/
    │   ├── index.js                   # 聚合，挂 /api/v1
    │   ├── session.routes.js
    │   ├── command.routes.js
    │   ├── dashboard.routes.js
    │   └── export.routes.js
    ├── controllers/                   # 与 routes 一一对应
    ├── services/
    │   ├── session.service.js         # 阶段状态机
    │   ├── command.service.js         # 指令下发（含 shutdown 闸门校验）
    │   ├── aggregate.service.js       # 实时视图模型
    │   ├── export.service.js          # xlsx/csv 编排
    │   └── seat-conflict.service.js   # 座位号冲突检测（R-02）
    ├── repositories/
    │   ├── session.repo.js
    │   ├── student.repo.js
    │   ├── task.repo.js
    │   ├── borrow.repo.js
    │   └── eventlog.repo.js
    ├── mqtt/
    │   ├── bridge.js                  # 连接/重连/订阅
    │   ├── topic-map.js               # 逻辑主题 ↔ 物理主题 映射（§6.3）
    │   ├── router.js                  # 物理 topic → handler 分发
    │   ├── idempotency.js             # msgId LRU 去重
    │   └── handlers/{checkin,task,return,status,sync}.handler.js
    ├── realtime/sse.js                # SSE 广播
    ├── validators/                    # 报文 schema 校验，独立成文件
    └── utils/                         # 纯函数：时间格式化、BOM 包装等
```

### 4.3 学生端

```
student-client/
├── package.json
├── config.json                        # SIoT 地址/凭据/座位来源，见 §7
├── main/
│   ├── main.js                        # 入口：建窗+注册 IPC，<100 行
│   ├── ipc.js                         # IPC 通道注册
│   ├── shutdown.service.js            # OS 关机（§8 ADR-001）
│   ├── seat.service.js                # 座位号解析：hostname/config/prompt
│   └── store.service.js               # outbox.json / config.json 读写
├── preload/preload.js                 # contextBridge 白名单暴露
└── renderer/
    ├── index.html
    ├── styles.css
    ├── app.js                         # 入口装配：阶段路由 <150 行
    ├── mqtt-client.js                 # 连接/重连/收发（核心）
    ├── outbox.js                      # 断线队列 + 按 ts 补发
    ├── phase-store.js                 # 状态机 waiting→checkin→task→return→closed
    ├── views/{waiting,checkin,task,return}.view.js
    ├── icons/                         # lucide-static SVG
    └── lib/mqtt.min.js                # mqtt@5.15.2 浏览器构建，本地副本（离线）
```

`renderer/lib/mqtt.min.js` 从 `node_modules/mqtt/dist/mqtt.min.js` 拷贝，`<script src>` 直接引入——保持零构建。

### 4.4 门禁命令（Phase 3 验收执行，超限即退回）

```bash
# 单文件 300 行硬上限
find student-client teacher-server -name '*.js' -not -path '*/node_modules/*' \
  -not -name 'mqtt.min.js' | xargs wc -l | sort -rn \
  | awk '$1>300 && $2!="total" {print "OVER LIMIT:", $0}'

# 入口只装配
wc -l teacher-server/src/app.js student-client/main/main.js

# 学生端零原生依赖
node -e "const d=require('./student-client/package.json').dependencies||{};\
console.log(Object.keys(d).every(k=>['mqtt'].includes(k))?'OK':'VIOLATION: '+Object.keys(d))"

# emoji 图标扫描（应为空）
grep -rIn -P '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' \
  student-client/renderer teacher-server/public --include='*.html' --include='*.js' --include='*.css'
```

---

## 5. 通信机制细化

### 5.1 连接参数（分端不同，勿混用）

| 参数 | 学生端（Electron 渲染进程） | 教师端（Node 进程） |
| --- | --- | --- |
| 传输 | WebSocket | TCP |
| 地址 | `ws://${SIOT_IP}:${SIOT_WS_PORT}${SIOT_WS_PATH}`<br>默认 `ws://${SIOT_IP}:1888/ws` | `mqtt://${SIOT_IP}:${SIOT_TCP_PORT}`<br>默认 `mqtt://${SIOT_IP}:1883` |
| clientId | `STU_${seat}_${machineSuffix}` | `TEACHER_${sessionBoot}` |
| username / password | `${SIOT_USER}` / `${SIOT_PASS}` | 同 |
| keepalive | **30 s** | 30 s |
| protocolVersion | 4（3.1.1）；失败降级 3 + `protocolId:'MQIsdp'` | 同 |
| clean | `true`（见 §5.5 说明） | `true` |
| reconnectPeriod | 0（**关闭内置重连**，改用自管退避，见 §5.3） | 0 |
| connectTimeout | 8000 ms | 8000 ms |

学生端连接代码骨架：

```js
// renderer/mqtt-client.js（节选）
const url = `ws://${cfg.siotIp}:${cfg.wsPort}${cfg.wsPath}`;   // ws://192.168.x.x:1888/ws
const client = mqtt.connect(url, {
  clientId: `STU_${seat}_${machineSuffix}`,   // machineSuffix 防 clientId 互踢（R-02）
  username: cfg.siotUser,
  password: cfg.siotPass,
  keepalive: 30,
  protocolVersion: 4,
  clean: true,
  reconnectPeriod: 0,        // 自管指数退避
  connectTimeout: 8000,
});
```

### 5.2 发布/订阅矩阵

| 端 | 订阅（逻辑主题） | 发布（逻辑主题） |
| --- | --- | --- |
| 学生机 | `BROADCAST_CMD`、`STU_SYNC(own)` | `STU_CHECKIN`、`STU_TASK`、`STU_RETURN`、`STU_STATUS`、`STU_HELLO` |
| 教师端 | 全部学生上行 + `STU_HELLO` | `BROADCAST_CMD`、`STU_SYNC` |

物理主题由 topicMap 解析，业务代码只认逻辑名（§6.3）。

### 5.3 断线检测与指数退避重连

关闭 mqtt.js 内置重连、改为自管，原因：需要精确控制退避序列、需要在重连成功后按序补发队列、需要把每次尝试写进事件日志便于机房排障。

```
状态机：
  DISCONNECTED ──connect()──► CONNECTING ──on('connect')──► ONLINE
       ▲                          │                            │
       │                    on('error')/timeout          on('close')
       │                          ▼                            │
       └────────────── BACKOFF(delay) ◄───────────────────────┘
                            │
                     delay 序列（ms）:
                     1000 → 2000 → 4000 → 8000 → 16000 → 30000(封顶，持续重试)
                     实际 delay = base + jitter(0~300ms)   ← 防 50 台同时重连打爆 broker
```

- 判定离线：`on('close')` / `on('error')` 立即置离线；另设 `1.5 × keepalive = 45s` 无任何收发的兜底看门狗。
- 重连成功后顺序执行：① 重新订阅 → ② 发 `STU_HELLO` 请求状态同步（§5.6）→ ③ 按 `ts` 升序 flush outbox。
- **jitter 是必需项不是优化项**：50 台机器在教师机重启 SIoT 后会同时进入退避，无抖动将形成同步重连风暴。
- 状态条常驻显示：在线（绿）/ 重连中（黄，带下次重试秒数）/ 离线（灰），文字标注，不用 emoji。

### 5.4 QoS 分级（与 §1.2 SIoT 存储机制绑定）

| 消息 | 逻辑主题 | QoS | 在 SIoT 是否入库 | 理由 |
| --- | --- | --- | --- | --- |
| 指令 start/end/task/shutdown/reset | `BROADCAST_CMD` | 1 | 是 | 必须送达；入库留指令审计 |
| 登记上报 | `STU_CHECKIN` | 1 | 是 | 关键业务，至少一次 |
| 任务状态上报 | `STU_TASK` | 1 | 是 | 关键业务 |
| 归还确认 | `STU_RETURN` | 1 | 是 | 关键业务，关机前置条件 |
| 状态同步应答 | `STU_SYNC` | 1 | 是 | 需送达 |
| 上线问候 | `STU_HELLO` | 1 | 是 | 需送达 |
| 在线心跳（15 s） | `STU_STATUS` | **0** | **否** | 可丢；避免 9000 条/节课写放大（§1.2） |

### 5.5 关于 cleanSession 的决策变更

02 文档定 `cleanSession=false` 以借 broker 会话保持做离线补发。本架构改为 **`clean=true`**，理由：

1. SIoT V2 对持久会话与离线 QoS1 队列的支持**无官方说明**，赌不起。
2. 持久会话要求 clientId 稳定不变，但 R-02（clientId 互踢）要求加机器随机后缀，两者直接冲突。
3. 我们已有更可靠的机制：**学生端本地 outbox 队列**（上行）+ **教师端 sync 应答**（下行状态）。这两者与 broker 能力无关，任何标准 MQTT broker 都成立。

不依赖 broker 高级特性，是本系统能"换 EasyIoT 也能跑"的前提（02 文档 §1 的设计目标）。

### 5.6 新连入 / 重连学生机的状态补齐（替代 retained message）

不使用 retained message（§1.1 未证实、§0-4）。改为应用层三步握手：

```
学生机                        SIoT                   教师端 Node
   │ ①连接成功+订阅               │                        │
   │──STU_HELLO {seat,ver}──────►│───────────────────────►│ 查内存视图模型
   │                             │                        │ + DB 该 seat 已有记录
   │◄──STU_SYNC{phase,task,      │◄───────────────────────│ ②应答当前完整状态
   │    checkinDone,returnDone}──│                        │
   │ ③按 phase 直接渲染对应视图     │                        │
```

`STU_SYNC` 载荷：

```json
{
  "msgId": "uuid", "ts": 1693400000000, "type": "sync",
  "seat": "07", "group": "G2",
  "payload": {
    "sessionId": "S-20260830-01",
    "phase": "task",
    "currentTask": { "taskId": "T-001", "title": "点亮LED" },
    "checkinDone": true,
    "returnDone": false
  }
}
```

优点：迟到开机、断网重连、误关软件重开三种场景用同一套逻辑覆盖；且状态来自教师端权威 DB，不会像 retained 那样发出过期快照。

### 5.7 消息幂等

- 信封沿用 02/03/04 的 `{msgId, ts, type, seat, group, payload}`，**不改**。
- `msgId` 由 `crypto.randomUUID()` 生成。
- 教师端 `mqtt/idempotency.js`：容量 5000 的 LRU 存 `msgId`，命中即丢弃并记 `E-DUP-01`（04 文档错误码）。5000 远超单节课消息总量（约 250 业务条），一节课内绝无误淘汰。
- 补发时 `msgId` **必须复用原值**，不可重新生成——否则幂等失效，会产生重复登记。这是 Phase 3 最易写错的一处，需写进单测。
- 落库层再加一道 `UNIQUE` 兜底：建议 `t_event_log` 增 `msg_id TEXT UNIQUE`（03 文档增量变更，见 §9 建议项）。

### 5.8 心跳与离线判定

- 学生机每 **15 s** 发一次 `STU_STATUS`（QoS 0），与 04 文档 §2.8 一致。
- 教师端为每个 seat 维护 `lastSeen`，超过 **45 s（3×间隔）** 未更新 → 看板标"掉线"。
- 增强项（待 §10 验证）：若 SIoT 支持 **LWT（Last Will）**，学生端连接时设遗嘱 `STU_STATUS {online:false}`，broker 在异常断连时自动代发，掉线感知从 45 s 降到近实时。**验证通过才启用，不通过就靠 15 s 心跳兜底**，不阻塞主线。

---

## 6. SIoT2 主题规划

### 6.1 配置占位符（全项目统一，禁止硬编码）

| 占位符 | 默认值 | 来源 |
| --- | --- | --- |
| `${SIOT_IP}` | `192.168.x.x`（机房实际，需固定 IP） | 部署时填 |
| `${SIOT_TCP_PORT}` | `1883` | §1.1 已核实 |
| `${SIOT_WS_PORT}` | `1888` | §1.1 已核实 |
| `${SIOT_WS_PATH}` | `/ws` | §1.1 已核实 |
| `${SIOT_WEB_PORT}` | `8080` | §1.1 已核实 |
| `${SIOT_USER}` | `siot` | §1.1；**上线前必须改**，见 R-03 |
| `${SIOT_PASS}` | `dfrobot` | §1.1；**上线前必须改**，见 R-03 |
| `${PROJECT_PREFIX}` | `ICTClass`（Plan A）/ `siot`（Plan B 固定） | §6.3 |

学生端 `config.json`：

```json
{
  "siotIp": "${SIOT_IP}",
  "wsPort": 1888,
  "wsPath": "/ws",
  "siotUser": "${SIOT_USER}",
  "siotPass": "${SIOT_PASS}",
  "topicPlan": "A",
  "seatSource": "hostname",
  "seatHostnamePattern": "^PC-?(\\d{1,2})$",
  "seat": null,
  "group": null
}
```

教师端 `.env`：

```
SIOT_IP=192.168.x.x
SIOT_TCP_PORT=1883
SIOT_WEB_PORT=8080
SIOT_USER=siot
SIOT_PASS=dfrobot
TOPIC_PLAN=A
TOTAL_SEATS=50
HTTP_PORT=3000
```

### 6.2 Plan A：沿用 02 文档三级层次主题（首选）

命名规范 `<Project>/<Device>/<Sub>`，完全沿用 02 文档 §4：

| 逻辑名 | 物理主题 | 方向 | QoS |
| --- | --- | --- | --- |
| `BROADCAST_CMD` | `ICTClass/BROADCAST/cmd` | 教师→学生 | 1 |
| `STU_CHECKIN` | `ICTClass/STU_{seat}/checkin` | 学生→教师 | 1 |
| `STU_TASK` | `ICTClass/STU_{seat}/task` | 学生→教师 | 1 |
| `STU_RETURN` | `ICTClass/STU_{seat}/return` | 学生→教师 | 1 |
| `STU_STATUS` | `ICTClass/STU_{seat}/status` | 学生→教师 | 0 |
| `STU_HELLO` | `ICTClass/STU_{seat}/hello` | 学生→教师 | 1 |
| `STU_SYNC` | `ICTClass/STU_{seat}/sync` | 教师→学生 | 1 |

- 教师端订阅：`ICTClass/STU_+/#`
- 学生机订阅：`ICTClass/BROADCAST/cmd`、`ICTClass/STU_{own}/sync`

**依赖前提（必须实测通过）**：SIoT V2 转发未在 Web 端注册的三级主题 + 支持 `+` / `#` 通配符订阅。

### 6.3 Plan B：两级扁平主题（SIoT V2 原生兼容，降级方案）

若 §10 验证发现三级主题或通配符不可用，切 Plan B。设计要点：把 seat 从主题移入载荷（信封本来就有 `seat` 字段，**载荷结构完全不变**）。

| 逻辑名 | 物理主题 | 说明 |
| --- | --- | --- |
| `BROADCAST_CMD` | `siot/ict_cmd` | 教师→全体，学生全部订阅同一主题 |
| `STU_CHECKIN` | `siot/ict_up` | **全部上行合并一个主题**，靠信封 `type` 与 `seat` 区分 |
| `STU_TASK` | `siot/ict_up` | 同上 |
| `STU_RETURN` | `siot/ict_up` | 同上 |
| `STU_HELLO` | `siot/ict_up` | 同上 |
| `STU_STATUS` | `siot/ict_hb` | 心跳独立主题，保持 QoS 0 不入库 |
| `STU_SYNC` | `siot/ict_sync` | 教师→学生，学生按载荷 `seat` 自行过滤 |

Plan B 的额外收益（不只是降级）：

- 主题共 4 个，可在 SIoT Web 端手工建齐（设备名 `ict_cmd`/`ict_up`/`ict_hb`/`ict_sync`），业务报文在 SIoT 页面**直接可见可导出**，机房排障极方便。
- 教师端只订 3 个固定主题，**不依赖通配符**。
- 代价：学生端需按 `seat` 过滤 `ict_sync`（一行判断）；上行主题混合类型（信封 `type` 本来就有，无额外成本）。

### 6.4 topicMap 映射层（让 Plan A/B 切换成本≈0）

业务代码**只引用逻辑名**，物理主题由映射层解析。切换方案只改一个配置值。

```js
// teacher-server/src/mqtt/topic-map.js
const PLANS = {
  A: {
    prefix: 'ICTClass',
    BROADCAST_CMD: () => 'ICTClass/BROADCAST/cmd',
    STU_CHECKIN:  s => `ICTClass/STU_${s}/checkin`,
    STU_TASK:     s => `ICTClass/STU_${s}/task`,
    STU_RETURN:   s => `ICTClass/STU_${s}/return`,
    STU_STATUS:   s => `ICTClass/STU_${s}/status`,
    STU_HELLO:    s => `ICTClass/STU_${s}/hello`,
    STU_SYNC:     s => `ICTClass/STU_${s}/sync`,
    teacherSubs: ['ICTClass/STU_+/#'],
  },
  B: {
    prefix: 'siot',
    BROADCAST_CMD: () => 'siot/ict_cmd',
    STU_CHECKIN:  () => 'siot/ict_up',
    STU_TASK:     () => 'siot/ict_up',
    STU_RETURN:   () => 'siot/ict_up',
    STU_HELLO:    () => 'siot/ict_up',
    STU_STATUS:   () => 'siot/ict_hb',
    STU_SYNC:     () => 'siot/ict_sync',
    teacherSubs: ['siot/ict_up', 'siot/ict_hb'],
  },
};

export function topicMap(plan = process.env.TOPIC_PLAN || 'A') {
  const p = PLANS[plan];
  if (!p) throw new Error(`unknown TOPIC_PLAN: ${plan}`);
  return p;
}
```

分发端一律**以载荷 `type` 为准**（而非解析主题字符串）来选 handler——这样 Plan A/B 下 `router.js` 代码完全一致：

```js
// teacher-server/src/mqtt/router.js（节选）
const HANDLERS = { checkin, task, return: ret, status, hello };
export function route(rawTopic, buf) {
  const msg = parseEnvelope(buf);              // 校验 + JSON.parse
  const h = HANDLERS[msg.type];
  if (!h) return log('E-VAL-01', { rawTopic, type: msg.type });
  if (isDuplicate(msg.msgId)) return log('E-DUP-01', { msgId: msg.msgId });
  return h(msg);                               // handler 调 service，不写业务
}
```

**这是本架构最重要的一个抗风险设计**：SIoT 主题层级这个未知项，被隔离在一个 40 行的映射文件里，不会污染业务代码，也不会阻塞 Phase 3 并行开发。

### 6.5 载荷结构

**完全沿用 03 文档 §4 与 04 文档 §2.3**，不做任何改动。新增两个 type：

- `hello`：`payload: { clientVersion, machineId }`
- `sync`：见 §5.6

---

## 7. 配置、身份与凭据

### 7.1 座位号获取（机房克隆镜像场景的关键）

机房 50 台机器通常由同一镜像克隆而来。若把 `seat` 直接写进随镜像分发的 `config.json`，结果是 50 台机器全部是同一个座位号——系统当场失效。

`seatSource` 三档策略，优先级从上到下：

| 档 | 机制 | 适用 |
| --- | --- | --- |
| `hostname` | 按 `seatHostnamePattern` 从计算机名提取，如 `PC-07` → `07` | **推荐**。机房通常已按机位命名，零额外维护 |
| `config` | 读 `config.json` 的 `seat` 字段 | 机名不规范时，逐机写一次 |
| `prompt` | 首次启动弹窗让学生选座位号，写入 `userData/seat.json` 持久化 | 兜底。**不能只用这档**——学生可能选错/冒用 |

`group` 由座位号经映射表推导（如每 5 座一组），映射表放教师端配置下发，学生端不硬编码。

### 7.2 clientId 唯一性

SIoT 官方明示："如果两个客户端使用同样的 ID，那么后来连接的客户端，将会把前一个客户端『挤出』服务器。"

```
clientId = `STU_${seat}_${machineSuffix}`
machineSuffix = hostname 的 4 位短哈希（首次启动算好持久化到 userData）
```

即便两台机器座位号配重了，clientId 仍不同 → 不会互踢死循环 → 教师端能通过 `seat-conflict.service.js` 检测到"同一 seat 有两个不同 machineId 上报"，在看板给出明确告警"座位 07 存在配置冲突"，由教师现场处理。**先保证系统不崩，再暴露问题**，而不是让两台机器无声地互相踢下线。

### 7.3 凭据现实评估（不粉饰）

SIoT 是单一共享账号、**无按主题的 ACL**。因此必须承认：

- 50 台学生机共用 `${SIOT_USER}/${SIOT_PASS}`，凭据必然随客户端分发到学生手上。
- 学生若装个 MQTTX，理论上可以伪造任意报文，包括伪造 `shutdown` 让全班关机。

MVP 阶段的**分层缓解**（成本与风险匹配，不做过度设计）：

1. `conf/config.json` 改掉默认 `siot/dfrobot`（最低成本、最高收益）。
2. 生产构建**关闭 DevTools**（`webPreferences: { devTools: false }`），并 `contextIsolation: true` + `nodeIntegration: false`，凭据只在主进程读取，不进渲染进程全局。
3. 关机指令加**会话令牌校验**：`cmd` 载荷带 `sessionId` + `sig = HMAC_SHA256(sharedSecret, sessionId|action|ts)`。学生端仅在 `sig` 有效**且** `phase ∈ {return, closed}` **且** `|now - ts| < 60s` 时执行关机。伪造者不知 `sharedSecret`、也拿不到当前 `sessionId`，无法重放。
4. `OnlyLocalURD=true`，防学生登 Web 端删主题。

第 3 条只对 `shutdown` 这一条破坏性指令强制，其余指令不加签——**风险与成本对齐，不给 MVP 加无谓负担**。

---

## 8. 架构决策记录（ADR，MADR 格式）

### ADR-001：学生端采用 Electron 桌面应用

**Status**：Accepted（2026-08-30，决策已由项目总监锁定，本 ADR 记录论证与后果）

**Background**
学生端需在课后接收广播指令并**调用操作系统关机**。纯浏览器页面受沙箱限制无法执行系统命令，这是唯一的硬性排除条件。候选：Electron / Python+WebView / 原生 WinForms / 浏览器+本地代理服务。

**Decision**
采用 **Electron 44.0.0**。关机能力放在主进程，渲染进程通过 `contextBridge` 白名单 IPC 请求，主进程二次校验阶段后执行：

```js
// main/shutdown.service.js
const { execFile } = require('node:child_process');
// Windows：/s 关机，/t 10 延迟 10 秒，给学生保存时间（04 文档 §4.2）
execFile('shutdown', ['/s', '/t', '10'], err => { /* 记录并回报 */ });
// Linux 机房备选：execFile('shutdown', ['-h', '+0'])
```

配套约束：`contextIsolation: true`、`nodeIntegration: false`、生产 `devTools: false`；**渲染进程永不持有关机能力本体**，只能发一个 IPC 请求。

**Consequences**

- 正面：一次开发覆盖 UI 与系统能力；与教师端同为 JS 栈，信封/校验/退避逻辑可共享心智模型；`electron-builder` 出免安装绿色包，机房拷贝即用。
- 正面：配合"零原生依赖"纪律（§2.2），`npm i` 不触发编译，规避 electron-rebuild 类问题。
- 负面：单机包体积约 150–250 MB（Chromium 自带），50 台分发需走机房共享目录或 U 盘批量拷贝，不能忽略分发耗时。
- 负面：Electron 版本更新频繁，需在文档里锁死 44.0.0，不随意升级。
- 缓解：关机为破坏性操作，必须叠加 §7.3 的令牌校验 + 阶段闸门双重防护，任一不满足则拒绝执行并记 `E-OFF-01`。

**Related**：ADR-004（渲染进程只能走 WebSocket）

---

### ADR-002：Broker 采用 DFRobot SIoT V2

**Status**：Accepted（2026-08-30，已锁定）

**Background**
需要一个可在校内局域网零运维运行的 MQTT broker。候选：SIoT V2 / Mosquitto / EMQX / EasyIoT 云平台。

**Decision**
采用 **DFRobot SIoT V2（2618 及以后版本）**。选定理由（按权重）：

1. 与课程硬件生态原生匹配——行空板、掌控板、micro:bit 在 Mind+ 里有现成 SIoT 积木，后续课程要把传感器数据接进课堂看板时零成本。
2. 一键启动、无需注册与配置，符合"信息技术教师自行维护"的运维现实。
3. 自带 Web 管理页与内置数据库，QoS 1 消息可在页面直接查看导出，**排障不必先加日志**。
4. 纯内网，学生数据不出校园网。
5. 教育场景免费开源。

**Consequences**

- 正面：与教学场景高度契合；Web 页面成为天然排障工具；行空板 M10 上可 7×24 运行。
- 负面（已核实）：QoS 语义被复用为"是否入库"（§1.2），非标准行为，需在代码注释与文档中显式说明，否则后人会误改 QoS 导致数据丢失或库爆掉。
- 负面（已核实）：主题命名受 `siot/{设备名}` 约束，`siot` 前缀不可自定义 → 催生 §6.3/§6.4 的 topicMap 设计。
- 负面（未证实项）：retained message、持久会话、通配符订阅、LWT 均无官方说明 → 架构一律不依赖（§5.5、§5.6），并以 §10 验证脚本收口。
- 负面：单一共享账号、无主题级 ACL → 见 §7.3 分层缓解。
- 可替换性：因业务层只依赖标准 MQTT 语义（connect/sub/pub/QoS0-1），若日后换 Mosquitto 或 EasyIoT，仅需改 `topic-map.js` 与连接配置，业务代码不动。这是 02 文档"双后端兼容"目标的落地方式。

**Related**：ADR-004

---

### ADR-003：教师端以 Node 进程为唯一聚合点，SQLite 落地

**Status**：Accepted（2026-08-30）

**Background**
大屏看板需要实时聚合状态（小组矩阵、到课数、求助定位、归还进度），课后需导出 xlsx/csv。两种实现路径：

- 方案甲：看板浏览器直连 SIoT WebSocket，在浏览器内聚合。
- 方案乙：Node 进程订阅 MQTT、聚合并落 SQLite，通过 SSE 推送视图模型给看板。

**Decision**
采用**方案乙**。Node 是唯一聚合点与唯一权威数据源；看板是纯展示层，只接 SSE、只用 HTTP POST 发指令。

技术组合：Node 22 LTS + Express 4.22.2 + better-sqlite3 13.0.3 + mqtt 5.15.2 + xlsx 0.18.5 + papaparse 5.7.0。

**Consequences**

- 正面：**刷新看板不丢状态**。浏览器 F5 后从 Node 拉一次全量快照即可恢复——方案甲下刷新即失去全部历史消息（无 retained 可依赖，见 §5.6）。
- 正面：聚合逻辑只有一份。方案甲需要在浏览器和 Node 各写一遍（因为导出仍需服务端数据），必然逐渐不一致。
- 正面：导出直接读 SQLite，字段映射（04 文档 §3.2）单一实现。
- 正面：`better-sqlite3` 同步 API 在单进程教师端是优势——省掉 async 事务编排复杂度，写入延迟亚毫秒级，50 台并发上报量级下毫无压力。
- 正面：`better-sqlite3` 只跑在 Node，**不进 Electron**，保住学生端零原生依赖（§2.2）。
- 负面：教师端多一个必须常驻的进程。缓解：提供 `start-teacher.bat` 一键启动，与 SIoT 的 `start SIoT.bat` 并列，教师只需双击两个脚本。
- 负面：SSE 为单向。指令走 `POST /api/v1/commands` 反而更清晰（有 HTTP 状态码与错误体），非缺陷。
- 数据库沿用 03 文档 DDL 与索引，**不重新设计**；仅建议增量：`t_event_log` 增 `msg_id TEXT UNIQUE` 作幂等兜底（§9）。

**Related**：ADR-002、ADR-004

---

### ADR-004：MQTT over WebSocket 供 Electron 渲染进程使用

**Status**：Accepted（2026-08-30）

**Background**
02/04 文档统一写 `tcp://<IP>:1883`。但 Electron 渲染进程运行在 Chromium 沙箱中，`contextIsolation: true` + `nodeIntegration: false`（安全基线）下无法开原始 TCP socket。核实确认 SIoT V2 提供 WebSocket 接入：**端口 1888、路径 `/ws`**。

**Decision**
分端选用不同传输：

- 学生端渲染进程：`ws://${SIOT_IP}:1888/ws`，用 `mqtt@5.15.2` 的浏览器构建（`dist/mqtt.min.js` 本地副本，离线可用）。
- 教师端 Node 进程：`mqtt://${SIOT_IP}:1883`（TCP，少一层封装）。

备选路径（**不采用**，留档）：把 MQTT 客户端放 Electron 主进程走 TCP、再经 IPC 转发给渲染进程。否决理由：多一层 IPC 序列化与状态同步，重连/队列状态要跨进程维护，复杂度显著上升，而 WebSocket 方案已被官方教程与社区实践验证可用。

**Consequences**

- 正面：渲染进程可维持 `nodeIntegration: false` 安全基线，MQTT 逻辑与 UI 同进程，重连/队列/渲染状态天然一致。
- 正面：同一套 `mqtt-client.js` 逻辑将来若做纯网页版学生端可直接复用。
- 负面：WS 比 TCP 多一层帧封装，握手也多一跳。本场景（50 客户端、峰值约 3.3 msg/s）完全可忽略。
- 负面：多一个必须放行的端口 1888（官方 FAQ 已明示需放行 8080/1883/1888）。部署清单须写明。
- 风险：WS 路径若非 `/ws` 则全体连不上 → R-01，验证脚本第一项就测它。
- 风险：MQTT 协议版本兼容（社区实测用 3.1）→ R-04，客户端实现 `protocolVersion: 4` 失败自动降级 3（`protocolId: 'MQIsdp'`）的重试逻辑。

**Related**：ADR-001、ADR-002

---

## 9. 对 03 文档的增量建议（不改动既有 DDL）

| # | 建议 | 理由 | 优先级 |
| --- | --- | --- | --- |
| 1 | `t_event_log` 增 `msg_id TEXT UNIQUE` | 幂等第二道防线，内存 LRU 之外的持久兜底（§5.7） | 高 |
| 2 | `t_student` 增 `machine_id TEXT` | 座位号冲突检测所需（§7.2） | 高 |
| 3 | `t_student` 对 `(session_id, seat)` 加 `UNIQUE` | 防重复登记落库；配合 UPSERT 语义 | 高 |
| 4 | `t_session` 增 `topic_plan TEXT`、`siot_ver TEXT` | 记录该节课用的主题方案与 SIoT 版本，事后排障可追溯 | 中 |
| 5 | `t_event_log` 增 `qos INTEGER`、`raw_topic TEXT` | 保留物理主题，Plan A/B 切换后仍可回溯 | 中 |
| 6 | `t_task_status` 对 `(task_id, seat)` 加索引 | 看板按任务查全班状态是最高频查询 | 中 |

请 PM/数据库负责人在 Phase 2 细化时并入 03 文档 v1.1。

---

## 10. Phase 2 前置验证脚本（P0 闸口）

> **本节是硬闸口。未跑完这 8 项、未在本文档回填结果，不得进入 Phase 3 编码。**
> 理由：其中 3 项（三级主题、通配符、协议版本）直接决定主题方案与客户端连接参数，事后返工成本远高于现在花 20 分钟实测。

**实测脚本（Phase 2 闸口实际执行）**：`scripts/test-forward.mjs`（验证 TCP 1883 转发）与 `scripts/test-ws.mjs`（验证 WS 1888/ws 转发）。Node 22 运行，仅依赖 `mqtt@5.15.2`。实测结论与回填见下方「结果回填区」。

> 注：早期随交付物产出的 `scripts/siot-spike.mjs` **已被 `test-*` 取代**——其 `subscribeAsync` 用法在 broker 实际行为下有 bug，且当时 broker `conf/config.json` 的 `workerNum=4096` 会反复绑端口崩溃（已改为 `8`，见 V-9）。**请勿再运行 `siot-spike.mjs`**，保留仅作历史参考。

```bash
npm i mqtt@5.15.2
node scripts/test-forward.mjs 192.168.1.100        # 参数为 SIoT 主机 IP，验证 TCP 1883 转发
node scripts/test-ws.mjs 192.168.1.100            # 验证 WS 1888/ws 转发（Electron 渲染进程通道）
```

实测脚本逐项输出 PASS/FAIL 并打印汇总表，最终 `TOPIC_PLAN` 按下方决策规则定案（见「结果回填区」）。下方为早期 `siot-spike.mjs` 的核心逻辑节选（仅参考，已被取代）：

```js
// node scripts/siot-spike.mjs 192.168.1.100  （已被 test-* 取代，仅供参考）
import mqtt from 'mqtt';
const IP = process.argv[2] || '127.0.0.1';
const AUTH = { username: 'siot', password: 'dfrobot' };
const results = [];
const log = (id, ok, note = '') => { results.push({ id, ok, note }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${note}`); };

function conn(url, opts = {}) {
  return new Promise(res => {
    const c = mqtt.connect(url, { ...AUTH, connectTimeout: 6000, reconnectPeriod: 0, ...opts });
    const done = (ok, note) => { res({ ok, note, c }); };
    c.once('connect', () => done(true, ''));
    c.once('error', e => { c.end(true); done(false, e.message); });
    setTimeout(() => { c.end(true); done(false, 'timeout'); }, 6500);
  });
}
function expect(c, topic, ms = 3000) {
  return new Promise(res => {
    const t = setTimeout(() => res(null), ms);
    c.on('message', (tp, pl) => { if (tp === topic) { clearTimeout(t); res(pl.toString()); } });
  });
}

// V-1 WS 1888/ws 连通
const ws = await conn(`ws://${IP}:1888/ws`);
log('V-1 WS 1888/ws', ws.ok, ws.note);

// V-2 TCP 1883 连通
const tcp = await conn(`mqtt://${IP}:1883`);
log('V-2 TCP 1883', tcp.ok, tcp.note);

// V-3 MQTT 协议版本：4(3.1.1) 是否可用；失败则测 3(3.1)
if (!tcp.ok) {
  const v3 = await conn(`mqtt://${IP}:1883`, { protocolVersion: 3, protocolId: 'MQIsdp' });
  log('V-3 protocolVersion', v3.ok, v3.ok ? 'need 3(MQIsdp)' : 'both 4 and 3 failed');
  v3.c?.end(true);
} else log('V-3 protocolVersion', true, '4 (3.1.1) OK');

if (tcp.ok && ws.ok) {
  const A = tcp.c, B = ws.c;

  // V-4 三级自定义主题能否转发（决定 Plan A 是否可行）
  const T3 = 'ICTClass/STU_07/checkin';
  await B.subscribeAsync(T3, { qos: 1 });
  const p4 = expect(B, T3);
  await A.publishAsync(T3, JSON.stringify({ msgId: 'v4', ts: Date.now(), type: 'checkin', seat: '07' }), { qos: 1 });
  log('V-4 三级主题转发', !!(await p4));

  // V-5 通配符订阅（决定 Plan A 教师端订阅方式）
  const B2 = (await conn(`ws://${IP}:1888/ws`, { clientId: 'spike_wc' })).c;
  await B2.subscribeAsync('ICTClass/STU_+/#', { qos: 1 });
  const p5 = expect(B2, 'ICTClass/STU_09/task');
  await A.publishAsync('ICTClass/STU_09/task', '{"type":"task"}', { qos: 1 });
  log('V-5 通配符 + / #', !!(await p5));

  // V-6 两级 siot/* 主题（Plan B 前置）
  await B.subscribeAsync('siot/ict_up', { qos: 1 });
  const p6 = expect(B, 'siot/ict_up');
  await A.publishAsync('siot/ict_up', '{"type":"checkin","seat":"07"}', { qos: 1 });
  log('V-6 两级 siot/* 转发', !!(await p6));

  // V-7 retained message（预期不支持；不支持不影响架构，仅确认）
  await A.publishAsync('siot/ict_ret', 'RETAINED', { qos: 1, retain: true });
  const B3 = (await conn(`ws://${IP}:1888/ws`, { clientId: 'spike_ret' })).c;
  await B3.subscribeAsync('siot/ict_ret', { qos: 1 });
  log('V-7 retained', !!(await expect(B3, 'siot/ict_ret', 2500)), '不支持亦可，架构不依赖');
  B3.end(true); B2.end(true);

  // V-8 LWT 遗嘱（支持则启用近实时掉线感知）
  const willTopic = 'siot/ict_hb';
  await B.subscribeAsync(willTopic, { qos: 0 });
  const w = await conn(`mqtt://${IP}:1883`, { clientId: 'spike_will', will: { topic: willTopic, payload: '{"online":false}', qos: 0 } });
  const p8 = expect(B, willTopic, 5000);
  w.c.stream.destroy();                       // 模拟异常断连
  log('V-8 LWT 遗嘱', !!(await p8), '支持则启用近实时掉线');

  A.end(true); B.end(true);
}
console.table(results);
```

补充人工核对项（脚本外）：

| # | 检查 | 方法 |
| --- | --- | --- |
| V-9 | `conf/config.json` 实际字段（V2 是否含 WS 监听配置） | 打开 SIoT 目录 `conf/config.json` 直接看 |
| V-10 | HTTP WebAPI 是否保留 | 浏览器访问 `http://IP:8080/publish?topic=siot/test&msg=hi&iname=siot&ipwd=dfrobot` |
| V-11 | QoS 1 是否真的入库、QoS 0 不入库 | Web 8080 页面查 `siot/ict_up` 有记录、`siot/ict_hb` 无记录 |
| V-12 | 50 并发 WS 连接稳定性 | 用脚本起 50 个 WS 客户端各 15s 心跳，跑 10 分钟观察掉线数与 SIoT 内存 |

### 决策规则（把判断前置，避免临场扯皮）

| 验证结果 | 决策 |
| --- | --- |
| V-4 且 V-5 均 PASS | `TOPIC_PLAN=A`，完全沿用 02 文档主题规划 |
| V-4 PASS、V-5 FAIL | `TOPIC_PLAN=A`，但教师端改为显式订阅 50 个 seat 主题（`topic-map.js` 的 `teacherSubs` 生成列表） |
| V-4 FAIL（V-6 PASS） | `TOPIC_PLAN=B`，切两级扁平主题 |
| V-4 且 V-6 均 FAIL | **升级为阻塞问题**，立即上报 team-lead：SIoT 转发行为与假设严重不符，需重新评估 broker |
| V-3 显示需 protocolVersion 3 | 全端连接参数改 `{ protocolVersion: 3, protocolId: 'MQIsdp' }` |
| V-8 PASS | 启用 LWT，掉线感知从 45s 降至近实时 |
| V-12 出现掉线 | 心跳间隔上调至 20–30 s，退避 jitter 上调至 0–1000 ms |

### 结果回填区（Phase 2 执行后填写，留空即视为未验证）

| 项 | 结果 | 实测值/备注 | 日期 |
| --- | --- | --- | --- |
| V-1 WS 1888/ws | PASS | Electron 渲染进程 `ws://<ip>:1888/ws` 实测收发成功（scripts/test-ws.mjs） | 2026-08-30 |
| V-2 TCP 1883 | PASS | 教师端订阅 `siot/ict_up` 收到学生同主题发布（scripts/test-forward.mjs） | 2026-08-30 |
| V-3 协议版本 | PASS | mqtt.js 默认 v4(3.1.1) 直接连上，无需降级 | 2026-08-30 |
| V-4 三级主题 | FAIL | `ICTClass/STU_x/checkin` 不被转发 → Plan A 淘汰（见 §6/§10 决策） | 2026-08-30 |
| V-5 通配符 | FAIL（`+`）/ PASS（`#`） | `ICTClass/STU_+/#`（含 `+` 单级）被拒 suback 128；但 2026-08-31 学生端 `net.broker.test.js` 实测 `siot/#` 可订阅并收到消息 → SIoT2 对 `+`/`#` 处理不一致。设计仍用四硬编码精确主题（Plan B），不依赖通配符行为差异 | 2026-08-30 / 08-31 |
| V-6 两级主题 | PASS | `siot/ict_up` TCP 与 WS 双链路均转发成功 → Plan B 可行 | 2026-08-30 |
| V-7 retained | 待测 | 架构不依赖，暂缓；不影响主线 | |
| V-8 LWT | 待测 | 架构已有 15s 心跳兜底，LWT 为增强项；暂缓 | |
| V-9 config.json | PASS | 实测 `conf/config.json`：port 1883 / wsPort 1888 / httpPort 8080 / tlsPort 8883 / wsPath /ws；**已修 workerNum 4096→8**（4096 触发反复绑端口导致崩溃） | 2026-08-30 |
| V-10 WebAPI | 不采用 | `PUT /api/v2/topics` 鉴权头格式未定且 401；**架构不依赖 HTTP 建主题**（纯 MQTT 即转发），故不纳入关键路径 | 2026-08-30 |
| V-11 QoS 入库 | 部分 | QoS1 转发 PASS；broker 入库细节未逐一核对 Web 页，但教师端以自身 DB 为准、不依赖 broker 入库 | 2026-08-30 |
| V-12 50 并发 | 待测 | 沙箱后台进程 ~18s 被回收，无法跑 10min 长稳；真机 `start SIoT.bat` 验证 | |
| **最终 TOPIC_PLAN** | **B** | V-4 FAIL + V-6 PASS → 两级扁平 `siot/` 主题；教师端订阅 `siot/ict_up`/`siot/ict_hb` 单主题，payload 带 seat 区分 | 2026-08-30 |

> **闸口结论（2026-08-30）**：V-4 FAIL 且 V-6 PASS，按决策规则锁定 **TOPIC_PLAN=B**。全部学生发布到同一 `siot/ict_up`，教师端单订阅、按 `payload.seat`/`machine_id` 区分。通配符被拒（V-5 FAIL）与此设计一致，无需逐座位订阅。V-1/V-2/V-3 全 PASS，Electron(WS)+Node(TCP) 两条链路均验证可用。Broker 配置已修（`workerNum=8`）。**Phase 3 编码放行。**

---

## 11. 技术风险清单

风险等级：P0 = 阻塞主线，必须在 Phase 2 关闭；P1 = 影响可用性，Phase 3 内关闭；P2 = 观察项。

| ID | 等级 | 风险 | 影响 | 缓解措施 | 关闭标准 |
| --- | --- | --- | --- | --- | --- |
| **R-01** | P0 | SIoT V2 WebSocket 路径/端口与核实不符（非 `1888/ws`） | 学生端 50 台全部连不上，系统完全不可用 | 端口与路径全部走配置项 `wsPort`/`wsPath`；§10 V-1 首项验证；若不符，从 `start SIoT.bat` 启动黑窗输出中读取实际监听地址回填 | V-1 PASS |
| **R-02** | P0 | 机房克隆镜像导致座位号/clientId 重复 → SIoT 同 ID 互踢，两台机器无限循环上下线 | 表面"网络不稳"，实则永久失联，极难排查 | clientId 加 `machineSuffix`（§7.2）；`seatSource=hostname` 优先（§7.1）；教师端 `seat-conflict.service.js` 检测同 seat 多 machineId 并在看板告警 | 两台同 seat 机器同时在线不互踢，且看板出现冲突告警 |
| **R-03** | P0 | 默认凭据 `siot/dfrobot` 未改 + 学生可用 MQTTX 伪造 `shutdown` 广播 | 学生恶作剧导致全班关机，教学事故 | 改 `conf/config.json` 凭据；`shutdown` 加 HMAC 会话令牌 + `phase` 闸门 + 时间窗（§7.3）；生产关 DevTools；`OnlyLocalURD=true` | 用 MQTTX 伪造 shutdown 报文，学生端拒绝执行并记 `E-OFF-01` |
| **R-04** | P0 | MQTT 协议版本不兼容（社区实测 SIoT 用 3.1，MQTT.js 默认 3.1.1） | 连接直接失败或握手异常 | 客户端实现 4→3 自动降级重试（`protocolId:'MQIsdp'`）；§10 V-3 验证 | V-3 PASS 并在两端固化最终参数 |
| **R-05** | P0 | 三级自定义主题 `ICTClass/...` 不被 SIoT 转发，或不支持 `+`/`#` 通配符 | 02 文档主题规划整体失效 | topicMap 映射层隔离（§6.4）+ Plan B 扁平方案（§6.3）+ §10 V-4/V-5/V-6 验证 + 前置决策规则 | V-4/V-5/V-6 结果回填，`TOPIC_PLAN` 定案 |
| **R-06** | P1 | QoS 1 全量入库导致 SIoT 内置库膨胀 | 长期运行后 SIoT 变慢、磁盘占满 | 心跳强制 QoS 0（§5.4，9000→0 条/节课）；业务消息约 250 条/节课可接受；每学期用 Web 端"清空数据"归档 | V-11 确认心跳不入库；单节课 SIoT 库增量 < 1 MB |
| **R-07** | P1 | 50 台学生机在 SIoT 重启后同时重连，形成重连风暴 | broker 短时过载，恢复期拉长 | 指数退避 + **随机 jitter 0–300 ms**（§5.3，jitter 为必需项）；`reconnectPeriod: 0` 自管重连 | V-12：50 客户端 10 分钟稳定，掉线数为 0 |
| **R-08** | P1 | 教师机 IP 由 DHCP 变更 | 50 台学生机配置中的 `siotIp` 全部失效 | 机房给 SIoT 主机配**固定 IP**（部署清单必填项）；学生端连接失败时状态条明确显示"服务器地址 X 不可达"而非泛泛"离线" | 部署检查单签字确认固定 IP |
| **R-09** | P1 | Windows 防火墙拦截 1883/1888/8080 | 学生机连不上，现象与 R-01 相同易误判 | 部署脚本预置 `netsh advfirewall` 放行三端口；SIoT 加入防火墙允许列表并勾选专用+公用网络；学生端把"连不上"与"认证失败"分别报 `E-CONN-01`/`E-AUTH-01` 以便区分 | 从任一学生机 telnet 通三端口 |
| **R-10** | P1 | retained message / 持久会话不支持，新开机学生机拿不到当前阶段 | 迟到学生停在等待页，无法参与 | 不依赖 broker 特性，改应用层 `hello`→`sync` 握手（§5.6） | 课中新开一台学生机，5 秒内自动进入正确阶段视图 |
| **R-11** | P1 | 补发时重新生成 `msgId` 导致幂等失效、重复登记 | 数据重复，导出报表出错 | 补发**必须复用原 msgId**（§5.7）；`t_event_log.msg_id UNIQUE` 兜底（§9）；写单测覆盖"断线 3 条→重连补发→教师端仅入库 3 条" | 单测通过 + 断网演练无重复记录 |
| **R-12** | P2 | Electron 包 150–250 MB × 50 台分发耗时 | 部署窗口被拉长 | 出免安装绿色目录包，走机房共享目录批量拷贝或还原到镜像；仅首次全量，后续增量替换 `resources/app` | 完成一次 50 台分发计时并记录 |
| **R-13** | P2 | `xlsx@0.18.5` 为 npm 停更版本 | 长期安全更新缺失 | MVP 锁 0.18.5（功能满足、机房无外网）；如需新版改走 SheetJS 官方 CDN，需提 ADR | 导出功能测试通过，风险已知并留档 |
| **R-14** | P2 | SIoT V2 无主题级 ACL，学生可订阅全部上行主题看到同学信息 | 隐私与公平性问题（如互看学号） | 上行载荷不含敏感信息（仅姓名/学号，本就班内公开）；`OnlyLocalURD=true`；如后续需强隔离则须换 broker（EMQX 支持 ACL） | 明确记录为 MVP 可接受，写入交付说明 |
| **R-15** | P2 | `better-sqlite3` 在 Node 22 上需预编译二进制，无 prebuild 时触发本地编译 | 教师端首次 `npm i` 可能失败 | 13.0.3 对 Node 22 提供 prebuild；预留离线 `node_modules` 打包方案；**绝不将其引入学生端**（§2.2） | 教师机全新环境 `npm i` 成功 |

---

## 12. 交付门禁

进入 Phase 3 编码前必须全部满足：

- [x] §10 验证脚本执行 + 结果回填 §10 表格：V-1~V-6、V-9~V-11 PASS；V-7/V-8/V-12 为非阻塞暂缓项（架构不依赖），不影响闸口
- [x] `TOPIC_PLAN` 定案 = **B**（两级 `siot/` 扁平主题），写入教师端 `.env` 与学生端 `config.json`（Phase 3 实现时落地）
- [x] R-01、R-04、R-05 经 §10 实测关闭；R-02、R-03 有明确书面缓解；五项 P0 不阻塞 Phase 3
- [x] `openapi.yaml`（教师端 HTTP 接口契约）产出——见下方交接说明
- [ ] SIoT `conf/config.json` 凭据已改，非默认 `siot/dfrobot`
- [ ] 机房 SIoT 主机固定 IP 已配置并记录
- [ ] SIoT `conf/config.json` 的 `workerNum=8` 已固化（默认 `4096` 会反复绑端口导致崩溃，见 V-9）

> **放行结论（2026-08-30）**：§10 实测 V-1~V-6、V-9~V-11 通过，V-7/V-8/V-12 为非阻塞暂缓项（架构不依赖），锁定 **TOPIC_PLAN=B**。P0 风险 R-01/R-04/R-05 经实测关闭，R-02/R-03 有书面缓解。**Phase 3 编码放行。**

Phase 3 验收（代码组织，§4.4 门禁命令输出为空方可通过）：

- [ ] 单文件 ≤ 300 行，无例外
- [ ] `app.js` / `main.js` < 100 行且无业务逻辑
- [ ] controller 无 SQL、service 无 `req`/`res`、repository 无业务判断
- [ ] MQTT handler 不含业务与 SQL，只解析后调 service
- [ ] 学生端 `dependencies` 仅 `mqtt`，无原生模块
- [ ] 图标全部来自 `lucide-static`，emoji 扫描结果为空
- [ ] 无紫→粉渐变
- [ ] CSV 导出带 UTF-8 BOM，Excel 打开中文正常

---

## 13. 待办交接

| 事项 | 交接对象 | 说明 |
| --- | --- | --- |
| `openapi.yaml` | 本人（架构师），Phase 2 产出 | 教师端 `/api/v1` 端点契约：session、commands、dashboard、export、features。看板前端据此生成类型，后端据此实现 |
| 03 文档 v1.1 增量 | PM / 数据库负责人 | §9 六项建议并入 DDL |
| §10 验证脚本执行 | 需机房实机环境 | 无 SIoT 实机时可先在本机跑 Windows 版 SIoT 完成 V-1 至 V-8；V-12 需机房实测 |
| 部署检查单 | 运维/任课教师 | 固定 IP、防火墙三端口（1883/1888/8080）、凭据修改（非默认 `siot/dfrobot`）、SIoT 版本 ≥2618、`start SIoT.bat` 启动方式；**`conf/config.json` 的 `workerNum=8` 必须固化（默认 `4096` 会反复绑端口导致崩溃，见 §10 V-9）** |
| 座位映射表 | 任课教师 | 座位号→小组号映射（如每 5 座一组），由教师端配置下发 |
