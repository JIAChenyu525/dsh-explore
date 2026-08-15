import type {
  SearchConfig,
  SearchNode,
  SearchResult,
  Runner,
  Trajectory,
  Verdict,
  Verifier,
} from './types'
import { variationPrompt } from './types'

/** UCT: exploitation (mean value) + exploration bonus for under-visited nodes. */
export function uct(node: SearchNode, parentVisits: number, c: number): number {
  if (node.visits === 0) return Number.POSITIVE_INFINITY
  return node.totalValue / node.visits + c * Math.sqrt(Math.log(parentVisits) / node.visits)
}

export function makeNode(
  parentId: string | null,
  id: string,
  depth: number,
  sessionId: string,
  trajectory: Trajectory | null,
): SearchNode {
  return { id, parentId, depth, visits: 0, totalValue: 0, children: [], sessionId, trajectory }
}

/** Descend from the root to a leaf using UCT. */
export function select(
  root: SearchNode,
  nodes: Map<string, SearchNode>,
  c: number,
): SearchNode {
  let node = root
  while (node.children.length > 0) {
    let bestChild: SearchNode | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const childId of node.children) {
      const child = nodes.get(childId)!
      const score = uct(child, node.visits, c)
      if (score > bestScore) {
        bestScore = score
        bestChild = child
      }
    }
    node = bestChild!
  }
  return node
}

/** Walk the parent chain, adding `value` to `totalValue` and one to `visits`. */
export function backprop(nodes: Map<string, SearchNode>, leaf: SearchNode, value: number): void {
  let node: SearchNode | undefined = leaf
  while (node) {
    node.visits += 1
    node.totalValue += value
    node = node.parentId ? nodes.get(node.parentId) : undefined
  }
}

function bestSoFar(
  best: { trajectory: Trajectory; verdict: Verdict } | null,
  t: Trajectory,
  v: Verdict,
): { trajectory: Trajectory; verdict: Verdict } {
  if (best === null || v.score > best.verdict.score) return { trajectory: t, verdict: v }
  return best
}

/**
 * Pick the highest-scoring trajectory from an already-run set, using `verifier`
 * as ground truth. Useful when the runner and the scoring are separated (the
 * host forked everything up front, then verifies and selects).
 */
export async function selectBest(
  trajectories: Trajectory[],
  verifier: Verifier,
): Promise<{ winner: Trajectory; verdict: Verdict } | null> {
  let best: { trajectory: Trajectory; verdict: Verdict } | null = null
  for (const t of trajectories) {
    const v = await verifier(t)
    best = bestSoFar(best, t, v)
  }
  return best ? { winner: best.trajectory, verdict: best.verdict } : null
}

/**
 * v0 — flat best-of-N.
 *
 * Fork N paths in parallel, verify each, keep the highest-scoring. This is the
 * simplest reliable search: most of the gain of inference-time scaling with
 * none of the tree bookkeeping (EvoScale's Best@N result).
 */
export async function bestOfN(run: Runner, config: SearchConfig): Promise<SearchResult> {
  const root = makeNode(null, 'root', 0, config.rootSessionId, null)
  const nodes = new Map<string, SearchNode>([[root.id, root]])

  const specs = Array.from({ length: config.branchingFactor }, (_, i) => ({
    variationIndex: i,
    variationPrompt: variationPrompt(config.branchingFactor, i),
    forkFrom: config.rootSessionId,
  }))

  const trajectories = await Promise.all(specs.map(run))

  let best: { trajectory: Trajectory; verdict: Verdict } | null = null
  for (const t of trajectories) {
    const verdict = await config.verifier(t)
    best = bestSoFar(best, t, verdict)
  }

  return {
    winner: best?.trajectory ?? null,
    verdict: best?.verdict ?? null,
    explored: trajectories.length,
    nodes: [...nodes.values()],
  }
}

/**
 * v1 — Monte-Carlo tree search over trajectories.
 *
 * Selection (UCT) → Expansion (fork `branchingFactor` children) → Evaluation
 * (verifier) → Backpropagation. Each node is expanded at most once; UCT then
 * decides where the next expansion budget goes.
 */
export async function mcts(run: Runner, config: SearchConfig): Promise<SearchResult> {
  const root = makeNode(null, 'root', 0, config.rootSessionId, null)
  const nodes = new Map<string, SearchNode>([[root.id, root]])

  let best: { trajectory: Trajectory; verdict: Verdict } | null = null
  let spawned = 0
  let idSeq = 0

  while (spawned < config.maxNodes) {
    const leaf = select(root, nodes, config.explorationConstant)

    const specs = Array.from({ length: config.branchingFactor }, (_, i) => ({
      variationIndex: i,
      variationPrompt: variationPrompt(config.branchingFactor, i),
      forkFrom: leaf.sessionId,
    }))

    const trajectories = await Promise.all(specs.map(run))
    spawned += trajectories.length

    for (const t of trajectories) {
      const verdict = await config.verifier(t)
      best = bestSoFar(best, t, verdict)

      const child = makeNode(leaf.id, `n${++idSeq}`, leaf.depth + 1, t.sessionId, t)
      nodes.set(child.id, child)
      leaf.children.push(child.id)
      backprop(nodes, child, verdict.score)
    }
  }

  return {
    winner: best?.trajectory ?? null,
    verdict: best?.verdict ?? null,
    explored: spawned,
    nodes: [...nodes.values()],
  }
}
