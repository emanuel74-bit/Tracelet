import swc from 'unplugin-swc';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: [{ find: /^tracelet$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) }] },
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
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
