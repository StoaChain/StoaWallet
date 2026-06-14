import type {
  KeyVault,
  StorageAdapter,
  StoredBlob,
  UnlockedKey,
} from '../storage';

/**
 * Test-only doubles proving the storage contract is implementable.
 *
 * These live in test/support code, NOT production: the real backers
 * (chrome.storage, Capacitor secure storage / keychain) arrive in later phases.
 * Their only job here is to type-check against the interfaces and exercise the
 * documented runtime behavior — especially the `lock()`-clears-key
 * post-condition.
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  private readonly store = new Map<string, StoredBlob>();

  async get(key: string): Promise<StoredBlob | null> {
    return this.store.has(key) ? (this.store.get(key) as StoredBlob) : null;
  }

  async set(key: string, value: StoredBlob): Promise<void> {
    this.store.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class InMemoryKeyVault implements KeyVault {
  private unlockedKey: UnlockedKey | null = null;

  async unlock(key: UnlockedKey): Promise<void> {
    this.unlockedKey = key;
  }

  async lock(): Promise<void> {
    // Drop the reference so the key is no longer resident in vault state —
    // the documented post-condition, not a mere boolean flip.
    this.unlockedKey = null;
  }

  isUnlocked(): boolean {
    return this.unlockedKey !== null;
  }

  getUnlockedKey(): UnlockedKey | null {
    return this.unlockedKey;
  }
}
