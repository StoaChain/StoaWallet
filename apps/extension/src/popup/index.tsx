// Buffer polyfill MUST be the very first import — see src/background/index.ts
// for the full rationale. The popup mounts the shared UI screens, which pull in
// @stoachain crypto types for the wallet flows; the polyfill must exist before
// any of that loads. This specifier resolves through the shared @stoachain Vite
// helper applied in vite.config.ts.
import '@stoawallet/core/build/polyfills';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import type { KeyVault, UnlockedKey } from '@stoawallet/core';
import { WalletApp, WalletProvider } from '@stoawallet/ui';

import { ChromeStorageAdapter } from '../storage/ChromeStorageAdapter';
import { BackgroundKeyVaultProxy } from './BackgroundKeyVaultProxy';

/**
 * The Chrome MV3 popup root.
 *
 * SECURITY POSTURE (load-bearing): the popup holds NO key material. It mounts the
 * shared `<WalletApp/>` behind a `WalletProvider` whose secret-touching ops are
 * DELEGATED to the background service worker via the `BackgroundKeyVaultProxy`
 * (the injected `remoteVault`). Every unlock / lock / sign crosses the T7.2 wire
 * to the worker — the decrypted mnemonic + keypair never enter this context.
 *
 * The provider still needs a local `KeyVault` for its `KeyringManager`, but in
 * remote mode that manager NEVER decrypts (unlock/lock/sign are intercepted by
 * the `remoteVault`); it only reads plaintext vault metadata. So the local vault
 * is an INERT, always-locked stub that holds no key and is never unlocked here.
 */

/**
 * An inert in-popup KeyVault: always locked, never holds a key. The popup's
 * KeyringManager is constructed with it, but every secret op is intercepted by
 * the `remoteVault` before the manager would touch this — so it stays empty.
 */
class InertPopupKeyVault implements KeyVault {
  async unlock(_key: UnlockedKey): Promise<void> {
    // No-op: the popup never loads a key locally. The background owns custody.
    void _key;
  }
  async lock(): Promise<void> {
    // Already empty; nothing to clear.
  }
  isUnlocked(): boolean {
    return false;
  }
  getUnlockedKey(): UnlockedKey | null {
    return null;
  }
}

const container = document.getElementById('root');
if (container) {
  const storage = new ChromeStorageAdapter();
  const remoteVault = new BackgroundKeyVaultProxy();
  const keyVault = new InertPopupKeyVault();

  createRoot(container).render(
    <StrictMode>
      <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
        <WalletApp />
      </WalletProvider>
    </StrictMode>,
  );
}

export {};
