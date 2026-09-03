import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/connection.ts', 'src/connection-pool.ts', 'src/env-scrub.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
