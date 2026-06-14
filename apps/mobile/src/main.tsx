// The Buffer polyfill MUST be the VERY FIRST import — before any @stoachain/*
// crypto module (which the wallet flows pull in transitively through
// @stoawallet/core / @stoawallet/ui) evaluates. The shipped upstream polyfill is
// tree-shaken out of the production bundle, so without this the Capacitor WebView
// boots without a `Buffer` global and signing throws "Buffer is not defined".
import '@stoawallet/core/build/polyfills';

import { App as CapacitorApp } from '@capacitor/app';
import {
  KeyringManager,
  configureNode,
  type StorageAdapter,
} from '@stoawallet/core';
import { WalletApp, WalletProvider, type WalletProviderProps } from '@stoawallet/ui';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { CapacitorBiometricUnlock } from './biometric/CapacitorBiometricUnlock';
import {
  startAutoLock as defaultStartAutoLock,
  type AppLifecycle,
  type AutoLockHandle,
} from './keyvault/startAutoLock';
import { MobileKeyVault } from './keyvault/MobileKeyVault';
import { CapacitorQrScanner } from './qr/CapacitorQrScanner';
import { CapacitorStorageAdapter } from './storage/CapacitorStorageAdapter';

/**
 * Entry for the Capacitor-wrapped mobile app.
 *
 * It mounts the SAME shared `<WalletApp/>` the Chrome extension popup mounts — no
 * UI fork — and injects the Capacitor PLATFORM layer through the shared
 * `WalletProvider`:
 *   - `CapacitorStorageAdapter` (iOS Keychain / Android Keystore) backs the
 *     at-rest vault AND the cross-chain in-flight persistence (XP-14: the
 *     anti-fund-stranding rehydrate seam flows through the context `storage`).
 *   - `MobileKeyVault` holds the decrypted secret IN APP PROCESS — signing is
 *     in-process (no remoteVault / background like the extension), so the local
 *     same-chain / cross-chain / advanced send flows run unchanged on device.
 *   - `CapacitorBiometricUnlock` is the concrete biometric backer; because the
 *     UnlockScreen gates its affordance on `BiometricUnlock.isAvailable()`,
 *     injecting it reveals the biometric button on mobile with NO UI change.
 *   - `CapacitorQrScanner` backs the Send flow's recipient-address scan.
 *
 * A single shared `KeyringManager` is constructed here and handed to BOTH the
 * provider and the app-background auto-lock, so backgrounding locks the EXACT
 * manager the provider runs — clearing its `{mnemonic, password}` and the
 * KeyVault together. Nothing here logs a secret.
 */

/** The injectable seams `mountWallet` drives, so the boot can run headless. */
export interface MobileMountDeps {
  /** XP-13 node boot: applies the persisted node preference before render. */
  readonly configureNode: (adapter: StorageAdapter) => Promise<void>;
  /** App-background auto-lock starter (the real `startAutoLock` in production). */
  readonly startAutoLock: (deps: {
    app: AppLifecycle;
    manager: KeyringManager;
    onResignActive?: () => void;
    onForeground?: () => void;
  }) => Promise<AutoLockHandle>;
  /** The `@capacitor/app` lifecycle plugin the auto-lock subscribes to. */
  readonly appLifecycle: AppLifecycle;
  /** Renders the composed provider tree (createRoot in production). */
  readonly render: (tree: ReactNode) => void;
  /** Toggles the iOS background-snapshot privacy overlay. */
  readonly setPrivacyOverlay: (visible: boolean) => void;
}

/**
 * Build the platform injection bundle for the shared `WalletProvider`. The
 * concrete Capacitor backers are constructed here; the shared UI consumes only
 * the platform-agnostic contracts. The KeyringManager is the SINGLE instance the
 * provider runs and the auto-lock locks.
 */
export function buildMobileProviderProps(): WalletProviderProps & {
  readonly manager: KeyringManager;
} {
  const storage = new CapacitorStorageAdapter();
  const keyVault = new MobileKeyVault();
  const manager = new KeyringManager({ storage, keyVault });

  return {
    storage,
    keyVault,
    manager,
    biometric: buildBiometric(storage),
    qrScanner: new CapacitorQrScanner(),
    // No remoteVault: mobile signing is in-process via the local manager.
    children: <WalletApp />,
  };
}

/**
 * Construct the Capacitor biometric backer. A successful biometric prompt returns
 * the sealed vault password, which the verify-password seam confirms actually
 * decrypts the vault before it is ever sealed — biometric is an alternative way to
 * obtain the password, never a vault-decrypt bypass.
 *
 * REACHABILITY (Phase 10): the biometric ENABLE affordance (the opt-in that calls
 * `enableBiometric(currentPassword)`) lands in Phase-10 Settings, which is not yet
 * built. Until then no password is ever sealed, so `isAvailable()` returns false
 * and the UnlockScreen's biometric button correctly stays hidden. The feature is
 * therefore NOT end-to-end reachable now by design — this is a documented gap, not
 * a silent dead path. (Note also the separate RELEASE BLOCKER: even once enable
 * ships, the native current-set ACL must back the sealed item — see
 * CapacitorBiometricUnlock.ts / MOBILE_BUILD.md.)
 *
 * clearBiometric WIRING (RR#2): `clearBiometric()` MUST be called when a
 * wallet-RESET or password-CHANGE flow lands, to revoke the sealed password so a
 * stale secret cannot unlock a re-keyed vault. Those flows do NOT exist in the
 * codebase yet (no resetWallet/changePassword action in KeyringManager or
 * WalletContext). The contract is asserted in `clearBiometricContract.test.ts`;
 * when the reset/password-change action is added, call `biometric.clearBiometric()`
 * from it (or wire a callback the mobile entry passes through) and update that test
 * to drive the real flow.
 */
