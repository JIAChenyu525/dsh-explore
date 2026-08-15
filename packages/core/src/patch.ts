/**
 * Patch utilities for the v1 "propose → apply → verify" flow.
 *
 * A branch in propose-mode reads files and returns a unified diff (git format)
 * embedded in free-form prose. `extractPatch` pulls just the diff out so the
 * host can apply it to an isolated worktree and verify it.
 */

/** Extract a unified diff (git format) embedded in free-form text, or null. */
export function extractPatch(text: string): string | null {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(
    (l) => /^diff --git /.test(l) || /^@@ /.test(l) || /^--- a\//.test(l),
  )
  if (start === -1) return null

  const patch: string[] = []
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]
    const isDiffLine =
      /^diff --git /.test(l) ||
      /^index /.test(l) ||
      /^--- /.test(l) ||
      /^\+\+\+ /.test(l) ||
      /^@@ /.test(l) ||
      /^[+-]/.test(l) ||
      /^ /.test(l) ||
      l.trim() === ''
    if (isDiffLine) {
      patch.push(l)
    } else if (patch.length > 0) {
      break // a prose line after the diff ends it
    }
  }

  const out = patch.join('\n').trim()
  return out.length > 0 ? out : null
}

/**
 * Branch prompt for propose-mode: read files, output a unified diff, do NOT
 * mutate the workspace. The host applies the diff and verifies with `verify`.
 */
export function proposePatchPrompt(total: number, i: number, verify: string): string {
  return (
    `You are exploration branch ${i + 1} of ${total} for the coding task in the conversation above. ` +
    `Read the relevant files, then propose a concrete fix taking a different approach from the other branches. ` +
    `Output ONLY a unified diff (git format, beginning with "diff --git"). Do NOT edit any files. ` +
    `Your diff will be applied to a clean checkout and verified with: \`${verify}\`.`
  )
}
