import { DAPP_PERMISSIONS_KEY, type StorageAdapter } from '@stoawallet/core';

/**
 * Per-origin REJECT-BY-DEFAULT dApp connection allow-list (Phase 9).
 *
 * The wallet exposes accounts and a signing surface to web pages, so an origin
 * is treated as hostile until the USER explicitly approves it. This store is
 * that approval gate: `isAllowed` is the single check every dApp request runs,
 * and it answers `false` for any origin that was never passed to `allow()`.
 * There is no wildcard, no implicit-allow, and no auto-grant path — `allow()`
 * is called by the connect flow only AFTER user approval.
 *
 * Origins are keyed by their CANONICAL serialized origin (scheme+host+port via
 * `new URL(url).origin`), never the full URL. That collapses path/query
 * variations of one site to a single grant and, critically, stops a
 * path-embedded host (`https://evil.com/app.stoachain.com`, origin
 * `https://evil.com`) from masquerading as the impersonated site.
 *
 * The connected set persists through the injected `StorageAdapter` (the
 * extension wires the chrome.storage.local backing) under the shared
 * `DAPP_PERMISSIONS_KEY`, so a service-worker restart re-hydrates the same
 * grants — instantiate with the async `load()` factory, which reads the
 * persisted blob. Only public data is stored: the origin string, optional
 * public account data, and the tabIds an origin connected from (RR#11, so
 * `chrome.tabs.sendMessage` can route events to the right tab). No key material
 * is held or persisted, and nothing stored is ever console-logged.
 */

/** Public, non-secret account data a dApp may be granted visibility of. */
export interface DAppAccount {
  readonly address: string;
  readonly publicKey: string;
}

interface ConnectedOrigin {
  readonly origin: string;
  readonly accounts?: readonly DAppAccount[];
  readonly tabIds: number[];
}

type PersistedState = Record<string, ConnectedOrigin>;

/**
 * Reduce an origin-or-URL to its canonical serialized origin. Throws via
 * `URL` for an unparseable input — callers feed the page's `location.origin`
 * or a full page URL, both of which parse.
 */
function canonicalOrigin(urlOrOrigin: string): string {
  return new URL(urlOrOrigin).origin;
}

export class DAppPermissionStore {
  private constructor(
    private readonly adapter: StorageAdapter,
    private readonly connected: Map<string, ConnectedOrigin>,
  ) {}

  /**
   * Hydrate a store from the persisted blob under `DAPP_PERMISSIONS_KEY`. A
   * missing or unparseable blob yields an empty allow-list — the safe default,
   * since an empty set rejects every origin.
   */
  static async load(adapter: StorageAdapter): Promise<DAppPermissionStore> {
    const connected = new Map<string, ConnectedOrigin>();
    const raw = await adapter.get(DAPP_PERMISSIONS_KEY);
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as PersistedState;
        for (const [origin, entry] of Object.entries(parsed)) {
          connected.set(origin, {
            origin: entry.origin,
            accounts: entry.accounts,
            tabIds: Array.isArray(entry.tabIds) ? [...entry.tabIds] : [],
          });
        }
      } catch {
        // A corrupt blob falls back to the reject-everything empty set rather
        // than throwing the service worker into a crash loop.
      }
    }
    return new DAppPermissionStore(adapter, connected);
  }

  async isAllowed(origin: string): Promise<boolean> {
    return this.connected.has(canonicalOrigin(origin));
  }

  async allow(
    origin: string,
    accounts?: readonly DAppAccount[],
    tabId?: number,
  ): Promise<void> {
    const key = canonicalOrigin(origin);
    const existing = this.connected.get(key);

    const tabIds = existing ? [...existing.tabIds] : [];
    if (tabId !== undefined && !tabIds.includes(tabId)) {
      tabIds.push(tabId);
    }

    this.connected.set(key, {
      origin: key,
      accounts: accounts ?? existing?.accounts,
      tabIds,
    });
    await this.persist();
  }

  async revoke(origin: string): Promise<void> {
    this.connected.delete(canonicalOrigin(origin));
    await this.persist();
  }

  /** User-facing alias of `revoke` for the management/disconnect UI. */
  async disconnect(origin: string): Promise<void> {
    await this.revoke(origin);
  }

  async listAllowed(): Promise<string[]> {
    return [...this.connected.keys()];
  }

  /** The tabIds an origin connected from, for routing events to its tabs (RR#11). */
  async tabIdsForOrigin(origin: string): Promise<number[]> {
    const entry = this.connected.get(canonicalOrigin(origin));
    return entry ? [...entry.tabIds] : [];
  }

  /**
   * The public account(s) the USER approved exposing to this origin at connect
   * time — the persisted subset, NOT a global wallet set. Empty when the origin
   * is not connected or no accounts were granted. Used by `kda_checkStatus` so a
   * page reads back exactly the subset it was granted.
   */
  async accountsForOrigin(origin: string): Promise<readonly DAppAccount[]> {
    const entry = this.connected.get(canonicalOrigin(origin));
    return entry?.accounts ? [...entry.accounts] : [];
  }

  private async persist(): Promise<void> {
    const state: PersistedState = {};
    for (const [origin, entry] of this.connected) {
      state[origin] = entry;
    }
    await this.adapter.set(DAPP_PERMISSIONS_KEY, JSON.stringify(state));
  }
}
