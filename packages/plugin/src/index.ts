import {
  diffTrajectories,
  selectBest,
  variationPrompt,
  verdictFromRun,
  type Runner,
  type ToolStep,
  type Trajectory,
  type VariationSpec,
  type Verifier,
} from '@dsh-explore/core'

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

const BRANCH_TIMEOUT_MS = 120_000

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

      const runner: Runner = (spec: VariationSpec) =>
        forkAndRun(ctx, parent, exec.signal, spec)

      const trajectories = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          runner({ variationIndex: i, variationPrompt: variationPrompt(n, i) }),
        ),
      )

      if (verifyCommand) {
        const best = await selectBest(trajectories, execVerifier(ctx.shell, verifyCommand))
        if (!best) return { winner: null, branches: branchList(trajectories) }

        const loser = trajectories.find((t) => t !== best.winner) ?? best.winner
        return {
          verifyCommand,
          winner: {
            index: trajectories.indexOf(best.winner) + 1,
            passed: best.verdict.passed,
            evidence: best.verdict.evidence,
            answer: best.winner.output,
          },
          diff: diffTrajectories(best.winner, loser),
          branches: branchList(trajectories),
        }
      }

      return { branches: branchList(trajectories) }
    },
  })
}

async function forkAndRun(
  ctx: any,
  parent: any,
  signal: AbortSignal,
  spec: VariationSpec,
): Promise<Trajectory> {
  const run = await ctx.subagents.start('fork', {
    label: `explore-${spec.variationIndex + 1}`,
    prompt: [{ type: 'text', text: spec.variationPrompt }],
    parent,
    agentOptions: { maxTokens: 2000 },
    signal: AbortSignal.any([signal, AbortSignal.timeout(BRANCH_TIMEOUT_MS)]),
  })

  const result = await Promise.race([
    run.result,
    new Promise<{ output: unknown[]; stopReason: string }>((resolve) => {
      const t = setTimeout(() => resolve({ output: [], stopReason: 'timeout' }), BRANCH_TIMEOUT_MS + 15_000)
      if (t.unref) t.unref()
    }),
  ])
  run.result.catch(() => {})

  // Extract the tool-call sequence before the child leaves the store.
  const steps = extractSteps(run.localAgent?.session?.events ?? [])

  try {
    await run.dispose()
  } catch {
    // best-effort teardown.
  }

  return {
    sessionId: String(run.id ?? `explore-${spec.variationIndex + 1}`),
    output: textOf(result.output),
    steps,
    turnCount: 0,
    stopReason: String(result.stopReason),
  }
}

function execVerifier(shell: any, command: string): Verifier {
  return async (_t: Trajectory) => {
    const spec = shell.resolve({ command })
    const run = await shell.run(spec)
    return verdictFromRun({
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      aborted: run.aborted,
      stdout: collectedText(run.stdout),
      stderr: collectedText(run.stderr),
    })
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
  }))
}

function renderResult(value: any): string {
  const lines: string[] = []
  if (value?.winner) {
    lines.push(`WINNER: branch #${value.winner.index} [${value.winner.passed ? 'PASS' : 'fail'}]`)
    lines.push(`verified with: ${value.verifyCommand}`)
    lines.push(`why: ${value.diff?.summary ?? ''}`)
    lines.push(`\n${truncate(value.winner.answer, 400)}`)
  } else {
    const branches = value?.branches ?? []
    lines.push(`${branches.length} branch(es):`)
    for (const b of branches) {
      lines.push(`\n#${b.index} [${b.stopReason}] (${b.steps} step(s))\n${truncate(b.answer, 240) || '(no output)'}`)
    }
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
