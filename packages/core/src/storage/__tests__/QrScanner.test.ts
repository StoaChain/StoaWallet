import { describe, expect, it } from 'vitest';

import { UnsupportedQrScanner } from '../QrScanner';

/**
 * Behavioral test for the default, web/extension `QrScanner`.
 *
 * The `QrScanner` interface itself is a pure type and gets no test.
 * `UnsupportedQrScanner` HAS branching (a capability probe that resolves false
 * and a `scan()` that resolves a structured unavailable result) and is the
 * PRODUCTION default everywhere a platform camera/QR backer is absent (web +
 * extension), so its contract is pinned here: the Send UI must be able to
 * detect "no scanner" and hide the scan button without crashing, and a caller
 * that ignores the probe and calls `scan()` anyway must get a clean
 * structured failure rather than a throw.
 */
describe('UnsupportedQrScanner', () => {
  it('reports the scanner as unavailable so the UI hides the scan button', async () => {
    // isAvailable() is the capability probe the Send screen gates the
    // "scan QR" affordance on. On web/extension there is no camera-QR backer,
    // so it MUST resolve false — a true here would surface a button that can
    // never open a scanner.
    const scanner = new UnsupportedQrScanner();
    await expect(scanner.isAvailable()).resolves.toBe(false);
  });

  it('resolves scan() with a structured unavailable result instead of throwing', async () => {
    // A caller that skips the probe must still get a clean ok:false back, never
    // an exception — so the Send flow can branch to manual address entry rather
    // than crashing the screen.
    const scanner = new UnsupportedQrScanner();
    await expect(scanner.scan()).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});
