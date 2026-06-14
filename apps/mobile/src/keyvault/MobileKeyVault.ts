import type { KeyVault, UnlockedKey } from '@stoawallet/core';

/**
 * The mobile in-app-process {@link KeyVault}: custody of the decrypted unlocked
 * secret in APP-PROCESS memory.
 *
 * This is the mobile analogue of the extension's `ServiceWorkerKeyVault`. The
 * unlocked payload is the DECRYPTED MNEMONIC (encoded as bytes) — the signing
 * path re-derives the password-bound `EncryptedString` secret key from it under
 * the wallet password, so the raw private key is never held here long-term. The
 * mnemonic is NEVER persisted plaintext and NEVER logged.
 *
 * Unlike the MV3 service worker, the mobile process is LONG-LIVED — there is no
 * cold-respawn-already-locked safety net. The deliberate exposure bound is the
 * app-background auto-lock (see {@link startAutoLock}), which calls the owning
 * `KeyringManager.lock()` the instant the app resigns active.
 *
 * SECURITY POST-CONDITION (load-bearing): `lock()` CLEARS the secret reference —
 * it does not merely flip a flag. After `lock()` a memory inspection of this
 * vault finds nothing to leak. Idempotent: locking an already-locked vault is a
 * no-op.
 */
export class MobileKeyVault implements KeyVault {
  private unlockedKey: UnlockedKey | null = null;

  async unlock(key: UnlockedKey): Promise<void> {
    this.unlockedKey = key;
  }

  async lock(): Promise<void> {
    // Drop the reference so the secret is no longer resident — the documented
    // post-condition, not a mere boolean flip. Idempotent when already locked.
    this.unlockedKey = null;
  }

  isUnlocked(): boolean {
    return this.unlockedKey !== null;
  }

  getUnlockedKey(): UnlockedKey | null {
    return this.unlockedKey;
  }
}
