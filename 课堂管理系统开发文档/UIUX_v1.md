# 初二信息技术硬件实践课课堂管理系统 · UI/UX 设计规范 v1

> 文档编号：UI-ICT-ClassMgmt-SPEC-v1
> 编写：设计师「颜好看」 · 日期：2026-08-30
> 关联文档：01_需求规格说明书（NFR-U1~U4）、05_界面原型说明
> 机器可读 Token：`design-tokens.json`（前端 `import tokens from './design-tokens.json'`）

---

## 0. 设计寄存器与策略

| 维度 | 取值 | 说明 |
| --- | --- | --- |
| 寄存器 | **Product（设计服务产品）** | 设计服务于课堂工具，标杆=「赢得熟悉感 + 可信」 |
| DESIGN_VARIANCE | 3 | 可预测、对称、单列/三区网格；初二学生无需探索 |
| MOTION_INTENSITY | 4 | 仅功能动效 + 必需的求助闪烁 + 连接态旋转；克制 |
| VISUAL_DENSITY | 学生机 3 / 教师端 8 | 学生机「美术馆留白」大按钮；教师端「驾驶舱密集」 |

**双主题原则**：学生机用**浅色**（明亮、近距可读）；教师端大屏用**深色**（投影对比强、后排可见）。两主题共用同一套 `accent` 与 `state.*` 色，保证状态语义一致。

---

## 1. Visual Theme & Atmosphere

- **关键词**：极简、清晰、克制、状态驱动的色块语言、零文字负担。
- **氛围**：像机场航班信息屏——一眼看懂谁在做什么，不需要阅读说明。
- **品牌声音词**（物理对象）：教室白板 + 交通信号灯 + 实验室仪器面板。冷静、机械、确定。
- **反 AI 模板**：无紫粉渐变、无 emoji 图标、无 Lorem ipsum、无「Welcome to」、无居中 Hero 口号。

---

## 2. Color Palette & Roles

### 2.1 主色（A1-identity）
| Token | 值 | 角色 |
| --- | --- | --- |
| `--accent` | `#4F46E5` Indigo | 主操作按钮（确认登记/确认归还/开始上课…）。**每屏可见强调色 ≤ 2 处** |
| `--accent-hover` | `#4338CA` | 悬停 |
| `--accent-active` | `#3730A3` | 按下 |
| `--accent-on` | `#FFFFFF` | accent 背景上的文字/图标 |

### 2.2 状态色（A1，核心语义——色块+图标双重表达，NFR-U3）
| Token | 值 | 含义 | 闪烁 |
| --- | --- | --- | --- |
| `--state-waiting` | `#9CA3AF` 灰 | 未开始/等待（未登记·未领·未还） | 否 |
| `--state-doing` | `#2563EB` 蓝 | 进行中 | 否 |
| `--state-done` | `#16A34A` 绿 | 已完成/已登记/已归还 | 否 |
| `--state-help` | `#EA580C` 橙红 | 求助（需教师指导） | **是（1s 周期，reduced-motion 下停）** |
| `--state-offline` | `#DC2626` 红 | 离线/掉线 | 静态实色 + 图标 |

### 2.3 连接指示色（A2）
| 状态 | Token | 值 | 图标 |
| --- | --- | --- | --- |
| 已连接 | `--conn-online` | `#16A34A` | `wifi` |
| 重连中 | `--conn-reconnecting` | `#D97706` 琥珀 | `loader-circle`（旋转） |
| 离线 | `--conn-offline` | `#DC2626` | `wifi-off` |

### 2.4 主题表面色
**学生机（浅色）**：`--bg #F8FAFC` · `--surface #FFFFFF` · `--surface2 #F1F5F9` · `--fg #0F172A` · `--muted #475569` · `--border #E2E8F0`
**教师端（深色）**：`--bg #0C1018` · `--surface #161B26` · `--surface2 #1E2531` · `--fg #F1F5F9` · `--muted #94A3B8` · `--border #2A3342`

### 2.5 对比度自检（AA）
- 蓝 `#2563EB` 白底 4.5:1 ✅（doing 文字可读）
- 绿 `#16A34A` / 橙 `#EA580C` 白底 ≈3.1–3.4:1 → 仅用于**大色块+白图标**，符合 AA Large（≥18pt）3:1 ✅
- 灰 `#9CA3AF` 白底 2.8:1 → 仅作「未激活」填充，文字改用 `--muted`/`--fg`，不依赖灰底文字对比
- 红 `#DC2626` 白底 4.5:1 ✅；Indigo `#4F46E5` 白底 5.9:1 ✅

