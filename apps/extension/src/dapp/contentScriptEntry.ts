/**
 * ISOLATED-world content-script ENTRYPOINT — the page <-> background relay.
 *
 * Registered as a normal (ISOLATED-world) content script at `document_start`. The
 * ISOLATED world is the only one with `chrome.runtime`, so this is the single hop
 * a page has to the background service worker (RR#8: there is no
 * `externally_connectable`). It installs the pure relay that forwards page
 * requests to the background and replays correlated responses + wallet-pushed
 * events back into the page.
 *
 * It does NOT inject the inpage provider: the provider is delivered by a separate
 * `world: "MAIN"` content script (`inpageEntry.ts`), so no `<script>` injection
 * and no `web_accessible_resources` entry are needed (RR#4). This module holds no
 * key material and makes no trust decisions.
 */

import { installContentScriptRelay } from './contentScript';

installContentScriptRelay(window, {
  sendMessage: (message: unknown) => chrome.runtime.sendMessage(message),
  onMessage: {
    addListener: (callback: (message: unknown) => void) =>
      chrome.runtime.onMessage.addListener(callback),
    removeListener: (callback: (message: unknown) => void) =>
      chrome.runtime.onMessage.removeListener(callback),
  },
});
