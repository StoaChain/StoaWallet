// Buffer polyfill MUST be the very first import — see src/background/index.ts
// for the full rationale. This side-panel surface mounts the shared UI screens,
// which pull in @stoachain crypto types for the wallet flows; the polyfill must
// exist before any of that loads. This specifier resolves through the shared
// @stoachain Vite helper applied in vite.config.ts.
import '@stoawallet/core/build/polyfills';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import type { KeyVault, UnlockedKey } from '@stoawallet/core';
import { WalletApp, WalletProvider } from '@stoawallet/ui';

import { ChromeStorageAdapter } from '../storage/ChromeStorageAdapter';
import { BackgroundKeyVaultProxy } from '../popup/BackgroundKeyVaultProxy';
// Side-panel width (the docked panel auto-sizes to content). Extension-only;
// bundled by Vite as a CSP-safe <link>.
import './sidepanel.css';

/**
 * The Chrome MV3 SIDE-PANEL root — the docked surface the popup opens via
 * `chrome.sidePanel.open`.
 *
 * SECURITY POSTURE (load-bearing, XP-12 unchanged): like the popup + tab, this
 * surface holds NO key material. It reuses the EXACT same platform seams as the
 * popup — `ChromeStorageAdapter` + `BackgroundKeyVaultProxy` (the injected
 * `remoteVault`) + an inert local `KeyVault` — so every unlock / lock / sign
 * crosses the wire to the background service worker, which retains sole custody
 * of the decrypted mnemonic + keypair. Keys stay in the SW, not in this panel.
 *
 * It mounts `<WalletApp/>` with NEITHER `onExpand` nor `onOpenSidePanel` (it IS
 * the side-panel surface, persistent and not focus-loss-closeable), so the
 * onboarding seed flows can run inline here safely, identical to the tab path.
 */

/** An inert in-panel KeyVault: always locked, never holds a key. The background owns custody. */
class InertSidePanelKeyVault implements KeyVault {
  async unlock(_key: UnlockedKey): Promise<void> {
    // No-op: this panel never loads a key locally. The background owns custody.
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
  const keyVault = new InertSidePanelKeyVault();

  createRoot(container).render(
    <StrictMode>
      <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
        <WalletApp />
      </WalletProvider>
    </StrictMode>,
  );
}

export {};
