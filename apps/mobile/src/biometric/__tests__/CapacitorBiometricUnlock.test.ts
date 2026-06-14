import { UnsupportedBiometricUnlock } from '@stoawallet/core';
import { describe, expect, it, vi } from 'vitest';

import {
  BIOMETRIC_PASSWORD_KEY,
  BIOMETRIC_ENROLLMENT_KEY,
  CapacitorBiometricUnlock,
  type BiometricAuthBackend,
  type SecureStorageBackend,
} from '../CapacitorBiometricUnlock';

const PASSWORD = 'correct horse battery staple';

/**
 * Plugin doubles. The real plugins (`@aparajita/capacitor-biometric-auth`,
 * `capacitor-secure-storage-plugin`) only run inside a native WebView, so these
 * stand in for the exact surface `CapacitorBiometricUnlock` consumes — modelled
 * faithfully on the real contracts (secure-storage `get` REJECTS on a missing
 * key; `authenticate()` REJECTS with a coded error on cancel/failure).
 */
function makeBiometryResult(over: Partial<{
  isAvailable: boolean;
  biometryType: number;
  biometryTypes: number[];
}> = {}) {
  return {
    isAvailable: true,
    strongBiometryIsAvailable: true,
    biometryType: 2,
    biometryTypes: [2],
    deviceIsSecure: true,
    reason: '',
    code: '',
    ...over,
  };
}

