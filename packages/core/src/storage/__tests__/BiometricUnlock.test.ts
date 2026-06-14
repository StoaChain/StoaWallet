import { describe, expect, it } from 'vitest';

import { UnsupportedBiometricUnlock } from '../BiometricUnlock';

/**
 * Behavioral test for the default, web/extension `BiometricUnlock`.
 *
 * The `BiometricUnlock` interface itself is a pure type and gets no test.
 * `UnsupportedBiometricUnlock` HAS branching (a capability probe that
 * resolves false and an `unlock()` that returns an unavailable result) and is
 * the PRODUCTION default everywhere a platform biometric backer is absent, so
 * its contract is pinned here: the UI must be able to detect "no biometrics"
 * and degrade to password-only without crashing.
 *
 * The failure contract is a DISCRIMINATED RESULT (`{ok:false, reason}`), not a
 * thrown rejection — so the UI branches on a value instead of catch-and-guess,
 * and a missing/unavailable backer can never surface as an unhandled rejection.
 */
describe('UnsupportedBiometricUnlock', () => {
  it('reports biometrics as unavailable so the UI hides the biometric option', async () => {
    // isAvailable() is the capability probe the UI gates the biometric button
    // on. On web/extension there is no platform biometric API, so it MUST
    // resolve false — a true here would surface a button that can never work.
    const biometric = new UnsupportedBiometricUnlock();
    await expect(biometric.isAvailable()).resolves.toBe(false);
  });

  it('resolves unlock() with a biometric-unavailable result so callers fall back to password', async () => {
    // unlock() is the alternative path to obtain the vault password. When no
    // backer exists it must RESOLVE (never reject) with the discriminated
    // unavailable reason so the unlock flow branches to the password prompt
    // instead of treating it as an auth failure or crashing on a rejection.
    const biometric = new UnsupportedBiometricUnlock();
    await expect(biometric.unlock()).resolves.toEqual({
      ok: false,
      reason: 'biometric-unavailable',
    });
  });

  it('never resolves a secret-bearing ok result on the unsupported platform', async () => {
    // A web/extension default must never hand back an `ok:true` with a secret —
    // there is no sealed password to return, and an accidental ok would feed an
    // empty/garbage secret into the decrypt path.
    const biometric = new UnsupportedBiometricUnlock();
    const result = await biometric.unlock();
    expect(result.ok).toBe(false);
  });
});
