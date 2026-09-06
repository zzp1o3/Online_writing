# Online_writing · AI 长篇小说创作流水线

输入一份 brief（世界观 + 主角 + 简介），产出一整本 80 万 ~ 200 万字的长篇网文：AI 完成设定、架构、分支、写作、审判、整理全流程，人在关键节点做主编把关（逐章审批、局部重启、砍分支）。

本项目基于 [InkOS v1.7.2](https://github.com/Narcooo/inkos) 二次开发，代码位于 [`inkos/`](inkos/)（pnpm monorepo：`packages/core` / `packages/studio` / `packages/cli`）。完整设计见 [`docs/设计文档.md`](docs/设计文档.md)，已实现的详细清单见 [`CLAUDE.md`](CLAUDE.md)。

## 核心特性

- **设定生成链路**：Architect 生成世界观架构、主线大纲、卷/篇章结构、角色/地点/势力/物品卡、伏笔清单、节奏曲线、分支图谱初版；支持设定基线锁定（locked 文件不被 AI revise 覆盖）。
- **逐章流水线**：每章循环执行 守护检查 → Planner 规划 → Writer 写作 → Judge + Reviser 审判（连续性审计、去 AI 味，不合格自动重写）→ 人工审批门 → Consolidator 整理记忆。
- **守护 Agent（Guardian）**：伏笔铺/收检查、到期伏笔提醒、卡片一致性核对、支线角色戏份监控（确定性统计 + LLM 综合判定）。
- **卡片系统**：角色/地点/势力/物品四类结构化卡片，仅 Guardian 与用户可写；locked 卡片仅用户可改。
- **分支图谱**：主线 + 分支 + 灰度汇入节点；AI 可提议新分支与评估砍分支影响；砍分支自动回滚受影响章节。
- **人工审批**：`draft → ai_reviewed → human_pending → approved / rejected_whole / rejected_partial` 状态机；写入模式可选 `direct`（直接写入）或 `approve`（点头生效）。
- **局部重启**：划定章节内范围 + 一句指令，Agent 从全局视角重写该段落。
- **三层记忆 + 向量 RAG**：L1 正典状态 / L2 章节摘要 / L3 伏笔台账，五个时机（T1-T5）向量检索，embedding 不可用时自动降级关键词检索。
- **导出**：TXT / Markdown / EPUB，支持仅导出已审批章节（`approvedOnly`）。
- **每个 Agent 独立配置模型**：project 级 `modelOverrides`，在设置页配置。

## 架构总览

```
用户（人肉主编）
  │  brief 输入 / 逐章审批 / 砍分支 / 改卡片 / 局部重启
  ▼
Studio Web 工作台（React + Vite，复用改版 InkOS UI）
  │  分支图谱 · 卡片墙 · 章节审批面板 · 流水线控制台 · 设定工作台 · 设置
  ▼
编排层（packages/core）  Scheduler · Runner / 审批状态机 · 写入模式 · 检索调度
  │
  ▼
Agent 层  Architect · Guardian · Planner · Writer · Judge · Reviser · Consolidator · Branch Manager
  │       （每个 Agent 可独立配置模型 / 挂载 Skills）
  ▼
记忆与存储  三层记忆 · 卡片库 · 分支图谱 · 伏笔台账 · 向量索引 · 正文文件
```

## 快速开始

环境要求：Node.js >= 20、pnpm >= 9。

```bash
# 1. 安装依赖并构建（inkos/ 目录内）
cd inkos
pnpm install
pnpm build

# 2. 配置（见下节），至少提供 LLM service 与 apiKey

# 3. 启动 Studio（API 4569 + 前端 4567）
cd packages/studio
pnpm dev          # 前端 http://localhost:4567 ，API http://localhost:4569
```

生产构建后也可直接运行 API server：`node packages/studio/dist/api/index.js`（用 `INKOS_STUDIO_PORT`、`INKOS_PROJECT_ROOT` 环境变量指定端口与项目根目录）。

CLI 模式读取 `INKOS_LLM_*` 环境变量（见 `.env` 配置），入口为 `packages/cli`。

## 配置说明

三份运行时配置 **均已被 `.gitignore` 排除，不会入库**：

| 文件 | 作用 |
| --- | --- |
| `inkos/inkos.json` | LLM service 与模型、embedding（baseUrl / model / batchSize）、`writeMode`、分支上限与戏份阈值、各 Agent `modelOverrides` |
| `inkos/.inkos/secrets.json` | 各 service 的 `apiKey`（如 deepseek / zhipu / sensenova / siliconflow 等），由 Studio 设置页写入 |
| `inkos/.env` | CLI 模式的 `INKOS_LLM_PROVIDER / INKOS_LLM_BASE_URL / INKOS_LLM_API_KEY / INKOS_LLM_MODEL` |

模板参考：`inkos/.env.example`。

> ⚠️ **隐私提醒**：`apiKey` 只存在于上述三处（本地）与模型服务商后台。换机或开源前，确认 `.inkos/`、`.env`、`inkos.json`、`books/`、`worlds/` 均未被打包或提交。

## 目录结构

```
Online_writing/
├── docs/设计文档.md        # 完整设计（目标、架构、流水线、数据模型、里程碑）
├── CLAUDE.md               # 已完成实现状态与开发注意事项
└── inkos/                  # InkOS v1.7.2 二次开发 monorepo
    ├── packages/core/      # 编排、Agent、记忆/RAG、卡片、分支、审批、导出
    ├── packages/studio/    # Web 工作台（Vite 前端 + API server）
    ├── packages/cli/       # CLI 入口
    ├── inkos.json          # 项目运行时配置（不入库）
    └── books/ worlds/      # 书籍内容与世界观运行时数据（不入库）
```

## 开发状态

全部里程碑已完成（2026-08）：

- **M0 工程基线** ✅ 构建与测试全绿（core 1822 + studio 569 + cli 229）
- **M1 设定生成链路** ✅（含设定基线锁定接入 Architect）
- **M3 记忆 + 向量 RAG** ✅（五时机检索 + 自动降级）
- **M4 分支图谱** ✅（AI 提议 / 砍分支回滚 / 戏份监控）
- **M5 局部重启 + 写入模式 + 导出** ✅
- **M2 端到端验证** ✅ 真实 API 跑通全链路（建书 → 写章 → 审判 → 审批门 → 导出）
- **M6 长文压测** ✅ 连续 7 章：章节索引连续、字数稳定、伏笔台账深度演进、审判门正确拦截问题章节

待办：用流水线产出正式长篇；细化开放问题（分支上限默认值、审判轮数、chunk/top-k、戏份阈值、按题材卡片模板）。

## 开发注意事项

- 所有文件操作使用完整 Windows 绝对路径，避免相对路径 bug
- 修改前端页面后需同时更新 `src/hooks/use-hash-route.ts` 的路由表与 `src/App.tsx` 的渲染分支
- 新组件文案默认中文；i18n 用 `tr(zh, en)`
- 常用命令：`pnpm build` / `pnpm test` / `pnpm lint` / `pnpm typecheck`（均在 `inkos/` 内执行）

## 许可与致谢

- 上游项目 [InkOS](https://github.com/Narcooo/inkos)（AGPL-3.0-only），本项目沿用其许可证，改动部分同样以 AGPL-3.0 开源。
- 感谢上游 InkOS 提供的 Studio UI、Agent 框架与记忆/存储基础设施。
