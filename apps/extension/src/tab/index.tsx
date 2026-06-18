// Buffer polyfill MUST be the very first import — see src/background/index.ts
// for the full rationale. This full-tab surface mounts the shared UI screens
// (including the seed-showing onboarding flows), which pull in @stoachain crypto
// types; the polyfill must exist before any of that loads. This specifier
// resolves through the shared @stoachain Vite helper applied in vite.config.ts.
import '@stoawallet/core/build/polyfills';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import type { KeyVault, UnlockedKey } from '@stoawallet/core';
import { WalletApp, WalletProvider } from '@stoawallet/ui';

import { ChromeStorageAdapter } from '../storage/ChromeStorageAdapter';
import { BackgroundKeyVaultProxy } from '../popup/BackgroundKeyVaultProxy';
// Full-page width for the tab (vs the popup's fixed 380px). Extension-only;
// bundled by Vite as a CSP-safe <link>.
import './tab.css';

/**
 * The Chrome MV3 full-TAB root — the "expand" surface the popup opens.
 *
 * WHY IT EXISTS: the MV3 action popup closes on focus-loss, so showing a 24-word
 * recovery phrase there is dangerous. This page mounts the SAME shared
 * `<WalletApp/>` shell in a real top-level browser tab, where the seed-showing
 * Create/Import onboarding flows can run INLINE safely.
 *
 * SECURITY POSTURE (load-bearing, XP-12 unchanged): like the popup, this surface
 * holds NO key material. It reuses the EXACT same platform seams as the popup —
 * `ChromeStorageAdapter` + `BackgroundKeyVaultProxy` (the injected `remoteVault`)
 * + an inert local `KeyVault` — so every unlock / lock / sign crosses the wire to
 * the background service worker, which retains sole custody of the decrypted
 * mnemonic + keypair. Keys stay in the SW, not in this tab.
 *
 * It mounts `<WalletApp/>` with NEITHER `onExpand` nor `routeOnboardingToExpand`
 * (it IS the expanded surface), so onboarding runs inline here — identical to the
 * mobile path.
 */

/** An inert in-tab KeyVault: always locked, never holds a key. The background owns custody. */
class InertTabKeyVault implements KeyVault {
  async unlock(_key: UnlockedKey): Promise<void> {
    // No-op: this tab never loads a key locally. The background owns custody.
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
  const keyVault = new InertTabKeyVault();

  createRoot(container).render(
    <StrictMode>
      <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
        <WalletApp />
      </WalletProvider>
    </StrictMode>,
  );
}

export {};
