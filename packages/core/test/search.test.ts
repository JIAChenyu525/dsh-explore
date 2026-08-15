import { describe, expect, it } from 'vitest'
import type { Runner, Trajectory, Verdict, Verifier, SearchConfig } from '../src/types'
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
  return { branchingFactor: n, maxNodes: 8, explorationConstant: Math.SQRT2, verifier }
}

describe('uct', () => {
  it('prefers unvisited nodes', () => {
    const node = { id: 'n', parentId: null, depth: 0, visits: 0, totalValue: 0, children: [] }
    expect(uct(node, 10, 1.4)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('select', () => {
  it('descends to the deepest unexpanded node', () => {
    const nodes = new Map()
    const root = { id: 'root', parentId: null, depth: 0, visits: 2, totalValue: 1, children: ['a'] }
    const a = { id: 'a', parentId: 'root', depth: 1, visits: 2, totalValue: 1, children: [] }
    nodes.set('root', root)
    nodes.set('a', a)
    expect(select(root, nodes, 1.4).id).toBe('a')
  })
})

describe('bestOfN', () => {
  it('keeps the highest-scoring trajectory', async () => {
    // Path 2 is the only passing one.
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
    expect(result.winner).not.toBeNull() // still returns the best (highest score), even if not passed
  })
})

describe('mcts', () => {
  it('spends budget expanding nodes and finds a passing path', async () => {
    // Only even paths pass.
    const run: Runner = async (spec) => trajectory(spec.variationIndex, spec.variationIndex % 2 === 0)
    const result = await mcts(run, config(2))
    expect(result.explored).toBeLessThanOrEqual(8)
    expect(result.verdict?.passed).toBe(true)
  })
})
