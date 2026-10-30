import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// End-to-end suites: child processes, the packed tarball and (opt-in) a real mongod. Run with `npm run test:e2e`.
export default defineConfig({
  resolve: { alias: [{ find: /^tracelet$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) }] },
  test: {
    include: ['tests/e2e/**/*.e2e-spec.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    testTimeout: 240000,
    hookTimeout: 240000,
    fileParallelism: false,
  },
  plugins: [
    swc.vite({
      tsconfigFile: false,
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
