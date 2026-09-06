# Spec - 初二信息技术硬件实践课课堂管理系统 v1.0

> 生成日期：2026-08-30
> 基于：PRD_v1 + ARCH_v1 + UIUX_v1 + design-tokens.json
> 状态：已确认（Phase 1 三文档用户确认通过）
> 说明：本 Spec 为团队内部契约，后续设计/开发/测试均以其为唯一依据。

---

## 1. 产品定义
- **一句话描述**：以 SIoT2（MQTT+WebSocket）为底座，让学生机自助跑完「课前登记/器材领取 → 课中进度反馈 → 课后归还确认 → 自动关机」全流程，教师大屏一眼掌控到课/器材/进度/求助，替代人工点名与器材统计。
- **目标用户**：初二学生（操作方）、信息教师（监控/管控方）、机房管理员（部署方）。
- **核心问题**：课堂事务性工作（点名、器材统计、进度问询）占用大量教学时间。

## 2. MVP 范围（锁定——不在此列表的功能一律不做）

| 优先级 | 能力域 | 功能 | 验收摘要 |
|--------|--------|------|----------|
| P0 | 课前登记 | 教师「开始上课」→ 学生填信息+领器材登记 | 大屏实时到课率/未登记名单/器材领取率 |
| P0 | 课中互动 | 教师发布任务；学生点「进行中/已完成/求助」 | 求助组大屏 ≤1s 高亮置顶 |
| P0 | 课后收尾 | 教师「下课」→ 学生归还确认 → 全确认后自动关机 | 未全确认可提醒/强制关机 |
| P0 | 数据导出 | 一键导出登记表/任务记录/器材使用/事件日志 | xlsx + csv，字段完整 |
| P0 | 断线重连 | MQTT 断线指数退避重连 + 关键状态幂等补发 | 断网恢复后无丢失 |
| P1 | 增强 | 座位冲突检测告警、RICE 统计、历史课堂对比 | 可延后 |

## 3. 明确不做（Out-of-Scope — 锁定）

| 不做的功能 | 原因 | 何时考虑 |
|------------|------|----------|
| 屏幕抓拍/监控 | 隐私与定位不符（无摄像头/麦克风） | — |
| 人脸考勤 | 隐私+硬件依赖 | — |
| 多教师账号体系 | MVP 单教师 | v2 |
| 多班级并行同屏 | MVP 单课堂 | v2 |
| 公网传输 | 内网闭环要求 | — |
| 历史教学分析平台 | MVP 仅导出 | v2 |
| 电源继电器/RFID 硬件 | 复用现有 PC+SIoT2，零额外硬件 | — |
| 教务系统对接 | 超出范围 | — |
| 屏幕广播/控屏 | 非需求 | — |

## 4. 技术架构（锁定 — 含版本锚定）

> 版本均经 npm registry / 官方文档实查。技术栈由架构师按项目选型，本 Spec 直接锁定。

| 层 | 技术 | 实际版本 | 锁定原因 |
|----|------|----------|----------|
| Broker | DFRobot SIoT V2 | ≥2618 | 用户决策；双击 `start SIoT.bat` 启动 |
| 运行时 | Node.js | 22.x LTS | 实测环境 22.22.2 |
| 学生端 | Electron | **44.0.0** | 机房全 Win10/11（用户确认），用最新版 |
| 学生端 UI | 原生 HTML+CSS+ESM（零构建） | — | 单文件 ≤300 行，免 electron-rebuild |
| 学生端 MQTT | mqtt | 5.15.2 | 纯 JS，无原生依赖 |
| 教师端 | Express | **4.22.2**（不升 5.x） | 只用静态托管+JSON+SSE，5.x breaking 纯摩擦 |
| 教师端 DB | better-sqlite3 | 13.0.3 | 教师端唯一原生模块，不进 Electron |
| 教师端 MQTT | mqtt | 5.15.2 | 聚合点，TCP 1883 或 WS 1888 |
| 导出 | xlsx / papaparse | 0.18.5 / 5.7.0 | 机房可能无外网，走 npm 锁版 |
| 图标 | lucide-static | 最新稳定（离线内联 SVG） | 全项目唯一图标源，禁 emoji |
| 设计 Token | design-tokens.json | v1 | 颜色/字号/间距/图标尺寸唯一来源 |

**关键纪律（Phase 3 不可破）**：
1. 学生端零原生依赖，依赖清单仅 `mqtt`；`better-sqlite3` 绝不进 Electron，学生机本地缓存用 `fs` 写 JSON。
2. Express 锁 4.22.2，升 5.x 须提 ADR。
3. 看板浏览器不直连 MQTT，由教师端 Node 唯一聚合，SSE 推视图模型（F5 不丢状态、聚合逻辑单份、导出读 SQLite）。

## 5. SIoT2 连接与主题规划（锁定物理方案 = Plan B 两级，三级为可选项）

