/**
 * The single registry of every `StorageAdapter` key the wallet persists under.
 *
 * Every phase imports its key from here rather than inlining a string literal:
 * a stray literal that drifts from another phase's literal silently splits or
 * clobbers a feature's blob, and such collisions are invisible at the call
 * site. Centralizing the keys makes the `storageKeys.test.ts` pairwise-distinct
 * check the one place a collision is caught.
 *
 * New wallet-owned keys are namespaced under `stoawallet:` to avoid colliding
 * with anything the host (chrome.storage / Capacitor Preferences) writes.
 * `NODE_PREFERENCE_KEY` is the one exception: it predates this registry and is
 * kept byte-for-byte identical to the literal Phase-1 `configureNode` already
 * reads, so an existing persisted preference stays readable after reconciliation.
 */

/** The multi-wallet vault blob (the encrypted envelope of all StoredWallets). */
export const VAULT_KEY = 'stoawallet:vault';

/**
 * The active-account pointer, persisted SEPARATELY from the vault blob so the
 * UI can switch accounts without rewriting (and re-encrypting) the whole vault.
 * The active-WALLET pointer lives inside the vault; this is the per-wallet
 * active-ACCOUNT selection.
 */
export const ACTIVE_ACCOUNT_KEY = 'stoawallet:active-account';

/** In-flight cross-chain transfer state for resumable SPV continuation (Phase 5). */
export const CROSSCHAIN_INFLIGHT_KEY = 'stoawallet:crosschain:inflight';

/** Miner reward aggregation namespace (Phase 11). */
export const MINER_AGGREGATION_KEY = 'stoawallet:miner:aggregation';

/** Granted dApp connection permissions (Phase 9). */
export const DAPP_PERMISSIONS_KEY = 'stoawallet:dapp:permissions';

/** Per-dApp request rate-limit accounting (Phase 9). */
export const DAPP_RATELIMIT_KEY = 'stoawallet:dapp:ratelimit';

/**
 * The user's node-failover preference (Phase 10). Byte-identical to the literal
 * `configureNode` persisted in Phase 1 — DO NOT renamespace this; changing it
 * orphans any preference already on disk.
 */
export const NODE_PREFERENCE_KEY = 'node.preference';

/** The saved recipient address book — named `k:` addresses (non-secret config). */
export const ADDRESS_BOOK_KEY = 'stoawallet:address-book';

/** The auto-lock window in minutes — non-secret config (how long until self-lock). */
export const AUTO_LOCK_KEY = 'stoawallet:auto-lock';

/**
 * Frozen map of every registered key. The distinctness invariant is asserted
 * over THIS object so a newly-added constant that is forgotten here is also
 * (deliberately) excluded from the guarantee — keeping the registry honest.
 */
export const STORAGE_KEYS = {
  VAULT_KEY,
  ACTIVE_ACCOUNT_KEY,
  CROSSCHAIN_INFLIGHT_KEY,
  MINER_AGGREGATION_KEY,
  DAPP_PERMISSIONS_KEY,
  DAPP_RATELIMIT_KEY,
  NODE_PREFERENCE_KEY,
  ADDRESS_BOOK_KEY,
  AUTO_LOCK_KEY,
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
