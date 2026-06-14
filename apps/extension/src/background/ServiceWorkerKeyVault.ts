import type { KeyVault, UnlockedKey } from '@stoawallet/core';

/**
 * The Chrome MV3 service-worker {@link KeyVault}: custody of the decrypted
 * unlocked key in WORKER memory only.
 *
 * This is the extension's concrete in-memory vault. It deliberately lives in the
 * background bundle so the unlocked key never enters the popup context — the
 * popup talks to the worker over `chrome.runtime`, and the key stays here behind
 * that boundary. On a worker respawn this object is reconstructed empty, so a
 * cold worker is locked until the next unlock.
 *
 * SECURITY POST-CONDITION (load-bearing): `lock()` CLEARS the key reference — it
 * does not merely flip a flag. After `lock()` a memory inspection of this vault
 * finds nothing to leak. The key is NEVER logged or serialized.
 */
export class ServiceWorkerKeyVault implements KeyVault {
  private unlockedKey: UnlockedKey | null = null;

  async unlock(key: UnlockedKey): Promise<void> {
    this.unlockedKey = key;
  }

  async lock(): Promise<void> {
    // Drop the reference so the key is no longer resident — the documented
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