### 5.1 连接参数（配置项，值来自用户提供的实例）
| 参数 | 占位 | 说明 |
|------|------|------|
| broker WS | `ws://${SIOT_IP}:1888/ws` | 学生机（渲染进程只能 WS） |
| broker TCP | `tcp://${SIOT_IP}:1883` | 教师端 Node 聚合用 |
| Web 管理 | `http://${SIOT_IP}:8080` | 排障查看原始报文 |
| 账号/密码 | 用户提供（默认 siot/dfrobot，须改） | NFR-S3 禁用匿名 |
| KeepAlive | 30s | 心跳 |
| protocolId | MQTT.js 默认 3.1.1，**失败自动降级 3.1** | SIoT 社区实测可能为 3.1 |

### 5.2 物理主题（Plan B，两级 `siot/`，不依赖通配符订阅）
| 逻辑名 | 物理主题 | 方向 | QoS | 说明 |
|--------|----------|------|-----|------|
| CMD_BROADCAST | `siot/ict_cmd` | 教师→学生(订阅) | 1 | 全局指令 start/end/task/shutdown/reset |
| STU_UP | `siot/ict_up` | 学生→教师(订阅) | 1 | 业务上行(checkin/task/return)，payload 带 seat/group |
| STU_HB | `siot/ict_hb` | 学生→教师 | 0 | 在线心跳(15s)，不入 SIoT 库 |
| SYNC | `siot/ict_sync` | 双向 | 1 | 学生上线 hello / 教师回 sync 补状态 |

> 说明：SIoT V2 主题前缀 `siot/` 平台固定、不支持通配符订阅（待 Phase 2 用用户提供实例实测确认）。Plan B 所有学生共用 `siot/ict_up`，由 payload.seat 区分，教师端单订阅即可，规避通配符限制。若实测三级主题+通配符可用，经 topicMap 切 Plan A（`ICTClass/STU_{seat}/...`）只改一个 env。

### 5.3 QoS 语义（SIoT V2：QoS=是否入库）
- 业务消息 QoS 1：转发且写 SIoT 库（约 250 条/节课，可作排障原始报文）。
- 心跳 QoS 0：**必须** QoS 0，否则 50×15s×45min≈9000 条/节课落盘撑爆库。

### 5.4 消息信封（统一）
```json
{ "msgId":"uuid","ts":1693400000000,"type":"checkin|task|return|cmd|status|sync",
  "seat":"07","group":"G2","machineId":"<短哈希>","payload":{} }
```

## 6. 数据库表清单（锁定，含架构师增量）

> 教师端 SQLite（`classroom.db`）。在 03 文档基础上补 3 条增量（幂等兜底/座位冲突/机器标识）。

| 表 | 关键字段 | 索引/约束（增量已含） |
|----|----------|----------------------|
| t_session | session_id(PK), teacher, class_name, start_time, end_time, phase, total_seats | — |
| t_student | stu_id(PK), session_id(FK), seat, group_id, name, student_no, checkin_time, checkin_status, **machine_id** | **UNIQUE(session_id, seat)**, machine_id 用于冲突检测 |
| t_equipment | eq_id(PK), eq_name, category, total | — |
| t_equipment_borrow | borrow_id(PK), session_id(FK), seat, group_id, eq_id, qty, borrow_time, return_time, status | — |
| t_task | task_id(PK), session_id(FK), title, desc, publish_time, close_time | — |
| t_task_status | id, task_id(FK), seat, group_id, status, ts | idx(task_id) |
| t_event_log | id, session_id, ts, type, seat, detail, **msg_id** | **UNIQUE(msg_id)** 幂等持久兜底, idx(session_id), idx(ts) |

## 7. 页面/界面清单（锁定）

| 端 | 页面 | 核心组件 | 对应能力 | Token 主题 |
|----|------|----------|----------|-----------|
| 学生机 | 登记页 | 姓名/学号/小组/器材勾选/确认按钮 | 课前 | 浅色 #F8FAFC |
| 学生机 | 任务页 | 三状态大按钮(进行中/已完成/求助) | 课中 | 浅色 |
| 学生机 | 归还页 | 器材核对/确认归还按钮/关机提示 | 课后 | 浅色 |
| 教师端 | 大屏看板 | 顶栏(班级/在线/连接) + 小组矩阵 + 事件流 + 控制栏 | 全 | 深色 #0C1018 |

图标：全部 Lucide，尺寸 16/20/24；状态用「色块+图标」双表达。详见 UIUX_v1.md §10 每屏提示词。

