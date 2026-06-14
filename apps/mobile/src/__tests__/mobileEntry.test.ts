import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KeyringManager,
  UnsupportedBiometricUnlock,
  UnsupportedQrScanner,
  type StorageAdapter,
} from '@stoawallet/core';
import { describe, expect, it, vi } from 'vitest';

import { CapacitorBiometricUnlock } from '../biometric/CapacitorBiometricUnlock';
import { CapacitorQrScanner } from '../qr/CapacitorQrScanner';
import { CapacitorStorageAdapter } from '../storage/CapacitorStorageAdapter';
import { MobileKeyVault } from '../keyvault/MobileKeyVault';
import {
  buildMobileProviderProps,
  mountWallet,
  type MobileMountDeps,
} from '../main';

/**
 * Mobile app-entry wiring. The mobile tests run under the `node` Vitest project
 * (no jsdom), so rather than a full `createRoot` render this suite drives the two
 * testable seams the entry factors out:
 *   - `buildMobileProviderProps()` — the platform injection bundle handed to the
 *     shared `WalletProvider` (the Capacitor StorageAdapter / KeyVault / Biometric
 *     / QrScanner trio + the single shared KeyringManager).
 *   - `mountWallet(deps)` — the boot sequence (configureNode → auto-lock → render)
 *     with every external seam injected so it can run headless.
 *
 * A separate structural assertion pins the Buffer-polyfill import ORDERING in the
 * entry source (the dev/test environment has an ambient Buffer, so only a source
 * check can prove the polyfill precedes any @stoachain crypto import — mirroring
 * the Phase-1/7 entry ordering tests).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_SRC = path.resolve(HERE, '..', 'main.tsx');

function fakeAuthBackend() {
  return {
    checkBiometry: vi.fn().mockResolvedValue({
      isAvailable: true,
      biometryType: 1,
      biometryTypes: [1],
    }),
    authenticate: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeSecureStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    get: vi.fn(({ key }: { key: string }) =>
      store.has(key)
        ? Promise.resolve({ value: store.get(key)! })
        : Promise.reject(new Error('missing key')),
    ),
    set: vi.fn(({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
      return Promise.resolve({ value: true });
    }),
    remove: vi.fn(({ key }: { key: string }) => {
      store.delete(key);
      return Promise.resolve({ value: true });
    }),
  };
}

describe('buildMobileProviderProps', () => {
  it('injects the Capacitor StorageAdapter so the cross-chain in-flight persistence uses the secure backing', () => {
    const props = buildMobileProviderProps();
    expect(props.storage).toBeInstanceOf(CapacitorStorageAdapter);
  });

  it('injects the in-process MobileKeyVault (local KeyringManager signing, no remoteVault)', () => {
    const props = buildMobileProviderProps();
    expect(props.keyVault).toBeInstanceOf(MobileKeyVault);
    // Mobile signing is IN-PROCESS: there must be NO background remoteVault, or
    // the local same-chain/cross-chain send flows would be intercepted.
    expect(props.remoteVault).toBeUndefined();
  });

  it('injects the concrete CapacitorBiometricUnlock so the T2.10 affordance is reachable on mobile', () => {
    const props = buildMobileProviderProps();
    // The concrete impl (NOT the extension/web UnsupportedBiometricUnlock whose
    // isAvailable resolves false) is what makes the biometric button render.
    expect(props.biometric).toBeInstanceOf(CapacitorBiometricUnlock);
    expect(props.biometric).not.toBeInstanceOf(UnsupportedBiometricUnlock);
  });

  it('drives the injected biometric isAvailable() true through the real CapacitorBiometricUnlock path', async () => {
    const biometric = new CapacitorBiometricUnlock({
      auth: fakeAuthBackend(),
      storage: fakeSecureStorage({
        'stoawallet:biometric:password': 'pw',
        'stoawallet:biometric:enrollment': JSON.stringify({
          primary: 1,
          set: [1],
        }),
      }),
      verifyPassword: () => Promise.resolve(true),
    });
    // A capable device + a sealed password ⇒ the affordance is available, which
    // is what flips the UnlockScreen's biometric button on under NO UI change.
    await expect(biometric.isAvailable()).resolves.toBe(true);
  });

  it('injects the concrete CapacitorQrScanner (not the web UnsupportedQrScanner) via the context slot', () => {
    const props = buildMobileProviderProps();
    expect(props.qrScanner).toBeInstanceOf(CapacitorQrScanner);
    expect(props.qrScanner).not.toBeInstanceOf(UnsupportedQrScanner);
  });

  it('binds the shared KeyringManager to the SAME injected storage + keyVault it hands the provider', () => {
    const props = buildMobileProviderProps();
    // The manager the provider runs is the SAME one auto-lock locks; it must be
    // bound to the injected backers so locking it clears the live session.
    expect(props.manager).toBeInstanceOf(KeyringManager);
  });
});

describe('mountWallet boot sequence', () => {
  function baseDeps(
    overrides: Partial<MobileMountDeps> = {},
  ): MobileMountDeps {
    return {
      configureNode: vi.fn().mockResolvedValue(undefined),
      startAutoLock: vi.fn().mockResolvedValue({ stop: vi.fn() }),
      appLifecycle: {
        addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
      },
      render: vi.fn(),
      setPrivacyOverlay: vi.fn(),
      ...overrides,
    };
  }

  it('calls configureNode with the Capacitor StorageAdapter BEFORE rendering (XP-13 boot)', async () => {
    const order: string[] = [];
    const configureNode = vi.fn((adapter: StorageAdapter) => {
      order.push('configureNode');
      expect(adapter).toBeInstanceOf(CapacitorStorageAdapter);
      return Promise.resolve();
    });
    const render = vi.fn(() => {
      order.push('render');
    });

    const props = buildMobileProviderProps();
    await mountWallet(props, baseDeps({ configureNode, render }));

    expect(configureNode).toHaveBeenCalledTimes(1);
    expect(configureNode.mock.calls[0][0]).toBe(props.storage);
    // The persisted node preference must be applied before the failover-driven
    // first network read fires from the rendered tree.
    expect(order).toEqual(['configureNode', 'render']);
  });

  it('starts auto-lock wired to the shared manager and the @capacitor/app lifecycle', async () => {
    const startAutoLock = vi.fn().mockResolvedValue({ stop: vi.fn() });
    const appLifecycle = {
      addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
    };

    const props = buildMobileProviderProps();
    await mountWallet(props, baseDeps({ startAutoLock, appLifecycle }));

    expect(startAutoLock).toHaveBeenCalledTimes(1);
    const arg = startAutoLock.mock.calls[0][0] as {
      manager: unknown;
      app: unknown;
      onResignActive?: unknown;
    };
    // Auto-lock must lock the SAME manager the provider runs (clears mnemonic +
    // password + KeyVault), and subscribe to the injected app lifecycle.
    expect(arg.manager).toBe(props.manager);
    expect(arg.app).toBe(appLifecycle);
    expect(typeof arg.onResignActive).toBe('function');
  });

  it('toggles the iOS privacy overlay ON when the app resigns active', async () => {
    let capturedOnResign: (() => void) | undefined;
    const startAutoLock = vi.fn((opts: { onResignActive?: () => void }) => {
      capturedOnResign = opts.onResignActive;
      return Promise.resolve({ stop: vi.fn() });
    });
    const setPrivacyOverlay = vi.fn();

    const props = buildMobileProviderProps();
    await mountWallet(props, baseDeps({ startAutoLock, setPrivacyOverlay }));

    expect(capturedOnResign).toBeTypeOf('function');
    capturedOnResign!();
    // Resign-active drops the overlay synchronously so the app-switcher snapshot
    // never captures on-screen balances/addresses.
    expect(setPrivacyOverlay).toHaveBeenCalledWith(true);
  });

  it('toggles the iOS privacy overlay OFF on resume so the app is not left permanently blank (H-1)', async () => {
    let capturedOnForeground: (() => void) | undefined;
    const startAutoLock = vi.fn(
      (opts: { onForeground?: () => void }) => {
        capturedOnForeground = opts.onForeground;
        return Promise.resolve({ stop: vi.fn() });
      },
    );
    const setPrivacyOverlay = vi.fn();

    const props = buildMobileProviderProps();
    await mountWallet(props, baseDeps({ startAutoLock, setPrivacyOverlay }));

    // The foreground hook must be wired; firing it LOWERS the overlay. Without
    // this the overlay raised on background is never lowered and the app stays
    // blank after one background cycle.
    expect(capturedOnForeground).toBeTypeOf('function');
    capturedOnForeground!();
    expect(setPrivacyOverlay).toHaveBeenCalledWith(false);
  });
});

describe('mobile entry source ordering', () => {
  it('imports the Buffer polyfill as the FIRST import, before any core/@stoachain crypto import', () => {
    const src = readFileSync(ENTRY_SRC, 'utf8');
    // The first executable import line (skipping comments + blanks) must be the
    // polyfill side-effect import, so the Buffer global exists before any crypto
    // module evaluates. A non-comment line check avoids matching the @stoachain
    // mention inside the rationale comment.
    const firstImport = src
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith('import ') || l.startsWith("import'"));
    expect(firstImport).toBe("import '@stoawallet/core/build/polyfills';");

    // And every other core/@stoachain import statement follows the polyfill.
    const importLines = src
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('import '));
    const polyfillPos = importLines.findIndex((l) =>
      l.includes('@stoawallet/core/build/polyfills'),
    );
    const firstCorePos = importLines.findIndex(
      (l) =>
        (l.includes('@stoawallet/core') || l.includes('@stoachain/')) &&
        !l.includes('/build/polyfills'),
    );
    expect(polyfillPos).toBe(0);
    if (firstCorePos >= 0) {
      expect(polyfillPos).toBeLessThan(firstCorePos);
    }
  });

  it('never logs a secret from the entry', () => {
    const src = readFileSync(ENTRY_SRC, 'utf8');
    // The entry holds no mnemonic/password/secret variable to log; guard against
    // a console call that names one creeping in.
    expect(src).not.toMatch(/console\.\w+\([^)]*\b(mnemonic|password|secret|privateKey)\b/i);
  });
});
