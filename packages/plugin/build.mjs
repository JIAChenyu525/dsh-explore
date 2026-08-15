import { build } from 'esbuild'

// Bundle the plugin into a single self-contained ESM file. `@dsh-explore/core`
// is inlined so the installed bundle has no runtime dependency on our monorepo
// layout — dsh resolves the plugin only through its own `main` (dist/index.js).
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
  logLevel: 'info',
})
