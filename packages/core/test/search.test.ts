import { describe, expect, it } from 'vitest'
import type { Runner, Trajectory, Verdict, Verifier, SearchConfig, SearchNode } from '../src/types'
import { bestOfN, mcts, select, uct } from '../src/search'

function trajectory(i: number, passes: boolean): Trajectory {
  return {
    sessionId: `s${i}`,
    output: `result of path ${i} ${passes ? 'pass' : 'fail'}`,
    steps: [{ name: 'run-tests', args: '', isError: !passes }],
    turnCount: 1,
    stopReason: 'completed',
  }
}

const verifier: Verifier = async (t) => {
  const passes = t.output.includes('pass')
  return { passed: passes, score: passes ? 1 : 0, evidence: [t.output] }
}

function config(n: number): SearchConfig {
  return {
    branchingFactor: n,
    maxNodes: 8,
    explorationConstant: Math.SQRT2,
    rootSessionId: 'root-session',
    verifier,
  }
}

function node(id: string, parentId: string | null, visits: number, totalValue: number, children: string[]): SearchNode {
  return { id, parentId, depth: 0, visits, totalValue, children, sessionId: id, trajectory: null }
}

describe('uct', () => {
  it('prefers unvisited nodes', () => {
    const n = node('n', null, 0, 0, [])
    expect(uct(n, 10, 1.4)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('select', () => {
  it('descends to the deepest unexpanded node', () => {
    const nodes = new Map<string, SearchNode>()
    const root = node('root', null, 2, 1, ['a'])
    const a = node('a', 'root', 2, 1, [])
    nodes.set('root', root)
    nodes.set('a', a)
    expect(select(root, nodes, 1.4).id).toBe('a')
  })
})

describe('bestOfN', () => {
  it('keeps the highest-scoring trajectory', async () => {
    const run: Runner = async (spec) => trajectory(spec.variationIndex, spec.variationIndex === 2)
    const result = await bestOfN(run, config(4))
    expect(result.explored).toBe(4)
    expect(result.verdict?.passed).toBe(true)
    expect(result.winner?.sessionId).toBe('s2')
  })

  it('reports no winner when nothing passes', async () => {
    const run: Runner = async (spec) => trajectory(spec.variationIndex, false)
    const result = await bestOfN(run, config(3))
    expect(result.verdict?.passed).toBe(false)
    expect(result.winner).not.toBeNull() // still returns the best, even if not passed
  })
})

describe('mcts', () => {
  it('spends budget expanding nodes and finds a passing path', async () => {
    const run: Runner = async (spec) => trajectory(spec.variationIndex, spec.variationIndex % 2 === 0)
    const result = await mcts(run, config(2))
    expect(result.explored).toBeLessThanOrEqual(8)
    expect(result.verdict?.passed).toBe(true)
  })

  it('forks deeper from child sessions, not always the root', async () => {
    // A runner that records which session each fork was requested from.
    const forkedFrom: string[] = []
    const run: Runner = async (spec) => {
      forkedFrom.push(spec.forkFrom)
      return trajectory(spec.variationIndex, spec.variationIndex === 0)
    }
    await mcts(run, { ...config(2), maxNodes: 4 })
    // The first expansion forks from the root; a later one must fork from a child.
    expect(forkedFrom[0]).toBe('root-session')
    expect(forkedFrom.some((s) => s !== 'root-session')).toBe(true)
  })
})
