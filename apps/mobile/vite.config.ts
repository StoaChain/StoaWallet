import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { stoachainResolve } from '../../packages/core/src/build/viteStoachain';

import { MOBILE_WEB_DIR } from './webDir';

// Capacitor-wrapped mobile app. Wraps the SAME packages/ui UI as the extension
// and consumes the identical shared @stoachain build-correctness layer
// (`stoachainResolve()`: the legacy `.cjs` subpath aliases, the
// `node:buffer` -> `buffer` redirect, the polyfill-specifier alias, and the
// react/react-dom dedupe). That layer is what makes the bundle EXECUTE inside a
// Capacitor WebView — the same browser-ESM constraints the extension faces.
//
// `build.outDir` is MOBILE_WEB_DIR, the same constant `capacitor.config.ts`
// declares as `webDir`, so `cap sync` always copies the directory Vite wrote.
export default defineConfig({
  plugins: [react()],
  resolve: stoachainResolve(),
  build: {
    outDir: MOBILE_WEB_DIR,
    emptyOutDir: true,
  },
});
