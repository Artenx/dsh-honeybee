import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/docker-client.ts', 'src/docker-backend.ts', 'src/remote-docker-cli.ts', 'src/world.ts', 'src/fs-provider.ts', 'src/process-provider.ts', 'src/provision.ts', 'src/docker-routes.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
