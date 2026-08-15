import { describe, expect, it } from 'vitest'
import { extractPatch, proposePatchPrompt } from '../src/patch'

describe('extractPatch', () => {
  it('extracts a unified diff from surrounding prose', () => {
    const text = [
      'Here is my proposed fix:',
      '',
      '```diff',
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '```',
      '',
      'Hope this helps!',
    ].join('\n')

    const patch = extractPatch(text)!
    expect(patch).toContain('diff --git a/a.js b/a.js')
    expect(patch).toContain('+new')
    expect(patch).not.toContain('Here is my proposed fix')
    expect(patch).not.toContain('Hope this helps')
  })

  it('returns null when no diff is present', () => {
    expect(extractPatch('no diff here, just an answer')).toBeNull()
  })

  it('handles a bare hunk without a diff header', () => {
    const patch = extractPatch('@@ -1 +1 @@\n-old\n+new')
    expect(patch).toContain('+new')
  })
})

describe('proposePatchPrompt', () => {
  it('includes the branch index and verify command', () => {
    const p = proposePatchPrompt(3, 1, 'npm test')
    expect(p).toContain('branch 2 of 3')
    expect(p).toContain('npm test')
    expect(p).toContain('Do NOT edit any files')
  })
})
