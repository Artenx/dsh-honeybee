import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/node-registry.ts', 'src/routes.ts', 'src/test.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
