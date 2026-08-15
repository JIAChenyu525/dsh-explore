# dsh-explore

**Trajectory-level parallel exploration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents.**

When you need more than one answer, `dsh-explore` forks your agent into **N parallel branches** — each inherits your conversation context and independently explores a different approach — then returns all their answers (or picks a winner, when a verifier is available).

```
one agent, one task
      │
      ├─ fork #1 ──→ answer A
      ├─ fork #2 ──→ answer B   ──→ (optional) verify → keep winner
      └─ fork #3 ──→ answer C
```

## What it does today (v0)

- **`explore` tool** — call it with `{ branches: N }` to fork N subagents in parallel and get N genuinely different answers.
- Built on dsh's `fork` subagent provider: each branch is seeded with the parent's completed-turn prefix, so it shares your full context.
- **Works today.** Live-tested against the preview build.

## What's built but pending (v1)

- **`verify` parameter** — run a shell command against each branch and pick the one that passes (ground truth, not LLM-judge).
- **Winner diff** — `diffTrajectories` explains *why* the winner won (shared prefix → divergent tool calls → error counts).
- Both are implemented and unit-tested; the end-to-end path is **blocked on workspace isolation**: dsh's fork subagents share the parent's working directory, so parallel branches would clobber each other's file edits. The planned fix is *propose-a-diff → apply to a git worktree → verify* (the pattern from [ParallelEnv](https://www.caisconf.org/program/2026/demos/parallel-environments-for-agents/)'s tree-forking).

## Why it's reliable

- **Deterministic rollback** — dsh's `fork` seeds each child with the parent's exact prefix; branches share no mutable state.
- **Execution as ground truth** — the `verify` path runs a real command and reads its exit code; it never trusts an agent's self-report.
- **Budgeted** — branching factor is capped and each branch has a hard timeout.

## Grounding

Inspired by [LATS](https://arxiv.org/abs/2310.04406) (MCTS over language-agent trajectories), [Agent Q](https://arxiv.org/abs/2408.07199) (environment reward; LLM self-critique only as a guide), best-of-N with execution verifiers (EvoScale / μ Code / SWE-bench), and [ParallelEnv](https://www.caisconf.org/program/2026/demos/parallel-environments-for-agents/) (tree-forking over isolated environments).

## Packages

- `packages/core` — pure, dependency-free algorithms: `bestOfN`, `mcts`, UCT, `verdictFromRun`, `diffTrajectories`, `selectBest`. Unit-tested in isolation (14 tests).
- `packages/plugin` — the dsh bundle that wires the core to dsh's `ctx.subagents` / `ctx.tools`. Bundled to a single `dist/index.js`; **no `@deepseek-ai/*` import at runtime** (out-of-tree bundles can't resolve dsh's internals).

## Install

```sh
# from a local checkout (fastest today)
dsh plugin --profile web add ./packages/plugin

# restart dsh web, then in a session ask the model:
#   "用 explore 工具，探索 3 种不同的方案解决 …"
```

> The plugin is a **tool**, not a slash command: subagents only settle when forked from a tool's `execute` inside the agent loop. A slash-command handler forking subagents never resolves `SubagentRun.result` in the current preview.

## Why a tool, not a command

dsh's own `subagent` tool forks children from `exec.agent` inside the agent loop — the only context where `child.whenIdle()` reaches quiescence. This plugin follows the same contract.

## Roadmap

- [x] M0 — fork mechanism verified (tool path)
- [x] M1 — core search library (`bestOfN` / `mcts` / UCT)
- [x] M2 — `explore` tool, fork N in parallel
- [x] M3 — execution verifier (`ctx.shell` → verdict)
- [ ] M4 — end-to-end winner + diff (needs workspace isolation: propose-diff → worktree → verify)
- [ ] M5 — npm publish + `dsh plugin add dsh-explore`

## Status

⚠️ Developer preview. dsh pins `SESSION_FORMAT_VERSION = 0` with no compatibility promise; `dsh-explore` tracks the preview line.
