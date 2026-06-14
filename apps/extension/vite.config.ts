import { fileURLToPath } from 'node:url';

import { crx } from '@crxjs/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { stoachainResolve } from '../../packages/core/src/build/viteStoachain';

import manifest from './manifest.config';

// The dApp approval surface is an extension page opened by the SW via
// `chrome.windows.create(chrome.runtime.getURL(...))`, NOT referenced from the
// manifest (it must stay out of web_accessible_resources). @crxjs only bundles
// HTML it knows about, so it is declared as an explicit Rollup HTML input here.
// Its framing/clickjacking headers (frame-ancestors 'none' + sensor
// Permissions-Policy) live in the HTML's own <meta> CSP.
const approvalPage = fileURLToPath(new URL('./src/approval/approval.html', import.meta.url));

// Chrome MV3 extension build. Two layers compose here:
//
//  1. @crxjs `crx({ manifest })` reads manifest.config.ts and registers BOTH
//     manifest inputs as Rollup entries — the popup HTML (action.default_popup)
//     and the module service worker (background.service_worker) — then emits the
//     final `dist/manifest.json` with hashed asset paths rewritten.
//
//  2. The shared @stoachain `stoachainResolve()` supplies the build-correctness
//     resolve config: the legacy `.cjs` subpath aliases, the `node:buffer` ->
//     `buffer` redirect, the polyfill-specifier alias, and the react/react-dom
//     dedupe. Because it lives on `resolve` (not a per-input plugin), it applies
//     to EVERY Rollup input @crxjs creates — so the service-worker bundle gets
//     the exact same correctness layer as the popup, which it needs the moment
//     it imports any @stoachain crypto module.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: stoachainResolve(),
  build: {
    rollupOptions: {
      input: { approval: approvalPage },
    },
  },
  // The icons are referenced from the manifest as `public/icons/*.png`, so
  // @crxjs already emits them at that path. Disabling Vite's default publicDir
  // copy avoids a second, manifest-unreferenced `dist/icons/*` duplicate and
  // keeps the shipped artifact to exactly what the manifest declares.
  publicDir: false,
});
