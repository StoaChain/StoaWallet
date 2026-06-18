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
// Fixed popup width (MV3 action popups auto-size to content → collapse to a
// sliver without it). Extension-only; bundled by Vite as a CSP-safe <link>.
import './popup.css';

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

/**
 * Open the full-tab "expand" surface. The MV3 action popup closes on focus-loss,
 * so the seed-showing onboarding flows are routed OUT of the popup into a real
 * top-level tab via this callback (handed to the shared shell as `onExpand`, which
 * keeps `<WalletApp/>` `chrome.*`-free). The URL is the @crxjs-emitted tab page
 * declared as a Rollup input in vite.config.ts (`dist/src/tab/index.html`).
 */
function openInTab(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('src/tab/index.html') });
}

/**
 * Open the docked Chrome side panel for the current window. `chrome.sidePanel.open`
 * requires a user gesture (the header button click) and the active window id, which
 * `chrome.windows.getCurrent` resolves. Wired ONLY when the API exists (Chrome
 * 114+); on older Chrome the popup passes no callback so the header button — which
 * renders only when `onOpenSidePanel` is provided — simply does not appear.
 */
function openSidePanel(): void {
  void chrome.windows.getCurrent().then((win) => {
    if (win.id !== undefined) {
      void chrome.sidePanel.open({ windowId: win.id });
    }
  });
}

const container = document.getElementById('root');
if (container) {
  const storage = new ChromeStorageAdapter();
  const remoteVault = new BackgroundKeyVaultProxy();
  const keyVault = new InertPopupKeyVault();

  // Guard for Chrome <114 / the API being absent: only hand the side-panel
  // callback to the shell when `chrome.sidePanel.open` actually exists at runtime,
  // so the header button does not render where it could never work. The static
  // @types/chrome surface assumes the API is always present, so probe the live
  // object (which on older Chrome lacks `sidePanel`) rather than the types.
  const sidePanelApi = (chrome as { sidePanel?: { open?: unknown } }).sidePanel;
  const onOpenSidePanel =
    typeof sidePanelApi?.open === 'function' ? openSidePanel : undefined;

  createRoot(container).render(
    <StrictMode>
      <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
        <WalletApp
          onExpand={openInTab}
          onOpenSidePanel={onOpenSidePanel}
          routeOnboardingToExpand
        />
      </WalletProvider>
    </StrictMode>,
  );
}

export {};
