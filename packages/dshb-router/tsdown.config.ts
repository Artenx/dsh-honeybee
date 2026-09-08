import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/resolve.ts', 'src/types.ts', 'src/decorate-fs.ts', 'src/decorate-subprocess.ts', 'src/decorate-shell.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
