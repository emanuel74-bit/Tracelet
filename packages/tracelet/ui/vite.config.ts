import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()], base: './',
  build: { outDir: '../assets/dashboard', emptyOutDir: true, assetsDir: 'assets', sourcemap: false },
  server: { host: '127.0.0.1', port: 4173 },
  preview: { host: '127.0.0.1', port: 4173 },
  test: { environment: 'node', include: ['tests/unit/**/*.spec.ts'] },
});
