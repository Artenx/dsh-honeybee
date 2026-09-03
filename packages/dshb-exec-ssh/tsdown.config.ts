import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/connection.ts', 'src/connection-pool.ts', 'src/env-scrub.ts', 'src/runner.ts', 'src/executor.ts', 'src/fs-provider.ts', 'src/process-provider.ts', 'src/world.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
