import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/resolve.ts', 'src/types.ts', 'src/router-fs.ts', 'src/router-subprocess.ts', 'src/router-shell.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
