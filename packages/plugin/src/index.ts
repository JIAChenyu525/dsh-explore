import {
  bestOfN,
  extractPatch,
  mcts,
  proposePatchPrompt,
  variationPrompt,
  verdictFromRun,
  type Runner,
  type ToolStep,
  type Trajectory,
  type VariationSpec,
  type Verdict,
  type Verifier,
} from '@dsh-explore/core'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * dsh-explore — trajectory-level search for DeepSeek Harness agents.
 *
 * A TOOL (not a slash command): subagents only settle when forked from a tool's
 * `execute` inside the agent loop. Hand-written ToolDefinition — no
 * `@deepseek-ai/*` import, because out-of-tree bundles cannot resolve dsh's
 * internal packages at runtime.
 */

export const name = 'dsh-explore'
export const inject = ['tools', 'subagents', 'shell']

export function apply(ctx: any) {
  ctx.tools.register({
    name: 'explore',
    description:
      'Explore N different approaches to the current task in parallel and return their answers. ' +
      'When `verify` is a shell command, run it against each branch, pick the branch that passes, ' +
      'and report why it won. Use when the user wants several alternative solutions compared, ' +
      'or a task done multiple ways with a checkable result.',
    parameters: {
      type: 'object',
      properties: {
        branches: {
          type: 'integer',
          description: 'Number of parallel exploration branches (default 3, max 8).',
        },
        verify: {
          type: 'string',
          description: 'Optional shell command used as ground truth to pick the winner (e.g. "npm test").',
        },
        timeout_seconds: {
          type: 'integer',
          description: 'Per-branch timeout in seconds (default 120, max 600).',
        },
        max_tokens: {
          type: 'integer',
          description: 'Max output tokens per branch (default 2000).',
        },
        mode: {
          type: 'string',
          description: "Search mode: 'flat' (best-of-N, default) or 'mcts' (tree search).",
        },
        max_nodes: {
          type: 'integer',
          description: 'Total fork budget for MCTS (default 3×branches, max 32).',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: any) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args: any, exec: any) {
      const parent = exec.agent
      if (!parent) throw new Error('explore tool requires a calling agent (exec.agent was undefined)')

      const n = clamp(intOr(args?.branches, 3), 1, 8)
      const verifyCommand = stringOr(args?.verify, null)
      const timeoutMs = clamp(intOr(args?.timeout_seconds, 120), 10, 600) * 1000
      const maxTokens = clamp(intOr(args?.max_tokens, 2000), 256, 32000)
      const mode = args?.mode === 'mcts' ? 'mcts' : 'flat'
      const maxNodes = clamp(intOr(args?.max_nodes, n * 3), n, 32)

      // sessionId → live Agent. Seeded with the root so forks always resolve.
      const sessions = new Map<string, any>([[String(parent.session.id), parent]])
      const runs = new Map<string, any>()

      const runner: Runner = (spec: VariationSpec) =>
        forkAndRun(ctx, sessions, runs, parent, exec.signal, spec, timeoutMs, maxTokens)

      const verifier: Verifier = verifyCommand
        ? worktreeVerifier(ctx.shell, verifyCommand)
        : defaultVerifier

      const config = {
        branchingFactor: n,
        maxNodes,
        explorationConstant: Math.SQRT2,
        rootSessionId: String(parent.session.id),
        verifier,
      }

      const result = mode === 'mcts' ? await mcts(runner, config) : await bestOfN(runner, config)

      // Cleanup: dispose every child we spawned (kept live during the search).
      for (const run of runs.values()) {
        try { await run.dispose() } catch {}
      }

      const trajectories = result.nodes
        .filter((nd) => nd.trajectory)
        .map((nd) => nd.trajectory!)

      return {
        mode,
        explored: result.explored,
        winner: verifyCommand && result.winner && result.verdict
          ? {
              passed: result.verdict.passed,
              evidence: result.verdict.evidence,
              answer: result.winner.output,
            }
          : null,
        branches: branchList(trajectories),
      }
    },
  })
}

async function forkAndRun(
  ctx: any,
  sessions: Map<string, any>,
  runs: Map<string, any>,
  rootParent: any,
  signal: AbortSignal,
  spec: VariationSpec,
  timeoutMs: number,
  maxTokens: number,
): Promise<Trajectory> {
  // Fork from the session this spec names (root for level 1, a child deeper).
  const forkParent = sessions.get(spec.forkFrom) ?? rootParent

  const run = await ctx.subagents.start('fork', {
    label: `explore-${spec.variationIndex + 1}`,
    prompt: [{ type: 'text', text: spec.variationPrompt }],
    parent: forkParent,
    agentOptions: { maxTokens },
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  })

  // Keep the child live + registered so deeper forks can branch from it.
  sessions.set(String(run.id), run.localAgent)
  runs.set(String(run.id), run)

  const result = await Promise.race([
    run.result,
    new Promise<{ output: unknown[]; stopReason: string }>((resolve) => {
      const t = setTimeout(() => resolve({ output: [], stopReason: 'timeout' }), timeoutMs + 15_000)
      if (t.unref) t.unref()
    }),
  ])
  run.result.catch(() => {})

  const steps = extractSteps(run.localAgent?.session?.events ?? [])

  return {
    sessionId: String(run.id ?? `explore-${spec.variationIndex + 1}`),
    output: textOf(result.output),
    steps,
    turnCount: 0,
    stopReason: String(result.stopReason),
  }
}

/** Low-confidence fallback verifier when no executable command is supplied. */
const defaultVerifier: Verifier = async (t: Trajectory): Promise<Verdict> => {
  const ok = t.stopReason === 'completed' && t.output.length > 0
  return {
    passed: ok,
    score: ok ? 0.5 : 0,
    evidence: ['no execution verifier (--verify); low confidence', `stopReason=${t.stopReason}`],
  }
}

interface ShellOutcome {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdout: string
  stderr: string
}

/** Run one command through dsh's shell seam, capturing the normalized outcome. */
async function sh(shell: any, command: string, workdir?: string): Promise<ShellOutcome> {
  const spec = shell.resolve({ command, ...(workdir ? { workdir } : {}) })
  const run = await shell.run(spec)
  return {
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    aborted: run.aborted,
    stdout: collectedText(run.stdout),
    stderr: collectedText(run.stderr),
  }
}

/**
 * v1 verifier: apply a branch's proposed diff to an isolated `git worktree`,
 * run `command` there, and map the outcome to a ground-truth verdict.
 *
 * Isolation lives at the verify step, not the fork: fork branches stay read-only
 * (they only propose diffs), so they share the parent cwd safely; each diff is
 * then materialized + verified in its own worktree and torn down.
 *
 * Limitation: the worktree is checked out from HEAD, so a diff authored against
 * uncommitted parent changes may not apply. The common case (clean repo) works.
 */
function worktreeVerifier(shell: any, command: string): Verifier {
  return async (t: Trajectory): Promise<Verdict> => {
    const patch = extractPatch(t.output)
    if (!patch) {
      return { passed: false, score: 0, evidence: ['branch produced no unified diff'] }
    }

    const wt = join(tmpdir(), `dsh-explore-${randomUUID()}`)
    try {
      const add = await sh(shell, `git worktree add --detach "${wt}"`)
      if (add.exitCode !== 0) {
        return { passed: false, score: 0, evidence: ['worktree add failed', truncate(add.stderr, 160)] }
      }

      const patchFile = join(wt, '.dsh-explore.patch')
      await writeFile(patchFile, patch)
      const apply = await sh(shell, `git apply "${patchFile}"`, wt)
      if (apply.exitCode !== 0) {
        return { passed: false, score: 0, evidence: ['patch did not apply', truncate(apply.stderr, 160)] }
      }

      const verify = await sh(shell, command, wt)
      return verdictFromRun({
        exitCode: verify.exitCode,
        timedOut: verify.timedOut,
        aborted: verify.aborted,
        stdout: verify.stdout,
        stderr: verify.stderr,
      })
    } finally {
      await sh(shell, `git worktree remove --force "${wt}"`).catch(() => {})
    }
  }
}

/** Roughly pair `tool/result` error flags onto the preceding `tool/call`. */
function extractSteps(events: any[]): ToolStep[] {
  const steps: ToolStep[] = []
  for (const e of events) {
    if (e.type === 'tool/call') {
      steps.push({ name: String(e.data?.name ?? '?'), args: truncate(String(e.data?.arguments ?? ''), 60), isError: false })
    } else if (e.type === 'tool/result' && e.data?.error) {
      const last = steps[steps.length - 1]
      if (last) last.isError = true
    }
  }
  return steps
}

function branchList(trajectories: Trajectory[]): any[] {
  return trajectories.map((t, i) => ({
    index: i + 1,
    stopReason: t.stopReason,
    steps: t.steps.length,
    answer: t.output,
    patch: extractPatch(t.output),
  }))
}

function renderResult(value: any): string {
  const lines: string[] = []
  lines.push(`mode=${value?.mode ?? 'flat'}, explored=${value?.explored ?? 0} branch(es)`)
  if (value?.winner) {
    lines.push(`WINNER [${value.winner.passed ? 'PASS' : 'fail'}]`)
    lines.push(`evidence: ${(value.winner.evidence ?? []).join('; ')}`)
    lines.push(`\n${truncate(value.winner.answer, 400)}`)
  }
  const branches = value?.branches ?? []
  for (const b of branches) {
    lines.push(`\n#${b.index} [${b.stopReason}] (${b.steps} step(s))\n${truncate(b.answer, 240) || '(no output)'}`)
  }
  return lines.join('\n')
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function intOr(v: unknown, fallback: number): number {
  const n = parseInt(String(v), 10)
  return Number.isNaN(n) ? fallback : n
}

function stringOr(v: unknown, fallback: string | null): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

function textOf(blocks: any[]): string {
  return (blocks || [])
    .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
    .join(' ')
    .trim()
}

function collectedText(c: any): string {
  return c && typeof c.text === 'string' ? c.text : ''
}

function truncate(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n)}…` : text
}
