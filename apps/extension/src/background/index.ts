// Buffer polyfill MUST be the very first import (RR#11): every @stoachain crypto
// module loaded by this service worker (and everything it transitively imports —
// the KeyringManager, the signing path) assumes a `Buffer` global. The upstream
// polyfill is tree-shaken out of the production bundle unless something
// references it BEFORE any crypto code runs, so it leads this file ahead of the
// @stoawallet/core (and thus @stoachain/*) imports below. T7.7 is the runtime proof.
import '@stoawallet/core/build/polyfills';

import { KeyringManager, configureNode } from '@stoawallet/core';

import { ChromeStorageAdapter } from '../storage/ChromeStorageAdapter';
import { DAppPermissionStore, type DAppAccount } from '../dapp/permissionStore';
import { RequestRateLimiter } from '../dapp/rateLimiter';
import { createDappRouter, type DappRouter } from '../dapp/dappRouter';
import { createBackgroundCommandSigner } from '../dapp/backgroundCommandSigner';
import { DAPP_CHANNEL, type DappEvent } from '../dapp/protocol';
import { KADENA_NETWORK } from '@stoachain/stoa-core/constants';

import { createBackground } from './createBackground';
import { createApprovalTokenRegistry } from './approvalTokens';
import { createChromeApprovalGateway } from './chromeApprovalGateway';
import { ServiceWorkerKeyVault } from './ServiceWorkerKeyVault';

/**
 * MV3 background service worker — the wallet's SECURE context.
 *
 * The unlocked secret (decrypted mnemonic + wallet password) lives ONLY here, in
 * the KeyringManager's private state and the {@link ServiceWorkerKeyVault}, both
 * cleared by `lock()`. The popup is a thin view that drives this worker over
 * `chrome.runtime` messages; it never holds key material.
 *
 * The worker:
 *   - validates the sender of every message (RR#1) — only this extension's own
 *     contexts may drive the keyring;
 *   - routes trusted requests to the manager and replies with secret-free data;
 *   - auto-locks on system idle (RR#4) via `chrome.idle`, re-arming on activity;
 *   - boots the node failover from the persisted preference (XP-13).
 *
 * On a COLD RESPAWN the in-memory mnemonic is gone: a fresh manager + KeyVault are
 * constructed over the SAME `chrome.storage.local` at-rest vault, so `isUnlocked`
 * reports false until the popup unlocks again.
 */

const storage = new ChromeStorageAdapter();
const keyVault = new ServiceWorkerKeyVault();
const manager = new KeyringManager({ storage, keyVault });

// The single-use approval-token registry (XP-3) is shared between the dApp
// command-signer (which consumes a token per approved sign) and the popup
// approval hook (which mints one on approve) through the background surface.
const approvalTokens = createApprovalTokenRegistry();

/**
 * The wallet's CURRENT default dApp accounts — the active `k:` account, read live
 * from the manager. The dApp router constructs BEFORE the vault is unlocked, so a
 * static set captured then is empty/stale; this is consulted at request time so a
 * fresh connect (and `kda_checkStatus`) exposes the REAL active account. Only
 * public fields cross — never key material. A locked/empty vault yields `[]`.
 */
function currentDappAccounts(): readonly DAppAccount[] {
  const active = manager.getActiveAccount();
  if (active === null) return [];
  return [{ address: active.account, publicKey: active.publicKey }];
}

// The dApp permission store loads asynchronously (it rehydrates the persisted
// allow-list). The MV3 listener must register SYNCHRONOUSLY, so we expose the
// router behind a ready-promise: the dApp branch of handleMessage awaits it,
// and replies are still delivered on the open channel.
const dappRouterReady: Promise<DappRouter> = (async () => {
  const store = await DAppPermissionStore.load(storage);
  const limiter = new RequestRateLimiter();

  return createDappRouter({
    store,
    limiter,
    adapter: storage,
    // The PRODUCTION approval gateway: opens the framing-safe approval.html popup,
    // resolves on the user's `approval-decision` (matched by nonce, RR#2) or on a
    // window dismiss (RR#13), and mints the single-use sign token (XP-3) on the
    // SECURE side from the SAME registry the command-signer consumes from.
    approvals: createChromeApprovalGateway({
      chromeWindows: chrome.windows,
      chromeRuntime: chrome.runtime,
      approvalTokens,
      getConnectAccounts: () => currentDappAccounts().map((a) => a.address),
      isLocked: () => !keyVault.isUnlocked(),
      approvalUrl: chrome.runtime.getURL('src/approval/approval.html'),
    }),
    signer: createBackgroundCommandSigner({ manager, keyVault, approvalTokens }),
    messenger: {
      sendToTab(tabId: number, message: DappEvent) {
        // The content-script relay only re-posts a message that matches the
        // EVENT ENVELOPE shape (`isEventEnvelope`): a raw `DappEvent` is dropped.
        // Wrap it so the event reaches the page, with the event payload on `data`
        // (which the inpage provider dispatches to `on(...)` handlers).
        const envelope = {
          channel: DAPP_CHANNEL,
          direction: 'to-page' as const,
          kind: 'event' as const,
          event: message.event,
          data: 'accounts' in message ? message.accounts : undefined,
        };
        void chrome.tabs.sendMessage(tabId, envelope).catch(() => {
          // A torn-down tab has no receiver; dropping the event is correct — the
          // page reconnects on its next load.
        });
      },
    },
    runtimeId: chrome.runtime.id,
    networkId: KADENA_NETWORK,
    // A static fallback only; the live active account is sourced via the provider.
    grantedAccounts: [],
    accountsProvider: currentDappAccounts,
  });
})();

const background = createBackground({
  manager,
  keyVault,
  runtimeId: chrome.runtime.id,
  configureNode,
  storage,
  approvalTokens,
  dappRouter: {
    async handle(request, sender) {
      const router = await dappRouterReady;
      return router.handle(request, sender);
    },
    async hydrate() {
      const router = await dappRouterReady;
      await router.hydrate();
    },
  },
  // SG-004: a popup active-account switch pushes `accountsChanged` (the new public
  // `k:` account) to EVERY connected origin's tabs, so live wallet switches reach
  // connected dApps (EIP-1193 parity). Each origin is routed only its own tabs.
  onActiveAccountChanged(account) {
    void (async () => {
      const router = await dappRouterReady;
      const store = await DAppPermissionStore.load(storage);
      const origins = await store.listAllowed();
      for (const origin of origins) {
        await router.notifyAccountsChanged(origin, [account.account]);
      }
    })();
  },
});

// Register the message router. The listener returns `true` so the runtime keeps
// the channel open for the async sendResponse (the MV3 contract).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
  background.handleMessage(message, sender, sendResponse),
);

// Boot: configure the node failover (XP-13) and arm the idle auto-lock. Fire and
// forget — `start()` swallows nothing security-relevant, and a boot rejection
// must not take down message handling (which is already registered above).
void background.start();