function makeSecureStorage(): SecureStorageBackend & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    async get({ key }) {
      if (!store.has(key)) {
        // Faithful to the native plugin: a missing key REJECTS, it does not
        // resolve an empty value.
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

function makeBiometricAuth(): BiometricAuthBackend & {
  checkBiometry: ReturnType<typeof vi.fn>;
  authenticate: ReturnType<typeof vi.fn>;
} {
  return {
    checkBiometry: vi.fn(async () => makeBiometryResult()),
    authenticate: vi.fn(async () => undefined),
  };
}

/**
 * A verifier that only accepts the canonical PASSWORD. Mirrors the real
 * enable-time check: the password must decrypt the vault before we seal it
 * behind biometrics, so a wrong password is never stored.
 */
function makeVerifier() {
  return vi.fn(async (candidate: string) => candidate === PASSWORD);
}

describe('CapacitorBiometricUnlock.isAvailable', () => {
  it('resolves true only when the plugin reports enrolled biometrics AND a password has been sealed', async () => {
    const auth = makeBiometricAuth();
    const storage = makeSecureStorage();
    const bio = new CapacitorBiometricUnlock({
      auth,
      storage,
      verifyPassword: makeVerifier(),
    });

    // No password sealed yet → even with enrolled biometry the affordance must
    // stay hidden (there is nothing to return on unlock).
    await expect(bio.isAvailable()).resolves.toBe(false);

    await bio.enableBiometric(PASSWORD);
    await expect(bio.isAvailable()).resolves.toBe(true);
  });

  it('resolves false (never throws) when the plugin reports no enrolled biometry', async () => {
    const auth = makeBiometricAuth();
    auth.checkBiometry.mockResolvedValue(
      makeBiometryResult({ isAvailable: false, biometryType: 0, biometryTypes: [] }),
    );
    const storage = makeSecureStorage();
    const bio = new CapacitorBiometricUnlock({
      auth,
      storage,
      verifyPassword: makeVerifier(),
    });
    await bio.enableBiometric(PASSWORD);

    // Enrollment was removed at the OS level after enable: the probe reports no
    // biometry, so the UI must hide the affordance rather than offer a button
    // that would immediately fail.
    await expect(bio.isAvailable()).resolves.toBe(false);
  });

  it('resolves false when the capability probe itself throws, so it can never break the unlock screen', async () => {
    const auth = makeBiometricAuth();
    auth.checkBiometry.mockRejectedValue(new Error('probe blew up'));
    const storage = makeSecureStorage();
    const bio = new CapacitorBiometricUnlock({
      auth,
      storage,
      verifyPassword: makeVerifier(),
    });
    await expect(bio.isAvailable()).resolves.toBe(false);
  });
});

describe('CapacitorBiometricUnlock.enableBiometric', () => {
  it('verifies the wallet password BEFORE sealing it, and stores it only when it verifies', async () => {
    const auth = makeBiometricAuth();
    const storage = makeSecureStorage();
    const verify = makeVerifier();
    const bio = new CapacitorBiometricUnlock({
      auth,
      storage,
      verifyPassword: verify,
    });

    await bio.enableBiometric(PASSWORD);

    // The password is verified against the vault first — a write that skipped
    // verification could seal a password that never unlocks the wallet.
    expect(verify).toHaveBeenCalledWith(PASSWORD);
    expect(storage.store.get(BIOMETRIC_PASSWORD_KEY)).toBe(PASSWORD);
  });

  it('refuses to seal a password that does not verify, leaving secure storage empty', async () => {
    const auth = makeBiometricAuth();
    const storage = makeSecureStorage();
    const bio = new CapacitorBiometricUnlock({
      auth,
      storage,
      verifyPassword: makeVerifier(),
    });

    await expect(bio.enableBiometric('wrong-password')).rejects.toThrow();

    // A password that cannot decrypt the vault must NEVER reach secure storage,
    // or biometric unlock would hand back a secret the decrypt path rejects.
    expect(storage.store.has(BIOMETRIC_PASSWORD_KEY)).toBe(false);
  });

  it('records an enrollment fingerprint at enable-time so a later enrollment change can be detected', async () => {
    const auth = makeBiometricAuth();
    const storage = makeSecureStorage();
    const bio = new CapacitorBiometricUnlock({
      auth,
      storage,
      verifyPassword: makeVerifier(),
    });

    await bio.enableBiometric(PASSWORD);

    // The current-set binding is enforced in software here: we snapshot the
    // enrolled biometry at enable-time and compare on every unlock.
    expect(storage.store.has(BIOMETRIC_ENROLLMENT_KEY)).toBe(true);
  });
});

describe('CapacitorBiometricUnlock.unlock', () => {
  async function enabled() {
    const auth = makeBiometricAuth();
    const storage = makeSecureStorage();
    const bio = new CapacitorBiometricUnlock({
      auth,
      storage,
      verifyPassword: makeVerifier(),
    });
    await bio.enableBiometric(PASSWORD);
    return { auth, storage, bio };
  }

  it('returns {ok:true, secret:password} after a successful prompt, feeding the SAME decrypt path', async () => {
    const { auth, bio } = await enabled();

    const result = await bio.unlock();

    // unlock() triggers the OS prompt, then returns the sealed password — it
    // does NOT itself decrypt the vault. The consumer feeds the secret into the
    // ordinary KeyringManager unlock.
    expect(auth.authenticate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, secret: PASSWORD });
  });

  it('returns {ok:false, reason:"biometric-cancelled"} when the user cancels the prompt', async () => {
    const { auth, bio } = await enabled();
    auth.authenticate.mockRejectedValue(
      Object.assign(new Error('cancelled'), { code: 'userCancel' }),
    );

    // A user cancel is not an auth failure — it must surface as a distinct
    // reason so the UI quietly falls back to the password field.
    await expect(bio.unlock()).resolves.toEqual({
      ok: false,
      reason: 'biometric-cancelled',
    });
  });

  it('returns {ok:false, reason:"biometric-failed"} when the authenticator rejects with a non-cancel error', async () => {
    const { auth, bio } = await enabled();
    auth.authenticate.mockRejectedValue(
      Object.assign(new Error('no match'), { code: 'authenticationFailed' }),
    );

    await expect(bio.unlock()).resolves.toEqual({
      ok: false,
      reason: 'biometric-failed',
    });
  });

  it('FAILS cleanly on a biometry-TYPE change (type-change check, NOT a true current-set binding) → biometric-failed, re-prompting for password', async () => {
    const { auth, storage, bio } = await enabled();

    // Simulate a biometry TYPE change after enable (e.g. fingerprint↔face): the
    // OS reports a different biometry-type set than the one snapshotted at
    // enable-time. NOTE: this is the ONLY change the software check detects — an
    // attacker ADDING a same-type fingerprint leaves the type set unchanged and
    // is NOT caught here; a true current-set binding needs the native ACL flags
    // (release blocker — see CapacitorBiometricUnlock.ts).
    auth.checkBiometry.mockResolvedValue(
      makeBiometryResult({ biometryType: 3, biometryTypes: [3] }),
    );

    const result = await bio.unlock();

    // The sealed password is NOT handed back when the biometry type changed — a
    // partial fail-closed degrade to the password path (not a bypass), and the
    // authenticator is never reached under a stale snapshot.
    expect(result).toEqual({ ok: false, reason: 'biometric-failed' });
    // The password remains sealed for re-enable; we do not silently wipe it,
    // but we refuse to return it under a changed enrollment.
    expect(storage.store.has(BIOMETRIC_PASSWORD_KEY)).toBe(true);
  });

  it('returns {ok:false, reason:"biometric-unavailable"} when unlock is attempted before enable', async () => {
    const auth = makeBiometricAuth();
    const storage = makeSecureStorage();
    const bio = new CapacitorBiometricUnlock({
      auth,
      storage,
      verifyPassword: makeVerifier(),
    });

    // No password sealed: the read path has nothing to return and must report
    // unavailable rather than crash on the missing-key rejection.
    await expect(bio.unlock()).resolves.toEqual({
      ok: false,
      reason: 'biometric-unavailable',
    });
  });
});

describe('CapacitorBiometricUnlock.clearBiometric', () => {
  it('deletes the sealed password so a subsequent unlock reports biometric-unavailable', async () => {
    const auth = makeBiometricAuth();
    const storage = makeSecureStorage();
    const bio = new CapacitorBiometricUnlock({
      auth,
      storage,
      verifyPassword: makeVerifier(),
    });
    await bio.enableBiometric(PASSWORD);

    await bio.clearBiometric();

    // After clear (disable / password-change / wallet-reset) the sealed password
    // is gone and isAvailable falls back to false — biometric unlock is fully
    // revoked until the user opts in again.
    expect(storage.store.has(BIOMETRIC_PASSWORD_KEY)).toBe(false);
    await expect(bio.isAvailable()).resolves.toBe(false);
    await expect(bio.unlock()).resolves.toEqual({
      ok: false,
      reason: 'biometric-unavailable',
    });
  });
});

describe('CapacitorBiometricUnlock secret hygiene', () => {
  it('never writes the password/secret to console across the full enable→unlock→clear lifecycle', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const auth = makeBiometricAuth();
    const storage = makeSecureStorage();
    const bio = new CapacitorBiometricUnlock({
      auth,
      storage,
      verifyPassword: makeVerifier(),
    });

    await bio.isAvailable();
    await bio.enableBiometric(PASSWORD);
    await bio.unlock();
    await bio.clearBiometric();

    const logged = [log, err, warn, info, debug]
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');
    expect(logged).not.toContain(PASSWORD);

    vi.restoreAllMocks();
  });
});

