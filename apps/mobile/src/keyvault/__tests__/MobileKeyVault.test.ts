import { describe, expect, it, vi } from 'vitest';

import {
  KeyringManager,
  deriveAccount,
  type KeyVault,
} from '@stoawallet/core';

import { MobileKeyVault } from '../MobileKeyVault';
import { startAutoLock, type AppLifecycle } from '../startAutoLock';

/**
 * Unit tests for the mobile in-app-process KeyVault + app-background auto-lock.
 *
 * The KeyringManager + KeyVault + crypto are REAL (the proven derive → encrypt →
 * unlock → re-derive path). Only TWO boundaries are doubled:
 *   - at-rest storage: an in-memory StorageAdapter double (the T8.1 adapter is
 *     itself just I/O; here we need a fast in-process store);
 *   - `@capacitor/app` lifecycle: a fake `AppLifecycle` that CAPTURES the
 *     registered listeners so a test can fire a backgrounding event on demand.
 *
 * A fixed 24-word koala test mnemonic gives a deterministic at-rest account key
 * to assert the post-unlock re-derivation round-trip against.
 */

const PASSWORD = 'correct horse battery staple';

/** A minimal in-memory StorageAdapter double (the at-rest envelope store). */
class InMemoryStore {
  private readonly map = new Map<string, string | Uint8Array>();
  async get(key: string): Promise<string | Uint8Array | null> {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  async set(key: string, value: string | Uint8Array): Promise<void> {
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/**
 * Fake `@capacitor/app` lifecycle. Captures listeners by event name so a test
 * can synchronously fire the backgrounding event the auto-lock subscribes to.
 */
function makeFakeApp(): AppLifecycle & {
  fireAppStateChange: (isActive: boolean) => void;
  firePause: () => void;
  listenerCount: number;
} {
  const stateListeners: Array<(s: { isActive: boolean }) => void> = [];
  const pauseListeners: Array<() => void> = [];
  return {
    async addListener(eventName: string, fn: (...args: never[]) => void) {
      // Mirror the real plugin: addListener returns a handle whose remove()
      // unregisters THIS listener, so a removed listener never fires again.
      const bucket =
        eventName === 'appStateChange'
          ? (stateListeners as Array<(...a: never[]) => void>)
          : eventName === 'pause'
            ? (pauseListeners as Array<(...a: never[]) => void>)
            : null;
      if (bucket) bucket.push(fn);
      return {
        remove: async () => {
          if (!bucket) return;
          const i = bucket.indexOf(fn);
          if (i >= 0) bucket.splice(i, 1);
        },
      };
    },
    fireAppStateChange(isActive: boolean) {
      for (const l of stateListeners) l({ isActive });
    },
    firePause() {
      for (const l of pauseListeners) l();
    },
    get listenerCount() {
      return stateListeners.length + pauseListeners.length;
    },
  } as AppLifecycle & {
    fireAppStateChange: (isActive: boolean) => void;
    firePause: () => void;
    listenerCount: number;
  };
}

/** Create a wallet on a fresh manager, leaving it unlocked, and return context. */
async function makeUnlockedWallet() {
  const storage = new InMemoryStore();
  const keyVault = new MobileKeyVault();
  const manager = new KeyringManager({ storage, keyVault });
  const { walletId, account } = await manager.createWallet(PASSWORD);
  return { storage, keyVault, manager, walletId, account };
}

describe('MobileKeyVault', () => {
  it('is assignable to the core KeyVault contract so the KeyringManager can consume it', () => {
    const vault: KeyVault = new MobileKeyVault();
    expect(typeof vault.unlock).toBe('function');
    expect(typeof vault.lock).toBe('function');
    expect(typeof vault.isUnlocked).toBe('function');
    expect(typeof vault.getUnlockedKey).toBe('function');
  });

  it('unlock with the correct password populates the vault so isUnlocked() is true', async () => {
    const { manager, keyVault, walletId, storage } = await makeUnlockedWallet();
    // Re-open over the same at-rest store and unlock — proves the real unlock
    // path populates THIS concrete vault, not just the create-time state.
    const reopened = new KeyringManager({ storage, keyVault: new MobileKeyVault() });
    const reopenedVault = (reopened as unknown as { keyVault: MobileKeyVault }).keyVault;
    expect(reopenedVault.isUnlocked()).toBe(false);

    await reopened.unlock(walletId, PASSWORD);
    expect(reopenedVault.isUnlocked()).toBe(true);
    expect(reopenedVault.getUnlockedKey()).not.toBeNull();

    // sanity: the original manager held the wallet unlocked too
    expect(keyVault.isUnlocked()).toBe(true);
    void manager;
  });

  it('re-derives a public key EQUAL to the at-rest account key after unlock (never under "")', async () => {
    const { storage, walletId, account } = await makeUnlockedWallet();

    // A fresh manager unlocks with the password, then signing re-derives the
    // keypair from the in-memory mnemonic. The derived public key MUST equal the
    // public key persisted at rest — the Phase-2/Phase-7 round-trip.
    const keyVault = new MobileKeyVault();
    const reopened = new KeyringManager({ storage, keyVault });
    await reopened.unlock(walletId, PASSWORD);

    const keypairs = await reopened.resolveActiveSigningKeypairs();
    expect(keypairs[0].publicKey).toBe(account.publicKey);

    // And the same triple re-derives the identical public key directly — proving
    // the round-trip is deterministic and bound to the wallet password, not "".
    const mnemonicBytes = keyVault.getUnlockedKey()!;
    const mnemonic = new TextDecoder().decode(mnemonicBytes);
    const direct = await deriveAccount(mnemonic, PASSWORD, account.index);
    expect(direct.publicKey).toBe(account.publicKey);
  });

  it('lock() clears the mnemonic so isUnlocked() is false and the getter is null', async () => {
    const { keyVault } = await makeUnlockedWallet();
    expect(keyVault.isUnlocked()).toBe(true);

    await keyVault.lock();
    expect(keyVault.isUnlocked()).toBe(false);
    expect(keyVault.getUnlockedKey()).toBeNull();
  });

  it('lock() is idempotent so a double background event cannot error', async () => {
    const vault = new MobileKeyVault();
    await vault.lock();
    await expect(vault.lock()).resolves.toBeUndefined();
    expect(vault.isUnlocked()).toBe(false);
  });
});

describe('startAutoLock (app-background clear-on-background)', () => {
  it('subscribes to the lifecycle and locks BOTH manager and keyvault on background', async () => {
    const { manager, keyVault, account } = await makeUnlockedWallet();
    const app = makeFakeApp();

    await startAutoLock({ app, manager });
    expect(app.listenerCount).toBeGreaterThan(0);

    // Pre-condition: unlocked, manager can re-derive secrets.
    expect(keyVault.isUnlocked()).toBe(true);

    // Backgrounding (app no longer active) must clear the FULL secret.
    app.fireAppStateChange(false);
    // The auto-lock awaits manager.lock(); give the microtask queue a turn.
    await Promise.resolve();
    await Promise.resolve();

    expect(keyVault.isUnlocked()).toBe(false);
    expect(keyVault.getUnlockedKey()).toBeNull();

    // The manager's OWN secret is cleared too: a locked manager refuses to
    // resolve signing keypairs (WalletLockedError), proving manager.lock() ran —
    // clearing the KeyVault alone would be insufficient.
    await expect(reResolve(manager)).rejects.toMatchObject({
      name: 'WalletLockedError',
    });
    void account;
  });

  it('does NOT lock when the app becomes active (foreground) so a resume keeps the session', async () => {
    const { manager, keyVault } = await makeUnlockedWallet();
    const app = makeFakeApp();
    await startAutoLock({ app, manager });

    app.fireAppStateChange(true);
    await Promise.resolve();

    expect(keyVault.isUnlocked()).toBe(true);
  });

  it('locks on the pause lifecycle event (iOS background) as well', async () => {
    const { manager, keyVault } = await makeUnlockedWallet();
    const app = makeFakeApp();
    await startAutoLock({ app, manager });

    app.firePause();
    await Promise.resolve();
    await Promise.resolve();

    expect(keyVault.isUnlocked()).toBe(false);
  });

  it('invokes the iOS-snapshot hook on resign-active so the app entry can render a privacy overlay', async () => {
    const { manager } = await makeUnlockedWallet();
    const app = makeFakeApp();
    const onResignActive = vi.fn();

    await startAutoLock({ app, manager, onResignActive });

    app.fireAppStateChange(false);
    await Promise.resolve();

    expect(onResignActive).toHaveBeenCalledTimes(1);
  });

  it('stop() removes the lifecycle subscriptions so a torn-down session no longer auto-locks', async () => {
    const { manager, keyVault } = await makeUnlockedWallet();
    const app = makeFakeApp();
    const handle = await startAutoLock({ app, manager });

    await handle.stop();
    app.fireAppStateChange(false);
    await Promise.resolve();

    // After stop(), a background event is ignored — the session stays unlocked.
    expect(keyVault.isUnlocked()).toBe(true);
  });

  it('never console-logs the mnemonic or private key across unlock → sign → background → lock', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );

    const { manager, keyVault, account } = await makeUnlockedWallet();
    const app = makeFakeApp();
    await startAutoLock({ app, manager });

    const mnemonic = new TextDecoder().decode(keyVault.getUnlockedKey()!);
    const keypairs = await manager.resolveActiveSigningKeypairs();
    const privateKey = keypairs[0].privateKey;

    app.fireAppStateChange(false);
    await Promise.resolve();
    await Promise.resolve();

    const secrets = [mnemonic, privateKey, account.publicKey === '' ? 'x' : account.publicKey];
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const joined = call.map((a) => String(a)).join(' ');
        expect(joined).not.toContain(mnemonic);
        expect(joined).not.toContain(privateKey);
      }
    }
    void secrets;
  });
});

/** Re-resolve signing keypairs; used to prove the manager secret was cleared. */
function reResolve(manager: KeyringManager): Promise<unknown> {
  return manager.resolveActiveSigningKeypairs();
}