function buildBiometric(storage: StorageAdapter): CapacitorBiometricUnlock {
  // Lazily imported native proxies are wired here in production; the concrete
  // backer only needs the structural plugin slices, so the entry stays decoupled
  // from the native bridge at module-eval time (tests inject their own deps).
  return new CapacitorBiometricUnlock({
    auth: lazyBiometricAuth(),
    storage: lazySecureStorage(),
    // Verify a candidate password by attempting a real KeyringManager unlock on a
    // throwaway manager bound to the SAME storage — never seals a non-verifying
    // password. Resolves false on any failure rather than leaking a reason.
    verifyPassword: async (candidate) => {
      const probe = new KeyringManager({
        storage,
        keyVault: new MobileKeyVault(),
      });
      try {
        const walletId = await activeWalletId(storage);
        if (walletId === null) return false;
        await probe.unlock(walletId, candidate);
        await probe.lock();
        return true;
      } catch {
        return false;
      }
    },
  });
}

/** Read the active wallet id from the stored vault (plaintext metadata). */
async function activeWalletId(storage: StorageAdapter): Promise<string | null> {
  const { VAULT_KEY, deserializeVault } = await import('@stoawallet/core');
  const raw = await storage.get(VAULT_KEY);
  if (raw === null) return null;
  try {
    const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
    return deserializeVault(text).activeWalletId;
  } catch {
    return null;
  }
}

/**
 * The `@aparajita/capacitor-biometric-auth` proxy, narrowed to the slice the
 * backer consumes. Imported lazily so the native bridge is touched at first use,
 * not at module evaluation.
 */
function lazyBiometricAuth(): import('./biometric/CapacitorBiometricUnlock').BiometricAuthBackend {
  return {
    async checkBiometry() {
      const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
      const info = await BiometricAuth.checkBiometry();
      return {
        isAvailable: info.isAvailable,
        biometryType: info.biometryType,
        biometryTypes: info.biometryTypes ?? [],
      };
    },
    async authenticate(options) {
      const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
      await BiometricAuth.authenticate(options);
    },
  };
}

/** The `capacitor-secure-storage-plugin` proxy, narrowed to the backer's slice. */
function lazySecureStorage(): import('./biometric/CapacitorBiometricUnlock').SecureStorageBackend {
  return {
    async get(options) {
      const { SecureStoragePlugin } = await import('capacitor-secure-storage-plugin');
      return SecureStoragePlugin.get(options);
    },
    async set(options) {
      const { SecureStoragePlugin } = await import('capacitor-secure-storage-plugin');
      return SecureStoragePlugin.set(options);
    },
    async remove(options) {
      const { SecureStoragePlugin } = await import('capacitor-secure-storage-plugin');
      return SecureStoragePlugin.remove(options);
    },
  };
}

/**
 * Boot the mobile wallet: apply the persisted node preference, start the
 * app-background auto-lock, then render the shared UI behind the injected
 * platform layer. `configureNode` runs BEFORE render so the failover-driven first
 * network read uses the persisted node1/node2 preference, not the SDK default.
 */
export async function mountWallet(
  props: WalletProviderProps & { readonly manager: KeyringManager },
  deps: MobileMountDeps,
): Promise<void> {
  // XP-13: apply the persisted node preference before any rendered tree fires a
  // failover-driven network read.
  await deps.configureNode(props.storage);

  // App-background auto-lock: locks the SAME manager the provider runs (clears
  // {mnemonic, password} + the KeyVault) and raises the iOS privacy overlay
  // synchronously on resign so the app-switcher snapshot captures no secrets.
  await deps.startAutoLock({
    app: deps.appLifecycle,
    manager: props.manager,
    onResignActive: () => deps.setPrivacyOverlay(true),
    // Lower the overlay on resume so the app is not left permanently blank after
    // one background cycle. Resume lowers the overlay ONLY — it does not unlock.
    onForeground: () => deps.setPrivacyOverlay(false),
  });

  deps.render(
    <StrictMode>
      <WalletProvider
        storage={props.storage}
        keyVault={props.keyVault}
        manager={props.manager}
        biometric={props.biometric}
        qrScanner={props.qrScanner}
      >
        {props.children}
      </WalletProvider>
    </StrictMode>,
  );
}

/**
 * The iOS privacy overlay: a full-screen blur element toggled on resign-active so
 * the OS app-switcher snapshot never captures on-screen balances/addresses/phrase.
 * A minimal DOM toggle (a `[data-privacy-overlay]` element); the native layer can
 * later replace this with a native blur view.
 */
function makePrivacyOverlay(doc: Document): (visible: boolean) => void {
  return (visible) => {
    let overlay = doc.querySelector<HTMLElement>('[data-privacy-overlay]');
    if (overlay === null) {
      overlay = doc.createElement('div');
      overlay.setAttribute('data-privacy-overlay', '');
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;backdrop-filter:blur(24px);' +
        'background:rgba(10,10,14,0.92);display:none';
      doc.body.appendChild(overlay);
    }
    overlay.style.display = visible ? 'block' : 'none';
  };
}

// Production boot: only runs in a real DOM (the Capacitor WebView), never under
// the node test environment. The injected seams above are the real ones here.
const container =
  typeof document !== 'undefined' ? document.getElementById('root') : null;
if (container !== null) {
  const props = buildMobileProviderProps();
  void mountWallet(props, {
    configureNode,
    startAutoLock: defaultStartAutoLock,
    appLifecycle: CapacitorApp,
    render: (tree) => createRoot(container).render(tree),
    setPrivacyOverlay: makePrivacyOverlay(document),
  });
}
