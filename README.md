# ALL SCOPE 课堂管理系统（v4.2）

> 初二信息技术硬件·课堂管理系统：开课→登记→活动计时→学生机锁定→归还→报表 全链路。

<p align="center">
  <img src="assets/all-scope-mark.png" alt="ALL SCOPE mark" width="96" />
  <br />
  <img src="assets/all-scope-text-logo.png" alt="ALL SCOPE 全域课堂" width="240" />
</p>

## 一、项目简介

面向「初二信息技术·硬件实践课」（焊接 / 传感器 / 开源硬件）的课堂管理系统。
教师机大屏控制班级状态，学生机登记与任务上报，办公电脑通过 Preset Studio 维护预设。

v4.2 已完成"分组配置 / 上课器材 / 器材字典互通 / 单活动预设包"等备课增强，并补齐 50 台并发压测。

## 二、三端架构

| 应用 | 路径 | 职责 |
|------|------|------|
| **教室教师端**（教师机） | `classroom-mgmt/teacher/` | 纯 Node 服务 + 大屏（HTTP/SSE）+ MQTT 桥接学生机 + 活动计时/锁定策略/报表导出 |
| **学生机端** | `classroom-mgmt/student/` | Electron + mqtt.js，登记页 / 任务页 / 归还页 / HMAC 关机 |
| **Preset Studio**（办公电脑） | `classroom-mgmt/preset-studio/` | 班级/活动预设编辑器 + 器材字典 + 预设包导出/导入 |

共享契约：`classroom-mgmt/shared/`（topics.js / icons.js / preset-package.js）。
SIoT2 broker 配套（第三方，仓库不存二进制，发布时由 `2_教师机/siot/` 携带）。

## 三、文档

- 开发文档见 `课堂管理系统开发文档/01..08_*.md`
- API 规范：`课堂管理系统开发文档/openapi.yaml`
- 设计令牌：`课堂管理系统开发文档/design-tokens.json`
- 交付包（可发布的免安装包）：独立 `交付包_v4课堂管理系统/` 目录（不入版本库），见仓库外文档

## 四、一键测试

```bash
cd classroom-mgmt
bash run-tests.sh           # 快速 10 项
bash run-tests.sh --full    # 全量 14 项（含真实 broker smoke 77/77 与 net.broker 11/11）
```

质量门禁：单文件 ≤300 行（db 仓储/存储 ≤320）/ 无 emoji / 无硬编码色 / 按钮 ≥80px。

## 五、版本管理

- `v4.2-deliverable` —— 教师节交付基线（tag，可随时回退到这版）
- 真名提交（author: 张生雨阳 `<zsyy114514@hotmail.com>`）

## 六、许可

未声明；如需对外公开请补充 `LICENSE`。