<div align="center">
  <img src="assets/all-scope-mark.png" alt="ALL SCOPE" width="80" />
</div>

# ALL SCOPE 课堂管理系统（v4.2）

> 初二信息技术硬件·课堂管理系统：开课 → 登记 → 活动计时 → 学生机锁定 → 归还 → 关机 → 报表 全链路。

**📚 完整文档已集中到 [`全域md文档/`](./全域md文档/00-首页.md)**（Obsidian 仓库，用 Obsidian「打开文件夹作为仓库」选择该目录即可）。

| 区域 | 内容 | 入口 |
|------|------|------|
| 00 | 首页（Map of Content） | [00-首页.md](./全域md文档/00-首页.md) |
| 01 | 代码审查机制（总纲 v2.0 + 审查报告） | [审查标准总纲_v2.0.md](./全域md文档/01-代码审查机制/审查标准总纲_v2.0.md) |
| 02 | 开发与设计文档（需求/架构/DB/接口/UI/交付） | [00_文档总目录.md](./全域md文档/02-开发与设计文档/00_文档总目录.md) |
| 03 | 测试与质量记录 | [真机测试前自检清单](./全域md文档/03-测试与质量记录/课堂管理系统_真机测试前自检结果清单.md) |
| 04 | 问题与待办 | [已知问题与遗留项](./全域md文档/04-问题与待办/已知问题与遗留项.md) |
| 05 | 交付与发布 | [README（完整版）](./全域md文档/05-交付与发布/README.md) |
| 99 | 模板（PR 描述 / 分级判定速查） | [99-模板](./全域md文档/99-模板/_区域说明.md) |

## 代码结构

```
classroom-mgmt/
  teacher/         教室教师端（纯 Node 服务 + 大屏） + 一键测试
  student/         学生机端（Electron + mqtt.js）
  preset-studio/   办公端预设编辑器（Electron）
  shared/          三端共享契约（topics / icons / preset-package）
```

## 一键测试（较大更新后必须先全绿再推送）

```bash
cd classroom-mgmt
bash run-tests.sh            # 快速 10 项
bash run-tests.sh --full     # 全量 14 项（含真实 broker 冒烟 77/77）
bash check-and-push.sh "说明" # 全量审查通过才 commit + push
```

## 许可

[MIT License](./LICENSE) · Copyright (c) 2026 张生雨阳 (zsyy) / ALL SCOPE
