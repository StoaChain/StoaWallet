import { describe, expect, it } from 'vitest';

import {
  ACTIVE_ACCOUNT_KEY,
  ADDRESS_BOOK_KEY,
  ADVANCED_MODE_KEY,
  AUTO_LOCK_KEY,
  CROSSCHAIN_INFLIGHT_KEY,
  DAPP_PERMISSIONS_KEY,
  DAPP_RATELIMIT_KEY,
  FORWARD_SEARCH_KEY,
  MINER_AGGREGATION_KEY,
  NODE_PREFERENCE_KEY,
  STORAGE_KEYS,
  VAULT_KEY,
} from '../storageKeys';
// Deliberately imported through the sub-barrel, not the module: the barrel is
// the export surface consumers (and the root barrel's `export * from
// './storage'`) actually see.
import { ADVANCED_MODE_KEY as ADVANCED_MODE_KEY_VIA_BARREL } from '../index';

/**
 * The storage-key registry is the single source of truth for every
 * StorageAdapter key the wallet writes. The assertions below pin the two
 * properties phases actually depend on: no two keys may collide (a collision
 * would silently overwrite one feature's blob with another's), and the
 * node-preference key must equal the EXACT literal Phase-1 `configureNode`
 * already persists under (changing it would orphan an existing preference).
 */
describe('storageKeys', () => {
  it('keeps every registered key pairwise-distinct so no feature can clobber another feature blob', () => {
    const values = Object.values(STORAGE_KEYS);
    // A Set drops duplicates; equal sizes proves no two constants collide.
    expect(new Set(values).size).toBe(values.length);
  });

  it('exposes the node-preference key under the EXACT literal configureNode persisted in Phase 1 so existing preferences are not orphaned', () => {
    // configureNode reads/writes the user's node choice under "node.preference".
    // Reconciling Phase-1's local literal to this constant MUST preserve the
    // byte-for-byte value, otherwise a stored preference becomes unreadable.
    expect(NODE_PREFERENCE_KEY).toBe('node.preference');
  });

  it('namespaces wallet-owned keys under the stoawallet: prefix to resist collisions with host storage', () => {
    // Every NEW key the wallet introduces is namespaced; only NODE_PREFERENCE_KEY
    // is exempt because it predates the registry and must stay byte-stable.
    const namespaced = [
      VAULT_KEY,
      ACTIVE_ACCOUNT_KEY,
      CROSSCHAIN_INFLIGHT_KEY,
      MINER_AGGREGATION_KEY,
      DAPP_PERMISSIONS_KEY,
      DAPP_RATELIMIT_KEY,
      ADDRESS_BOOK_KEY,
      AUTO_LOCK_KEY,
      FORWARD_SEARCH_KEY,
      ADVANCED_MODE_KEY,
    ];
    for (const key of namespaced) {
      expect(key.startsWith('stoawallet:')).toBe(true);
    }
  });

  it('lists every named export in the STORAGE_KEYS registry so the distinctness check covers the whole surface', () => {
    // If a new key constant is added but forgotten in STORAGE_KEYS, the
    // pairwise-distinct guarantee would not cover it. Pin the membership.
    expect(new Set(Object.values(STORAGE_KEYS))).toEqual(
      new Set([
        VAULT_KEY,
        ACTIVE_ACCOUNT_KEY,
        CROSSCHAIN_INFLIGHT_KEY,
        MINER_AGGREGATION_KEY,
        DAPP_PERMISSIONS_KEY,
        DAPP_RATELIMIT_KEY,
        NODE_PREFERENCE_KEY,
        ADDRESS_BOOK_KEY,
        AUTO_LOCK_KEY,
        FORWARD_SEARCH_KEY,
        ADVANCED_MODE_KEY,
      ]),
    );
  });

  it('re-exports ADVANCED_MODE_KEY from the storage sub-barrel so consumers reach it without importing storageKeys directly', () => {
    // The sub-barrel names its exports one by one rather than `export *`, so a
    // key can be registered in STORAGE_KEYS yet still be unreachable from
    // `@stoawallet/core` (whose root barrel re-exports THIS barrel) — that has
    // already happened to three keys. The advanced-mode preference module reads
    // and writes under this key, so an omitted re-export would have it persist
    // under `undefined` instead of the registered key.
    expect(ADVANCED_MODE_KEY_VIA_BARREL).toBe(ADVANCED_MODE_KEY);
    expect(STORAGE_KEYS.ADVANCED_MODE_KEY).toBe(ADVANCED_MODE_KEY_VIA_BARREL);
  });
});
