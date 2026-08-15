import type { Verdict } from './types'

/**
 * A completed shell run's observable outcome. The plugin adapts dsh's
 * `ShellRunResult` to this pure shape so `verdictFromRun` stays testable
 * without any runtime dependency.
 */
export interface ShellOutcome {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdout: string
  stderr: string
}

/**
 * Map a shell run to a ground-truth verdict.
 *
 * This is the reliability core: a trajectory "passes" only when the verifier
 * command actually exited 0 (not timed out, not aborted). The evidence carries
 * the last few stdout lines so the winner's report shows *why*.
 */
export function verdictFromRun(outcome: ShellOutcome): Verdict {
  const passed = !outcome.timedOut && !outcome.aborted && outcome.exitCode === 0

  const reason = passed
    ? 'verify command passed (exit 0)'
    : outcome.timedOut
      ? 'verify command timed out'
      : outcome.aborted
        ? 'verify command aborted'
        : `verify command failed (exit ${outcome.exitCode ?? 'signal'})`

  return {
    passed,
    score: passed ? 1 : 0,
    evidence: [reason, ...tailLines(outcome.stdout, 3)],
  }
}

function tailLines(text: string, n: number): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-n)
}
