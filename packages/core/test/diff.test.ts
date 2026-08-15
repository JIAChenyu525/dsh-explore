import { describe, expect, it } from 'vitest'
import { diffTrajectories, summarizeTrajectory } from '../src/diff'
import { selectBest } from '../src/search'
import type { Trajectory, Verifier } from '../src/types'

function traj(steps: Trajectory['steps'], stopReason = 'completed'): Trajectory {
  return { sessionId: 's', output: '', steps, turnCount: 1, stopReason }
}

const step = (name: string, isError = false) => ({ name, args: '', isError })

describe('diffTrajectories', () => {
  it('finds the shared prefix and divergent suffixes', () => {
    const a = traj([step('read'), step('edit')])
    const b = traj([step('read'), step('bash', true)])
    const d = diffTrajectories(a, b)
    expect(d.sharedPrefix).toBe(1)
    expect(d.aOnly.map((s) => s.name)).toEqual(['edit'])
    expect(d.bOnly.map((s) => s.name)).toEqual(['bash'])
    expect(d.bErrorCount).toBe(1)
    expect(d.aErrorCount).toBe(0)
  })

  it('reports identical trajectories', () => {
    const d = diffTrajectories(traj([step('read')]), traj([step('read')]))
    expect(d.sharedPrefix).toBe(1)
    expect(d.summary).toContain('identical')
  })
})

describe('summarizeTrajectory', () => {
  it('counts steps and errors', () => {
    const s = summarizeTrajectory(traj([step('a'), step('b', true), step('c')]))
    expect(s).toContain('3 step(s)')
    expect(s).toContain('1 error(s)')
  })
})

describe('selectBest', () => {
  it('keeps the highest-scoring trajectory', async () => {
    const verifier: Verifier = async (t) => ({
      passed: t.steps.length === 1,
      score: t.steps.length === 1 ? 1 : 0,
      evidence: [],
    })
    const best = await selectBest([traj([step('a'), step('b')]), traj([step('c')])], verifier)
    expect(best?.winner.steps.map((s) => s.name)).toEqual(['c'])
  })
})