---

## 3. Typography Rules

| 层级 | Token | px | pt | 用途 |
| --- | --- | --- | --- | --- |
| meta | `--text-meta` | 16 | 12 | 仅密集数据微信息：时间戳、座位码、×数量（teacher 端例外，须标注） |
| body | `--text-body` | 24 | 18 | 正文最小值（满足 NFR-U2 ≥18pt） |
| button | `--text-button` | 28 | 21 | 按钮文字（满足 ≥20pt） |
| subtitle | `--text-subtitle` | 30 | 22.5 | 区块标题、矩阵组头 |
| title | `--text-title` | 40 | 30 | 屏幕标题、顶栏班级名 |
| hero | `--text-hero` | 56 | 42 | 大屏关键数字（到课 48/50） |

- 字体栈：`Inter, "Noto Sans SC", -apple-system, sans-serif`；等宽：`JetBrains Mono` 用于学号/座位/时间/数量。
- 字重：正文 400 / 强调 510 / 大标题·主按钮 590。
- 字距：正文 `0`；ALL CAPS 英文标签 `0.06em`；≥40px 标题 `-0.01em`。
- **禁止**衬线体上 Dashboard；**禁止**默认系统字体直出（必须显式 Inter+Noto Sans SC）。

---

## 4. Component Stylings

### 4.1 主操作按钮（Primary Button）
- 尺寸：≥ **80×80px**（NFR-U2）；圆角 `--radius-md`(12px)；背景 `--accent`，文字 `--accent-on`，字号 `--text-button`(28px)。
- 5 态：Default / Hover(`--accent-hover`) / Focus(`--focus-ring` 3px Indigo 半透明) / Active(`--elev-press` 内阴影) / Disabled(opacity .45 + 禁止点击，离线/重连中时禁用提交)。
- 图标：左 24px Lucide 图标 + 文字，如 `clipboard-check`「确认登记」。

### 4.2 状态选择按钮（三选一：进行中/已完成/求助）
- 未选：透明底 + 1px `--border` + `--muted` 文字 + 24px 灰描边图标。
- 选中：填充对应 `state.*` 色 + 白图标 + 白文字（色块即状态）。
- 求助选中：填充 `--state-help` + 1s 闪烁 `glowHelp` 环。

### 4.3 复选/单选（器材、小组）
- 器材复选：24px `square`（未）/ `check-square`（已）+ 文字 + `×N` 等宽数量。
- 小组单选：pill 圆点 `circle`/`circle-dot`，大圆点 ≥44px 触控区。

### 4.4 状态色块（矩阵格 / 连接点）
- 顶部连接点：pill 圆点 12px + 对应连接色 + 文字标签。
- 矩阵格：填充 `state.*` 色，居中 24px 白描边图标 + 组号；help 格加闪烁环并置顶。

### 4.5 卡片 / 面板
- 学生机：`--surface` 白底 + `ring`(1px `--border`)，**不用重阴影**；圆角 `--radius-md`。
- 教师端深色：`--surface` 深底 + 1px `--border`。

---

## 5. Layout Principles

### 学生机（纵向单列，阶段自适应，无导航）
```
┌─ 顶栏：标题 + 连接点 + 座位号 ──────────────┐
│  核心区（单目标）                              │
│   [ 大主按钮 ≥80×80 ]                         │
└───────────────────────────────────────────────┘
```
- 栅格：单列居中，最大宽度 ~720px，左右留白 ≥ `--space-8`(32px)。
- 每屏仅一个核心目标 + 一个大主按钮。

### 教师端大屏（横向三区，≥1920×1080）
```
┌─ 顶栏（班级/时间/在线/连接）──────────────┬─ 右栏 ─┐
│  主区：小组进度矩阵 + 统计卡              │ 事件流 │
│                                          │ 器材统计│
├──────────────────────────────────────────┴────────┤
│  底部控制栏：[开始上课][发布任务][下课][导出][提醒][强关] │
└────────────────────────────────────────────────────┘
```

---

## 6. Depth & Elevation

