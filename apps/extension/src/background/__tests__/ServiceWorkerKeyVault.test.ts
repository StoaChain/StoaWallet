import { describe, expect, it } from 'vitest';

import type { KeyVault } from '@stoawallet/core';

import { ServiceWorkerKeyVault } from '../ServiceWorkerKeyVault';

/**
 * The service-worker KeyVault holds the decrypted unlocked key ONLY in worker
 * memory. The load-bearing invariant is the `lock()` post-condition: the key
 * must be CLEARED (so a post-lock memory inspection finds nothing), not merely
 * flagged locked.
 */
describe('ServiceWorkerKeyVault', () => {
  it('is assignable to the core KeyVault contract', () => {
    const vault: KeyVault = new ServiceWorkerKeyVault();
    expect(typeof vault.unlock).toBe('function');
    expect(typeof vault.lock).toBe('function');
  });

  it('starts locked: isUnlocked is false and getUnlockedKey is null', () => {
    const vault = new ServiceWorkerKeyVault();
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.getUnlockedKey()).toBeNull();
  });

  it('unlock loads the exact key bytes so the signing path reads back what was stored', async () => {
    const vault = new ServiceWorkerKeyVault();
    const key = new Uint8Array([1, 2, 3, 250, 255]);
    await vault.unlock(key);
    expect(vault.isUnlocked()).toBe(true);
    expect(vault.getUnlockedKey()).toEqual(key);
  });

  it('lock CLEARS the key (not just a flag): getUnlockedKey is null after lock so nothing leaks', async () => {
    const vault = new ServiceWorkerKeyVault();
    await vault.unlock(new Uint8Array([9, 9, 9]));
    await vault.lock();
    expect(vault.isUnlocked()).toBe(false);
    expect(vault.getUnlockedKey()).toBeNull();
  });

  it('lock is idempotent: locking an already-locked vault is a no-op', async () => {
    const vault = new ServiceWorkerKeyVault();
    await vault.lock();
    await expect(vault.lock()).resolves.toBeUndefined();
    expect(vault.isUnlocked()).toBe(false);
  });
});
