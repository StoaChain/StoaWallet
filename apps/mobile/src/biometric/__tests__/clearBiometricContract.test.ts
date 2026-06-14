import { describe, expect, it, vi } from 'vitest';

import {
  BIOMETRIC_PASSWORD_KEY,
  BIOMETRIC_ENROLLMENT_KEY,
  CapacitorBiometricUnlock,
  type SecureStorageBackend,
} from '../CapacitorBiometricUnlock';

/**
 * RR#2 — biometric REVOCATION contract.
 *
 * `clearBiometric()` revokes the biometric-sealed vault password and enrollment
 * snapshot. It MUST be invoked by any flow that re-keys the vault — a wallet
 * RESET or a password CHANGE — so a stale biometric secret can never unlock a
 * changed vault.
 *
 * Those host flows do NOT exist in the codebase yet (there is no `resetWallet` /
 * `changePassword` action in KeyringManager or WalletContext — see
 * MOBILE_BUILD.md and the buildBiometric() note in main.tsx). This suite
 * therefore pins the CONTRACT the host flow must honor, using a `revokeOnRekey`
 * stand-in for the not-yet-built reset/password-change action: calling it MUST
 * leave secure storage with no sealed password or enrollment. When the real flow
 * lands, replace `revokeOnRekey` with it (calling `biometric.clearBiometric()`)
 * and the same assertions hold.
 */
const PASSWORD = 'correct horse battery staple';

function makeSecureStorage(): SecureStorageBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get({ key }) {
      if (!store.has(key)) {
        return Promise.reject(new Error('Item with given key does not exist'));
      }
      return { value: store.get(key)! };
    },
    async set({ key, value }) {
      store.set(key, value);
      return { value: true };
    },
    async remove({ key }) {
      const had = store.has(key);
      store.delete(key);
      return { value: had };
    },
  };
}

function makeAuth() {
  return {
    checkBiometry: vi.fn(async () => ({
      isAvailable: true,
      biometryType: 2,
      biometryTypes: [2],
    })),
    authenticate: vi.fn(async () => undefined),
  };
}

/**
 * Stand-in for the not-yet-built wallet-reset / password-change action. The
 * REAL action, when added, must invoke `biometric.clearBiometric()` exactly like
 * this so the sealed secret is revoked on re-key.
 */
async function revokeOnRekey(biometric: CapacitorBiometricUnlock): Promise<void> {
  await biometric.clearBiometric();
}

describe('biometric revocation contract (RR#2)', () => {
  it('a wallet re-key (reset / password-change) must revoke the sealed password and enrollment', async () => {
    const storage = makeSecureStorage();
    const bio = new CapacitorBiometricUnlock({
      auth: makeAuth(),
      storage,
      verifyPassword: async (c) => c === PASSWORD,
    });

    await bio.enableBiometric(PASSWORD);
    // Pre-condition: the secret IS sealed, so revocation has something to clear.
    expect(storage.store.has(BIOMETRIC_PASSWORD_KEY)).toBe(true);
    expect(storage.store.has(BIOMETRIC_ENROLLMENT_KEY)).toBe(true);

    await revokeOnRekey(bio);

    // After a re-key the sealed password AND enrollment snapshot are gone, so a
    // stale biometric secret can never unlock the changed vault.
    expect(storage.store.has(BIOMETRIC_PASSWORD_KEY)).toBe(false);
    expect(storage.store.has(BIOMETRIC_ENROLLMENT_KEY)).toBe(false);
    await expect(bio.isAvailable()).resolves.toBe(false);
    await expect(bio.unlock()).resolves.toEqual({
      ok: false,
      reason: 'biometric-unavailable',
    });
  });

  it('revocation is idempotent — a re-key with nothing sealed is a clean no-op (reset before enable)', async () => {
    const storage = makeSecureStorage();
    const bio = new CapacitorBiometricUnlock({
      auth: makeAuth(),
      storage,
      verifyPassword: async (c) => c === PASSWORD,
    });

    // A reset/password-change can fire when biometric was never enabled; the
    // revocation contract must absorb the plugin's reject-on-missing-key rather
    // than throw, so the host flow never has to special-case it.
    await expect(revokeOnRekey(bio)).resolves.toBeUndefined();
    expect(storage.store.has(BIOMETRIC_PASSWORD_KEY)).toBe(false);
  });
});
