import { defineManifest } from '@crxjs/vite-plugin';

import pkg from './package.json' with { type: 'json' };

/**
 * Chrome MV3 manifest for StoaWallet.
 *
 * Wallet-class hardening choices encoded here:
 *  - CSP `script-src 'self'; object-src 'self'`: no `unsafe-eval`, no remote
 *    origins. A key-holding extension must never execute code it didn't ship.
 *  - `host_permissions` is the EXACT pair of StoaChain RPC nodes the wallet
 *    talks to — never a wildcard. Reads/supply hit the CORS-open explorer host,
 *    which needs no host permission, so it is intentionally absent here.
 *  - `permissions` is `storage` (vault persistence) + `idle` (the background
 *    auto-lock watches the idle state). No `tabs`/`scripting`/`webRequest`. The
 *    dApp content scripts deliver events via `chrome.tabs.sendMessage`, which on
 *    Chrome 111+ needs NO `tabs` permission to message a tab the extension has an
 *    active content script in (a host-match grant suffices) — so `tabs` stays out.
 *
 * dApp provider surface (Phase 9):
 *  - TWO content scripts inject at `document_start` (RR#5) on the SCOPED StoaChain
 *    dApp-origin allow-list (RR#6 — never `<all_urls>`):
 *      1. `world: "MAIN"` — the inpage `window.stoa` provider, run in the page's
 *         own JS context so it is reachable WITHOUT a `web_accessible_resources`
 *         entry (RR#4: removes the extension-fingerprinting surface a `<script>`
 *         injection would expose). Needs Chrome 111+, which is the pinned target.
 *      2. ISOLATED world — the `chrome.runtime` relay (the only world with
 *         `chrome.*`), the single hop a page has to the background.
 *    Injection adds NO `host_permissions` (injection ≠ fetch).
 *  - `externally_connectable` stays ABSENT (RR#8): a page reaches the SW ONLY via
 *    the content-script relay hop, never directly.
 *  - NO `web_accessible_resources`: the MAIN-world registration means no extension
 *    resource is exposed to pages.
 */

/**
 * Canonical, documented StoaChain dApp-origin allow-list for the content-script
 * injection. A single registrable-domain wildcard — StoaChain dApps are served
 * from `*.stoachain.com` — NOT a silent `<all_urls>`. Pinned here as the one
 * source of truth the manifest test and the store-readiness validator assert.
 */
const STOACHAIN_DAPP_MATCHES = ['https://*.stoachain.com/*'];

export default defineManifest({
  manifest_version: 3,
  name: 'StoaWallet',
  version: pkg.version === '0.0.0' ? '0.1.0' : pkg.version,
  description: 'Barebone crypto wallet for StoaChain — 10 braided chains, ED25519 keys.',
  action: {
    default_popup: 'index.html',
    default_title: 'StoaWallet',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  icons: {
    16: 'public/icons/icon-16.png',
    32: 'public/icons/icon-32.png',
    48: 'public/icons/icon-48.png',
    128: 'public/icons/icon-128.png',
  },
  permissions: ['storage', 'idle', 'sidePanel'],
  host_permissions: ['https://node1.stoachain.com/*', 'https://node2.stoachain.com/*'],
  // The docked side-panel surface the popup opens via `chrome.sidePanel.open`. A
  // manifest-referenced HTML page, so @crxjs auto-bundles it (like the popup) and
  // emits it to dist — no separate Rollup input needed. It reuses the popup's
  // platform seams (ChromeStorageAdapter + BackgroundKeyVaultProxy), so keys stay
  // in the background SW, never in the panel.
  side_panel: { default_path: 'src/sidepanel/index.html' },
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
  content_scripts: [
    {
      // MAIN-world inpage provider (RR#4): defines `window.stoa` in the page's
      // own JS context with no web_accessible_resources fingerprint.
      matches: STOACHAIN_DAPP_MATCHES,
      js: ['src/dapp/inpageEntry.ts'],
      run_at: 'document_start',
      all_frames: false,
      world: 'MAIN',
    },
    {
      // ISOLATED-world relay: the only world with chrome.runtime — the single hop
      // a page has to the background service worker.
      matches: STOACHAIN_DAPP_MATCHES,
      js: ['src/dapp/contentScriptEntry.ts'],
      run_at: 'document_start',
      all_frames: false,
    },
  ],
});
