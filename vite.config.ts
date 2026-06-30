/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(async () => {
  const plugins = [react()];
  if (!process.env.VITEST) {
    plugins.push((await import('@tailwindcss/vite')).default());
  }

  return {
    plugins,
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify — file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    test: {
      globals: true,
      environment: 'node',
      setupFiles: ['./src/test/vitest.setup.ts'],
      // Single thread pool: all test files share one worker process, eliminating
      // the N sequential server lifecycle problem.
      pool: 'threads',
      poolOptions: {
        threads: {
            singleThread: true
        }
      },
      // Run files sequentially so the shared server isn't hit concurrently by
      // unrelated suites that manipulate global state (activeLocks, sessions).
      fileParallelism: false,
      isolate: true,
      // Explicit root so vitest resolves container paths correctly when cwd
      // differs between host and Docker/AI Studio environments.
      root: path.resolve(__dirname),
      include: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/test/**/*.test.ts',
      ],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts', 'src/**/*.tsx', 'server.ts'],
        exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/test/**/*'],
      },
    },
  };
});