## 8. 设计 Token（锁定）
- 主色：纯色 Indigo `#4F46E5`（无渐变）。
- 状态色：waiting `#9CA3AF` / doing `#2563EB` / done `#16A34A` / help `#EA580C`(1s 闪烁) / offline `#DC2626`。
- 连接：online `#16A34A` / reconnecting `#D97706` / offline `#DC2626`。
- 字体：Inter + Noto Sans SC；正文 24px / 按钮 28px；主按钮 ≥80×80px。
- 间距 4px 网格；圆角 8/12/16/pill；克制阴影；动效 120/200/300ms。
- 图标库：Lucide（统一描边 2px），禁 emoji/Unicode 字形作图标。
- 机器可读：`design-tokens.json`。

## 9. 验收标准（EARS，锁定）

| 编号 | 功能 | EARS 验收 |
|------|------|-----------|
| AC-1 | 课前登记 | When 学生提交登记，系统**必须**实时更新大屏到课率与未登记名单，误差 0 |
| AC-2 | 器材统计 | When 学生确认领取/归还，系统**必须**更新大屏对应器材数量，与实际一致 |
| AC-3 | 课中求助 | While 学生点击求助，系统**必须**在 ≤1s 内高亮该组并置顶 |
| AC-4 | 自动关机 | If 全部小组确认归还，系统**必须**下发关机指令使学生在 10s 后关机；教师可强制 |
| AC-5 | 导出 | When 教师点导出，系统**必须**生成 xlsx+csv 四类报表，字段完整 |
| AC-6 | 并发 | While 50 台并发，系统**必须**保持连接且无消息丢失 |
| AC-7 | 重连 | If 网络中断后恢复，系统**必须**自动重连并补发未确认关键状态(同 msgId 幂等) |
| AC-8 | 操作步数 | 核心操作**应该** ≤3 步，初中生可独立使用 |
| AC-9 | 离线队列 | While 离线，系统**必须**将关键操作落本地 JSON，恢复后补发 |
| AC-10 | 兼容性 | 系统**必须**在 Win10/11 学生机 + Chrome/Edge 教师端运行 |

## 10. 边界与约束
- 学生机 OS：Win10/11（已确认，不再支持 Win7）。
- 并发：标准机房 40–50 台。
- 网络：同一局域网，SIoT2 可达（固定 IP，DHCP 变更会使 50 台配置失效 → 运维检查单）。
- 防火墙放行：8080/1883/1888。
- 安全：内网闭环；默认凭据**必须改**；`shutdown` 指令须 HMAC 会话令牌 + phase 闸门 + 60s 时间窗，否则学生可伪造导致全班关机。
- 性能：上行到大屏 ≤1s；大屏刷新 ≥1Hz 增量渲染。

## 11. 内嵌已知坑（从架构师/PM 风险清单拉取，Phase 3 必守）

| 坑 | 指纹 | 根因 | 修法 |
|----|------|------|------|
| clientId 互踢 | SIoT 同 clientId 后连踢前 | 机房克隆镜像 seat/clientId 相同 | clientId 加 machine 短哈希后缀；seat 优先取自 hostname(PC-07→07)；教师端检测同 seat 多 machineId 告警 |
| 协议握手失败 | MQTT 3.1.1 vs SIoT 3.1 | 版本不一致 | 客户端实现 4→3 自动降级(protocolId:'MQIsdp') |
| 重连风暴 | 50 台 SIoT 重启后同时退避 | 无随机抖动 | 退避加随机 jitter（必需项） |
| 重复登记 | 补发时重生成 msgId | 幂等失效 | 补发**复用原 msgId**（写进单测） |
| 关机恶作剧 | 学生用 MQTTX 伪造 shutdown | 无鉴权 | HMAC+phase 闸门+60s 窗；生产关 DevTools |
| 心跳爆库 | 心跳 QoS1 | SIoT QoS=入库 | 心跳 QoS0 |
| 失联机无兜底 | 始终不重连 | 无标注 | 大屏标注未关机座位+强制关机兜底 |

## 12. 端到端验证步骤（Spec 锁定）
```bash
# 前置：SIoT2 运行(用户实例)，config 填 IP/账号；教师端 npm i && node server.js
# 1. 教师点「开始上课」→ 发布 start
# 2. 学生机登记提交 → 断言大屏到课+1、器材领取率更新
# 3. 教师「发布任务」→ 学生点「求助」→ 断言大屏该组 ≤1s 闪烁置顶
# 4. 模拟断网 30s → 恢复 → 断言关键状态补发且唯一(无重复)
# 5. 教师「下课」→ 学生确认归还 ×N → 全确认 → 断言学生机 10s 后关机
# 6. 教师「导出」→ 断言生成 xlsx+csv 四类报表
```

## 13. 变更记录
| 日期 | 变更内容 | 原因 | 影响范围 |
|------|----------|------|----------|
| 2026-08-30 | 初版 Spec v1.0 | Phase 1 三文档确认 | 全 |
| 2026-08-30 | 锁定 Electron 44 / WS 1888 / Plan B 两级主题 / Win10-11 | 用户决策 + SIoT2 实测修正 | 架构/接口/部署 |
