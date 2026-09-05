# 课堂管理系统 - 教师端（Node 聚合服务）

初二信息技术硬件实践课课堂管理系统的教师端：订阅 SIoT2（MQTT TCP 1883），聚合学生机上行，
落 SQLite 权威源，通过 HTTP + SSE 驱动大屏看板，并处理指令下发（开始/下课/任务/复位/关机）。

## 技术栈（锁定）
Node 22 / Express 4.22.2 / better-sqlite3 13.0.3 / mqtt 5.15.2 / xlsx 0.18.5 / papaparse 5.7.0 / cors 2.8.5

## 目录结构
```
teacher/
├── server.js              入口：装配（<100 行，零业务）
├── package.json
├── app-config.json        默认配置（可被环境变量覆盖）
├── src/
│   ├── config.js          配置加载（env > file > 默认）
│   ├── utils.js           ID/HMAC/座位格式化/BOM/日志
│   ├── errors.js          业务错误（errorCode 映射）
│   ├── response.js        统一信封 + asyncHandler + 鉴权
│   ├── db/
│   │   ├── index.js       存储工厂 + 仓储函数
│   │   ├── storage-sql.js SQLite 后端
│   │   └── storage-json.js JSON 降级后端（内存 + 文件）
│   ├── mqtt/
│   │   ├── bridge.js      连接/重连(指数退避+抖动)/发布   [协议 4→3 自动降级]
│   │   └── handlers.js     按 envelope.type 分发 → 写库 + 发 SSE
│   ├── services/          session / command / task / dashboard / export
│   ├── routes/            system / session / task / equipment / command / dashboard / export / legacy
│   ├── sse.js             事件总线 + SSE 客户端管理（revision 环形缓冲）
│   └── monitor.js         在线/离线看门狗
├── seeds/                 seats.json（座位→小组）、equipment.json（器材台账）
├── public/                大屏看板（前端团队在此完善）
├── exports/               导出文件落盘目录（运行时生成）
└── test/selfcheck.js      幂等 + HMAC 最小单测
```

## 启动
```bash
npm install
# 编辑 app-config.json 或环境变量：SIOT_IP / SIOT_USER / SIOT_PASS / HMAC_SECRET 等
npm start
# 打开 http://127.0.0.1:3000  （大屏）  / 健康检查 http://127.0.0.1:3000/api/v1/system/health
```

## 降级说明（重要）
`better-sqlite3` 是唯一原生模块，需预编译二进制。若当前环境缺少编译工具链导致
`require('better-sqlite3')` 失败，服务器**不会崩溃**，会自动降级为「内存 + JSON 文件」
存储（`classroom.db.json`），实现与 SQLite 完全一致的数据接口，保证 server 能起、能 smoke test。
降级时启动日志会打印警告，HTTP `/api/v1/system/health` 的 `db.mode` 字段会显示 `json`。
注意：JSON 降级模式下，进程重启后数据不持久于 SQLite（仍在 .json 文件），生产环境务必确保
better-sqlite3 正常安装。

## SIoT2 不可达时的行为
- 连接走自管指数退避（1→2→4→8→16→30s）+ 0~300ms 随机抖动，后台持续重连。
- 所有 HTTP/SSE/导出功能照常工作（基于本地数据）。
- 指令发布失败返回 `delivered:false`；`shutdown` 在 MQTT 不可达时返回 `503 E-CONN-01`。
- 学生机重连/迟到，经 hello→sync 拿到正确阶段，无需 retained message。

## 关键安全设计
- 关机指令三重校验：阶段闸门（仅 return/closed）+ 归还闸门（全归还或 force）+ HMAC 令牌
  `HMAC_SHA256(HMAC_SECRET, sessionId + ':' + ts)`（60s 时间窗）。学生端伪造报文无法重放。
- 默认监听 0.0.0.0:3000（供教室大屏/局域网访问）。若部署在不受控网络，务必设置
  `ENABLE_AUTH=true` + `TEACHER_TOKEN`，否则任何人可调用关机等敏感接口。

