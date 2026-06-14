import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config. Most packages are platform-agnostic logic that runs under
 * the default `node` environment. `packages/ui` ships React components whose
 * tests need a DOM, so it is split into its own project with the `jsdom`
 * environment and the React (JSX/Fast-Refresh) plugin. A single `vitest run`
 * from the repo root executes both projects.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          include: [
            'packages/core/**/*.{test,spec}.{ts,tsx}',
            'apps/**/*.{test,spec}.{ts,tsx}',
          ],
        },
      },
      {
        plugins: [react()],
        // pnpm links React only under `packages/ui/node_modules`, so the UI
        // project resolves bare specifiers (incl. the injected JSX runtime)
        // from that root and dedupes React to a single copy.
        root: 'packages/ui',
        resolve: { dedupe: ['react', 'react-dom'] },
        test: {
          name: 'ui',
          globals: true,
          environment: 'jsdom',
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['./vitest.setup.ts'],
        },
      },
    ],
  },
});
