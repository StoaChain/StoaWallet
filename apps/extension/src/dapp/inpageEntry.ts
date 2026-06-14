/**
 * MAIN-world content-script ENTRYPOINT for the dApp provider.
 *
 * Registered in the manifest as a `world: "MAIN"` content script (Chrome 111+).
 * Running in the MAIN world means this module executes in the PAGE's own JS
 * context, so the `window.stoa` provider it installs is reachable by the dApp's
 * scripts WITHOUT a `web_accessible_resources` entry — that removes the
 * extension-fingerprinting surface a `<script src=...>` injection would expose
 * (RR#4). It runs at `document_start`, so `window.stoa` exists before the dApp
 * feature-detects the wallet (RR#5).
 *
 * This module holds NO `chrome.*` surface (the MAIN world has none) and NO key
 * material: it is the page-world half of the bridge and talks to the wallet only
 * via `window.postMessage`, which the ISOLATED-world relay forwards to the
 * background. Keep it dependency-light — no @stoachain/* crypto reaches the page
 * world; the only import is the secret-free provider factory.
 */

import { installStoaProvider } from './inpage';

const { provider } = installStoaProvider(window);

// Expose the provider on the page as `window.stoa` (eckoWALLET-style). The cast
// is local to this entrypoint so the provider type stays clean for consumers.
(window as unknown as { stoa?: unknown }).stoa = provider;
