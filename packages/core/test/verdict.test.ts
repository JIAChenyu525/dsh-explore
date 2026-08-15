import { describe, expect, it } from 'vitest'
import { verdictFromRun } from '../src/verdict'

describe('verdictFromRun', () => {
  it('passes on exit 0', () => {
    const v = verdictFromRun({ exitCode: 0, timedOut: false, aborted: false, stdout: 'ok', stderr: '' })
    expect(v.passed).toBe(true)
    expect(v.score).toBe(1)
  })

  it('fails on nonzero exit', () => {
    const v = verdictFromRun({ exitCode: 1, timedOut: false, aborted: false, stdout: 'boom', stderr: 'err' })
    expect(v.passed).toBe(false)
    expect(v.score).toBe(0)
  })

  it('fails on timeout even with exit 0 (signal-caught)', () => {
    const v = verdictFromRun({ exitCode: 0, timedOut: true, aborted: false, stdout: '', stderr: '' })
    expect(v.passed).toBe(false)
  })

  it('fails on abort', () => {
    const v = verdictFromRun({ exitCode: null, timedOut: false, aborted: true, stdout: '', stderr: '' })
    expect(v.passed).toBe(false)
  })

  it('keeps trailing stdout lines as evidence', () => {
    const v = verdictFromRun({
      exitCode: 1,
      timedOut: false,
      aborted: false,
      stdout: 'a\nb\nc\nFAIL\nd\ne',
      stderr: '',
    })
    expect(v.evidence).toContain('FAIL')
    expect(v.evidence.length).toBeLessThanOrEqual(4)
  })
})