## 运行形态（v4 分离式架构）
```
办公电脑 ──► 预设编辑器 Preset Studio（classroom-mgmt/preset-studio，独立 Electron 应用）
                 班级/活动预设 CRUD + 器材字典 + 导出/导入 .kctpreset（完全离线）
                        │  预设包文件（U盘/网盘 传递）
                        ▼
教室教师机 ──► 本服务（纯 Node：Express + MQTT + SQLite/JSON，HTTP 3000）
                        │ HTTP (0.0.0.0:3000)
                        ▼
             大屏端：教室大屏浏览器打开 http://<教师机IP>:3000
             （预设导入/只读列表/导出备份 + 上课控制 + 活动/计时/锁定）
             学生端：每台学生机 Electron 应用（classroom-mgmt/student，v4 零改动）
```

**预设编辑的唯一入口是办公端 Preset Studio**（`classroom-mgmt/preset-studio`），本服务只负责接收与使用：
- 大屏「预设管理」：**导入预设包**（文件 → 预演：新增/覆盖/跳过 → 确认落库）、只读列表、删除卫生、导出备份。
- 本仓库不再提供编辑器页面（`/editor` 与 Electron 壳已移除）；教师机不再需要 Electron。

```bash
# 教室教师机：
npm install
npm start        # 服务起在 0.0.0.0:3000，教室大屏浏览器打开 http://<教师机IP>:3000
```

## 预设数据模型与流转
- 班级预设：`name / totalSeats / groupSize / note`
- 活动预设：`name / category / equipment[]（eqId/eqName/category/preset）/ taskTemplates[]（title/desc）/ timed / durationSec（默认计时）/ note`
- 开始上课携带 `classPresetId` + `activityPresetId`：班级名/座位数/分组从预设加载；
  器材清单注册进 `t_equipment` 并经 `cmd action=equipment` 广播；任务模板随响应返回给大屏做快捷发布。
- **预设包（v4）**：`.kctpreset` JSON，`shared/preset-package.js` 协议双端共用。
  `POST /api/v1/presets/import`（预演；`?commit=true` 单事务落库）、`GET /api/v1/presets/export`（备份/回迁）。
  合并仲裁按 presetId + updatedAt：新增 / 覆盖 / 跳过（本地较新，保护教室现场修改）。
- 预设 CRUD API：`/api/v1/presets/classes(/:id)`、`/api/v1/presets/activities(/:id)`（保留，供大屏删除等），见 openapi.yaml。

## 活动 / 计时 / 锁定策略（v3）
- **活动 = 任务 + 计时元数据**：发布活动 `POST /sessions/:sid/activities`（source=preset|custom、timed、durationSec）。
- **计时控制** `POST /sessions/:sid/activities/:taskId/timer`：`start|pause|resume|adjust|restart|stop`；
  教师端权威定时，截止自动 `SSE activity.timer(expired)`（大屏提醒）+ `cmd task_timer(expired)`（学生端提醒）。
- **锁定策略** `POST /sessions/:sid/policy`（open | activity）：activity 模式下 task 阶段无进行中活动即锁定学生机
  （`cmd policy`），登记/归还阶段不锁。策略引擎在 上课/阶段变更/活动发布/截止 时自动重算下发。
- 学生端收到 `cmd task_timer` / `cmd policy` 后更新计时器与全屏锁定遮罩；迟到/重连经 sync 恢复。
- 完整状态流转见 `课堂管理系统开发文档/07_功能联动与状态流转设计.md`。

## 自检
```bash
node --check src/*.js src/**/*.js server.js   # 语法检查
npm run selfcheck                            # 幂等 + HMAC 单测
npm run test                                 # selfcheck + routes + preset-pkg + dashboard.dom
npm run smoke                                # 真实 broker 全链路（含预设→器材下发→预设包导入/导出）
# 一键（根目录 classroom-mgmt/run-tests.sh）：快速 10 项 / --full 加真实 broker 冒烟
```