- 产品寄存器 → 克制层级：**默认用 1px 边框环（`ring`），不用重阴影**。
- 三级：`flat`(none) / `ring`(1px border) / `raised`(0 2px 8px rgba 0.08，仅悬浮/弹层)。
- 教师端深色：用**亮度递进**表达层级（`#0C1018 → #161B26 → #1E2531`），不靠阴影。
- 禁止：幽灵卡片（1px 边框 + blur≥16px 阴影同元素）、过度圆角（≥24px）、默认毛玻璃。

---

## 7. Icon System（锁定 Lucide）

- **库**：[Lucide](https://lucide.dev)（统一描边 2px、矢量、语义明确）。**全项目唯一图标源，禁止 emoji / Unicode 字形（✓ ● * 等）**。
- **尺寸**：`sm 16px`（行内 meta）/ `md 20px`（按钮伴标）/ `lg 24px`（独立图标·状态块·顶栏）。
- **映射表**（开发按此取图标名）：

| 区域 | 图标名 | 尺寸 | 语义 |
| --- | --- | --- | --- |
| 学生顶栏·已连接 | `wifi` | 24 | 已连接 |
| 学生顶栏·离线 | `wifi-off` | 24 | 离线 |
| 学生顶栏·重连中 | `loader-circle` | 24 | 旋转表示重连 |
| 学生顶栏·座位 | `monitor` | 20 | 座位号前缀 |
| 登记·姓名 | `user` | 20 | 姓名 |
| 登记·学号 | `hash` | 20 | 学号 |
| 登记·小组 | `users` | 20 | 小组 |
| 登记·器材 | `package` | 20 | 器材 |
| 登记·未勾 | `square` | 24 | 未选 |
| 登记·已勾 | `check-square` | 24 | 已选 |
| 登记·主按钮 | `clipboard-check` | 24 | 确认登记 |
| 任务·进行中 | `play` / `circle` | 24 | 进行中 |
| 任务·已完成 | `circle-check` | 24 | 已完成 |
| 任务·求助 | `circle-help` | 24 | 求助 |
| 任务·未开始 | `circle-dashed` | 24 | 等待 |
| 归还·主按钮 | `package-check` | 24 | 确认归还 |
| 归还·关机提示 | `power` | 20 | 自动关机 |
| 教师顶栏·大屏 | `presentation` | 20 | 看板 |
| 教师顶栏·时间 | `clock` | 20 | 上课时间 |
| 教师顶栏·在线 | `users` | 20 | 在线数 |
| 矩阵·等待 | `circle-dashed` | 24 | waiting |
| 矩阵·进行中 | `circle` | 24 | doing |
| 矩阵·完成 | `circle-check` | 24 | done |
| 矩阵·求助 | `triangle-alert` | 24 | help（闪烁） |
| 矩阵·离线 | `wifi-off` | 24 | offline |
| 事件流·登记 | `log-in` | 16 | 登记 |
| 事件流·完成 | `circle-check` | 16 | 完成 |
| 事件流·求助 | `hand-helping` | 16 | 求助 |
| 事件流·器材 | `package` | 16 | 器材 |
| 事件流·标题 | `activity` | 20 | 实时事件 |
| 控制栏·开始上课 | `play` | 24 | 开始上课 |
| 控制栏·发布任务 | `megaphone` | 24 | 发布任务 |
| 控制栏·下课 | `power` | 24 | 下课 |
| 控制栏·导出 | `file-down` | 24 | 导出报表 |
| 控制栏·提醒 | `bell-ring` | 24 | 提醒未确认 |
| 控制栏·强制关机 | `power-off` | 24 | 强制关机 |

---

## 8. Do's and Don'ts（P0 红线）

✅ 允许
- 纯色 Indigo 主按钮 + 状态色块；同色系可用。
- Lucide SVG 图标，统一描边、统一尺寸。
- 状态用「色块 + 图标」双表达（NFR-U3）。
- 实色背景 + 必要留白。

❌ 禁止（违反即退回）
- emoji 或 Unicode 字形（✓ ● * ✦ 等）作功能图标。
- 紫→粉渐变（Indigo→Pink 渐变 + 发光边框 + 毛玻璃 三位一体）。
- 硬编码 hex（除 `#fff`/`#000` 特例）；一律走 Token。
- Lorem ipsum / Welcome to / 空洞占位文案。
- 纯色依赖：状态必须同时有颜色**和**图标。
- 卡片 ≥24px 圆角、幽灵卡片、默认毛玻璃。
- 超 3 步操作、主按钮 <80×80px、正文 <18pt。

---

## 9. Responsive & A11y

- **学生机**：1366×768 / 1920×1080，单列纵向；触控+鼠标均可；主按钮 ≥80×80、间距 ≥12px。
- **教师端**：≥1920×1080 横向三区；矩阵格 ≥44px 触控/可读；投影清晰用深色主题。
- **键盘/焦点**：所有按钮 `:focus-visible` 显示 3px Indigo 半透明环；图标按钮带 `aria-label`。
- **屏幕阅读器**：状态块 `role="status"` + `aria-live="polite"`；求助 `aria-live="assertive"`。
- **reduced-motion**：`@media (prefers-reduced-motion: reduce)` 下关闭所有闪烁与过渡，求助改为静态实色 + `triangle-alert` 图标。
- **对比度**：见 §2.5。

---

## 10. 每屏设计提示词 / 标注

> 标注给前端 Agent：布局 + 核心组件(含状态) + 交互 + 响应式 + a11y。

### 10.1 学生机 · 界面A 课前登记（阶段=checkin）
- **路由/阶段**：`phase=checkin`，自动进入，无需导航。
- **布局**：单列居中，最大宽 720px；顶栏(48px) + 表单区 + 底部大按钮。
- **顶栏**：左「信息技术实践课」(`--text-title`)，右 `monitor`+座位号(`--font-mono`) + 连接点(`wifi`/色)。
- **核心组件**：
  - 姓名输入框（预填时只读核对，`user` 图标）→ 学号输入框（`hash` 图标，`--font-mono`）→ 小组单选（4 个大圆点 pill，`users` 图标，触控 ≥44px）。
  - 器材清单：每行 `square`/`check-square` + 器材名 + `×N`(mono)；与台账一致。
  - 主按钮：`clipboard-check`「确认登记」，`--accent`，≥80×80。
- **交互**：填写 → 点确认 = **2 步**；提交后本屏锁定为「已登记 `circle-check`」仅显示状态，禁改（除非教师重置）。
- **状态**：离线/重连中时主按钮 Disabled，操作入本地队列。
- **a11y**：`<label>` 关联输入框；单选 `radiogroup`；提交成功 `aria-live` 播报。

### 10.2 学生机 · 界面B 课中任务（阶段=task）
- **布局**：单列；顶栏 + 任务卡(标题+说明) + 三状态大按钮 + 当前状态回执。
- **任务卡**：`play`/标题 + 说明文字（`--text-body`）；教师发布。
- **三状态按钮**（单次点按上报，**1 步**）：
  - 进行中 `circle` → 填充 `--state-doing`
  - 已完成 `circle-check` → 填充 `--state-done`
  - 求助 `circle-help` → 填充 `--state-help` + 1s 闪烁 `glowHelp`
  - 选中态高亮；允许切换（done→help 每次均上报+时间戳+组号）。
- **回执行**：「状态：已完成 `circle-check`（已上报，可改）」`--muted`。
- **a11y**：`aria-pressed` 表达选中；求助切换 `aria-live="assertive"`。

### 10.3 学生机 · 界面C 课后归还（阶段=return）
- **布局**：单列；顶栏 + 归还清单(默认带出领取清单) + 主按钮 + 底部关机提示。
- **归还清单**：每行 `square`/`check-square` + 器材 + `×N`；学生对照实物勾选。
- **主按钮**：`package-check`「确认归还」，`--accent`，≥80×80 → 上报 return(allReturned)。
- **底部提示**：`power` 图标 + 「全部小组确认后本机将自动关机」`--muted`，降焦虑。
- **交互**：勾选 → 确认 = **2 步**。

### 10.4 教师端 · 顶栏
- **内容**：左 `presentation`+「初二(3)班 信息技术」(`--text-title`)；中 `clock`+上课时间、`users`+「在线 48/50」；右 连接点(`wifi`/色)。
- **状态**：连接态随心跳切换图标/色（online/reconnecting 旋转/offline）。

### 10.5 教师端 · 主区小组进度矩阵
- **布局**：网格（按座位/组排布，如 10×5）；每格 = 组号 + 状态图标 + 状态色填充。
- **状态映射**：waiting `circle-dashed`灰 / doing `circle`蓝 / done `circle-check`绿 / help `triangle-alert`橙红(闪烁+置顶) / offline `wifi-off`红边。
- **统计卡**：到课率 `user-check`、未登记名单 `user-x`、器材领取率 `package`（`--text-hero` 数字）。
- **交互**：help 格置顶高亮；点击格可下钻（可选）。

### 10.6 教师端 · 右栏实时事件流
- **布局**：上「实时事件流 `activity`」滚动列表；下「器材统计 `package`」领/还数量。
- **事件行**：时间(`--font-mono` meta) + 座位(`--font-mono`) + 动作图标(`log-in`/`circle-check`/`hand-helping`/`package`) + 文本。
- **器材统计**：各器材「领 X / 还 Y」进度条（state 色）。
- **a11y**：列表 `aria-live="polite"` 增量播报；新事件温和淡入(`--motion-base`)。

### 10.7 教师端 · 底部控制栏
- **布局**：横向一排 6 个主按钮（深色 `--surface2` 底，分隔线）。
- **按钮**：`play` 开始上课 / `megaphone` 发布任务 / `power` 下课 / `file-down` 导出报表 / `bell-ring` 提醒未确认 / `power-off` 强制关机。
- **步数**：开始上课 1 步 / 发布任务 1 步(说明可选) / 下课 1 步 / 导出 2 步(点→选格式) / 提醒 1 步 / 强制关机 1 步。全部 ≤3 步 ✅。
- **交互**：强制关机/导出等破坏性操作可加一次确认弹层（仍 ≤3 步）。

---

## 11. P0 合规自检结论（校验 05_界面原型说明.md）

| P0 项 | 05 文档现状 | 结论 | 修正说明 |
| --- | --- | --- | --- |
| P0-1 禁用 emoji 功能图标 | 线框用 `[✓]`/`●`/`*` 等**文本符号**占位（`✓`=U+2713、`●`=U+25CF、`*`=求助标记） | ⚠️ 线框合规，实现须替换 | 这些是线框记号，**非实际 UI**。实现时必须用 Lucide SVG：`check-square`(✓) / `wifi`(●) / `triangle-alert`(*) 等，禁止保留 Unicode 字形作功能图标。 |
| P0-2 禁用紫粉渐变 | 无渐变；状态色全为纯色（灰/蓝/绿/橙红/红） | ✅ 合规 | 主色锁定纯色 Indigo `#4F46E5`，不做渐变。 |
| P0-3 禁用 AI 模板味 | 无 Lorem ipsum / Welcome to；文案为具体中文（姓名/学号/开发板） | ✅ 合规 | 示例数据（48/50、96%）均为明确标注的示例，非虚构指标。 |
| P0-4 禁用硬编码颜色 | 05 文档用语义色名（灰/蓝/绿/橙红/红），未写 hex | ✅ 合规 | 实现时经由 `design-tokens.json` 的 `state.*` / `accent` 引用，禁止裸 hex。 |
| 步数 NFR-U1 ≤3 | 登记2/任务1/归还2/开始1/发布1/导出2/强关1 | ✅ 合规 | 全部 ≤3 步。 |
| 尺寸 NFR-U2 | 主按钮 ≥80×80、正文≥18pt、按钮≥20pt | ✅ 合规 | 见 §3/§4.1 Token 锁定。 |

**总评**：05 线框图**通过 P0 门禁**（无渐变、无模板味、无硬编码色、步数达标）。唯一待办是**实现层将 Unicode 占位符号替换为 Lucide SVG 图标**——本规范 §7 已给出完整图标映射表，开发直接对照取用即可。

---

## 12. 前端交接要点（Agent Prompt Guide）

1. `import tokens from './design-tokens.json'`，所有颜色/字号/间距/圆角/阴影/动效均引用 Token，**不得硬编码 hex**（除 `#fff`/`#000`）。
2. 图标统一 `lucide-react`（或对应平台 lucide 包），按 §7 映射表取 `name`，`strokeWidth=2`，尺寸 16/20/24。
3. 学生机浅色主题、教师端深色主题，共用 `accent`/`state.*`。
4. 状态必须「色块 + 图标」双表达；求助/离线闪烁须尊重 `prefers-reduced-motion`。
5. 主按钮 ≥80×80px、`--text-button` 28px；正文 `--text-body` 24px。
6. 连接态三态（online/reconnecting/offline）驱动提交按钮的可用性与本地队列。