/**
 * SHARED conformance suite (RR#3): both `BiometricUnlock` impls — the
 * web/extension `UnsupportedBiometricUnlock` and the native
 * `CapacitorBiometricUnlock` — MUST present the SAME discriminated failure
 * shape so the UnlockScreen consumer branches identically regardless of
 * platform. This is the one place the two impls are checked against a single
 * contract.
 */
describe('BiometricUnlock failure-shape conformance (both impls)', () => {
  function unsupported() {
    return new UnsupportedBiometricUnlock();
  }

  function capacitorUnavailable() {
    // A Capacitor backer with nothing enabled is the closest native analogue of
    // "no biometrics" — its unlock() must report the same unavailable shape.
    const auth = makeBiometricAuth();
    const storage = makeSecureStorage();
    return new CapacitorBiometricUnlock({
      auth,
      storage,
      verifyPassword: makeVerifier(),
    });
  }

  for (const [name, make] of [
    ['UnsupportedBiometricUnlock', unsupported],
    ['CapacitorBiometricUnlock (not enabled)', capacitorUnavailable],
  ] as const) {
    it(`${name}: isAvailable() resolves a boolean and never rejects`, async () => {
      await expect(make().isAvailable()).resolves.toEqual(expect.any(Boolean));
    });

    it(`${name}: unlock() resolves a discriminated failure (never rejects, never a bare secret)`, async () => {
      const result = await make().unlock();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect([
          'biometric-unavailable',
          'biometric-cancelled',
          'biometric-failed',
        ]).toContain(result.reason);
      }
    });
  }
});
