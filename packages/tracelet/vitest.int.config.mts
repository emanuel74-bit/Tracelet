import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.int-spec.ts', 'tests/contract/**/*.spec.ts', 'bench/**/*.int-spec.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    testTimeout: 120000,
    hookTimeout: 120000,
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
