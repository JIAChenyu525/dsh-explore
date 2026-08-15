[English](README.md) | 中文

# dsh-explore

**面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 智能体的轨迹级并行探索。**

当你需要不止一个答案时，`dsh-explore` 会把你的智能体**分叉成 N 个并行分支**——每个分支都继承你的对话上下文，独立探索不同的思路——然后返回所有答案（当有验证器时，选出一个赢家）。

```
一个智能体，一个任务
      │
      ├─ fork #1 ──→ 答案 A
      ├─ fork #2 ──→ 答案 B   ──→（可选）验证 → 选赢家
      └─ fork #3 ──→ 答案 C
```

## 现在能做什么（v0）

- **`explore` 工具** —— 用 `{ branches: N }` 调用，并行 fork N 个子智能体，得到 N 个真正不同的答案。
- 基于 dsh 的 `fork` 子智能体 provider：每个分支用父会话的「已完成轮次前缀」做种子，因此共享你的完整上下文。
- **现在就能跑**，已针对 preview 版本实测。

## 已实现但待上线（v1）

- **`verify` 参数** —— 对每个分支跑一条 shell 命令，选通过的那个（以执行为真值，不信 LLM 自述）。
- **赢家 diff** —— `diffTrajectories` 解释「赢家为什么赢」（共享前缀 → 分歧的工具调用 → 错误计数）。
- 两者都已实现并通过单测；端到端路径被**工作区隔离**卡住：dsh 的 fork 子智能体共享父会话的工作目录，并行分支会互相覆盖文件改动。计划的方案是「输出 diff → 应用到 git worktree → 验证」（即 [ParallelEnv](https://www.caisconf.org/program/2026/demos/parallel-environments-for-agents/) 的树分叉模式）。

## 为什么可靠

- **确定性回退** —— dsh 的 `fork` 用父会话的精确前缀做种子，分支之间不共享可变状态。
- **执行为真值** —— `verify` 路径跑真实命令、读退出码，绝不轻信智能体的自述。
- **有预算上限** —— 分叉数有上限，每个分支有硬超时。

## 理论基础

受 [LATS](https://arxiv.org/abs/2310.04406)（语言智能体轨迹上的 MCTS）、[Agent Q](https://arxiv.org/abs/2408.07199)（环境奖励；LLM 自我批判仅作引导）、带执行验证器的 best-of-N（EvoScale / μ Code / SWE-bench）、以及 [ParallelEnv](https://www.caisconf.org/program/2026/demos/parallel-environments-for-agents/)（隔离环境上的树分叉）启发。

## 包结构

- `packages/core` —— 纯算法库、零依赖：`bestOfN`、`mcts`、UCT、`verdictFromRun`、`diffTrajectories`、`selectBest`。隔离单测（14 个测试）。
- `packages/plugin` —— dsh bundle，把 core 接到 dsh 的 `ctx.subagents` / `ctx.tools`。打包成单个 `dist/index.js`；**运行时零 `@deepseek-ai/*` 导入**（out-of-tree bundle 无法解析 dsh 内部包）。

## 安装

```sh
# 从本地 checkout 安装（当前最快）
dsh plugin --profile web add ./packages/plugin

# 重启 dsh web，然后在会话里对模型说：
#   "用 explore 工具，探索 3 种不同的方案解决 …"
```

> 这个插件是一个**工具**，不是斜杠命令：子智能体只有从工具 `execute` 里、在 agent loop 内部 fork 时才能正常结算。斜杠命令 handler 里 fork 子智能体，`SubagentRun.result` 在当前 preview 中永远不会 resolve。

## 为什么是工具，而不是命令

dsh 自带的 `subagent` 工具在 agent loop 内部用 `exec.agent` fork 子智能体——这是唯一能让 `child.whenIdle()` 达到静默的上下文。本插件遵循同样的契约。

## 路线图

- [x] M0 —— fork 机制验证（工具路径）
- [x] M1 —— 核心搜索库（`bestOfN` / `mcts` / UCT）
- [x] M2 —— `explore` 工具，并行 fork N
- [x] M3 —— 执行验证器（`ctx.shell` → verdict）
- [ ] M4 —— 端到端赢家 + diff（需要工作区隔离：输出 diff → worktree → 验证）
- [ ] M5 —— npm 发布 + `dsh plugin add dsh-explore`

## 状态

⚠️ 开发者预览版。dsh 将 `SESSION_FORMAT_VERSION` 固定在 0，不承诺兼容性；`dsh-explore` 跟随 preview 线。
