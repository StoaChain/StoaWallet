/**
 * The in-memory unlocked-key lifecycle, kept DISTINCT from at-rest
 * persistence (see `StorageAdapter`).
 *
 * `StorageAdapter` owns the encrypted envelope on disk; `KeyVault` owns the
 * decrypted key while the wallet is unlocked. These are separate concerns and
 * separate lifetimes: on the extension the unlocked key must live in the
 * background service-worker context (never in the popup), and on mobile it
 * lives behind the OS keychain/keystore. Splitting the interfaces lets each
 * platform place the unlocked key where its security model requires without
 * forking the UI.
 *
 * NEVER log or serialize the unlocked key. It exists only to be read in-memory
 * by the signing path while unlocked.
 */

/**
 * The decrypted, in-memory key material exposed while the vault is unlocked.
 *
 * Modeled as raw bytes (the ED25519 secret / seed-derived material) rather
 * than a typed wallet object: the vault's job is custody of the secret, not
 * interpreting it. Concrete impls may unlock with a key derived from the
 * envelope; the type stays opaque here.
 */
export type UnlockedKey = Uint8Array;

export interface KeyVault {
  /**
   * Load `key` into memory and mark the vault unlocked. After this,
   * `isUnlocked()` is `true` and `getUnlockedKey()` returns `key`.
   */
  unlock(key: UnlockedKey): Promise<void>;

  /**
   * Lock the vault.
   *
   * POST-CONDITION (load-bearing): this CLEARS the in-memory unlocked key — it
   * does not merely flip a flag. After `lock()`:
   *   - `isUnlocked()` returns `false`, and
   *   - `getUnlockedKey()` returns `null`.
   * The key must not remain resident in vault state, so a memory inspection
   * after lock finds nothing to leak. Idempotent: locking an already-locked
   * vault is a no-op.
   */
  lock(): Promise<void>;

  /** Whether the vault currently holds an unlocked key in memory. */
  isUnlocked(): boolean;

  /**
   * The in-memory unlocked key, or `null` when locked. Callers gate signing on
   * a non-null result; a locked vault MUST return `null` (never a stale key).
   */
  getUnlockedKey(): UnlockedKey | null;
}
