/**
 * @dsh-explore/core — pure trajectory-search types.
 *
 * Deliberately free of any DeepSeek Harness dependency: the actual forking and
 * verification are injected by the host plugin, so this package stays
 * unit-testable in isolation and reusable across runtimes.
 */

/** One tool call made along a trajectory. */
export interface ToolStep {
  /** Tool name (e.g. 'bash', 'read', 'edit'). */
  name: string
  /** Short args summary (truncated). */
  args: string
  /** Whether this call's result was an error. */
  isError: boolean
}

/** A completed exploration path an agent (or a fork) produced. */
export interface Trajectory {
  sessionId: string
  /** Final assistant text; empty when the child produced none. */
  output: string
  /** The tool-call sequence that makes up this trajectory. */
  steps: ToolStep[]
  turnCount: number
  /** Why the run ended (e.g. 'completed', 'error', 'max-tokens'). */
  stopReason: string
}

/** Structural diff of two trajectories. */
export interface TrajectoryDiff {
  /** Number of leading steps identical in both. */
  sharedPrefix: number
  /** Steps only in A after the shared prefix. */
  aOnly: ToolStep[]
  /** Steps only in B after the shared prefix. */
  bOnly: ToolStep[]
  aStepCount: number
  bStepCount: number
  aErrorCount: number
  bErrorCount: number
  /** One-line explanation of the divergence. */
  summary: string
}

/** Ground-truth verdict for a finished trajectory. */
export interface Verdict {
  passed: boolean
  /** Reward in [0, 1]; the search keeps the highest. */
  score: number
  /** Key facts backing the verdict (tests passed/failed, errors, cost). */
  evidence: string[]
}

/** Verifier: score a finished trajectory against ground truth (execution). */
export type Verifier = (trajectory: Trajectory) => Promise<Verdict>

/** One forked exploration path to run. */
export interface VariationSpec {
  variationIndex: number
  variationPrompt: string
  /** Session id to fork from — the root for level 1, a child's session deeper. */
  forkFrom: string
}

/** Runner: fork + run one exploration path from a variation spec. */
export type Runner = (spec: VariationSpec) => Promise<Trajectory>

export interface SearchConfig {
  /** How many forks to explore per expansion (N). */
  branchingFactor: number
  /** Hard budget on total forks spawned. */
  maxNodes: number
  /** UCT exploration constant (MCTS only). */
  explorationConstant: number
  /** Session id the first level forks from. */
  rootSessionId: string
  verifier: Verifier
}

export interface SearchNode {
  id: string
  parentId: string | null
  depth: number
  visits: number
  totalValue: number
  children: string[]
  /** Session id to fork from for this node's children. */
  sessionId: string
  /** The trajectory this node's fork produced (null for the root). */
  trajectory: Trajectory | null
}

export interface SearchResult {
  winner: Trajectory | null
  verdict: Verdict | null
  /** Total forks spawned during the search. */
  explored: number
  nodes: SearchNode[]
}

/**
 * Diversity instruction for branch `i` of `total`.
 *
 * v0 is deliberately tool-free: each branch answers the inherited task in ONE
 * message so it settles immediately. (Free tool-using trajectory search is a
 * later iteration — it currently deadlocks on `child.whenIdle()` because the
 * fork child has no stopping condition.)
 */
export function variationPrompt(total: number, i: number): string {
  return (
    `You are exploration branch ${i + 1} of ${total} answering the task in the conversation above. ` +
    `Answer it differently from the other branches. ` +
    `Respond in ONE message only: do NOT call any tools and do NOT loop. Give your final answer now.`
  )
}
