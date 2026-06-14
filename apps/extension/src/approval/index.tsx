// Buffer polyfill MUST be the very first import — see src/background/index.ts
// for the full rationale. The approval surface mounts the shared UI screens,
// which pull in @stoachain crypto types for the reused unlock flow; the polyfill
// must exist before any of that loads.
import '@stoawallet/core/build/polyfills';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import type { KeyVault, UnlockedKey } from '@stoawallet/core';
import {
  ApprovalApp,
  WalletProvider,
  type ApprovalDecision,
} from '@stoawallet/ui';

import { ChromeStorageAdapter } from '../storage/ChromeStorageAdapter';
import { BackgroundKeyVaultProxy } from '../popup/BackgroundKeyVaultProxy';
import { parseApprovalParams } from './parseApprovalParams';

/**
 * The Chrome MV3 dApp APPROVAL window root.
 *
 * The framing / clickjacking posture for this page lives in `approval.html`
 * (`frame-ancestors 'none'` + a sensor-locking Permissions-Policy) — the
 * highest-risk web-facing document in the wallet. This entry mounts the shared
 * `<ApprovalApp/>` into that framing-safe document.
 *
 * The router (T9.6) opens this window with the pending request encoded on the
 * URL and awaits the user's decision via `chrome.runtime.sendMessage` — keyed on
 * the SAME nonce + request id (RR#2). This entry:
 *
 *   1. decodes + validates the launch params (a garbled param renders an error,
 *      never a half-built approval);
 *   2. mounts `<ApprovalApp/>` behind a `WalletProvider` whose secret-touching
 *      ops are DELEGATED to the background (the reused unlock flow runs against
 *      the worker — this window holds no key material);
 *   3. sends EXACTLY the user's decision back to the background. A window
 *      dismissed without an approve sends nothing from here — the router's
 *      `onRemoved` reconciles a closed window to `user-rejected` (RR#13).
 *
 * SECURITY POSTURE: this window holds NO key material. It previews only the
 * public `cmd` + origin and emits only the user's yes/no; signing happens in the
 * background after an approve.
 */

/** An inert in-window KeyVault: the background owns custody; this never holds a key. */
class InertApprovalKeyVault implements KeyVault {
  async unlock(_key: UnlockedKey): Promise<void> {
    void _key;
  }
  async lock(): Promise<void> {}
  isUnlocked(): boolean {
    return false;
  }
  getUnlockedKey(): UnlockedKey | null {
    return null;
  }
}

function sendDecision(decision: ApprovalDecision): void {
  // The decision carries the SAME nonce + id the router opened with, so the
  // background resolves exactly the matching pending request (RR#2). Only the
  // user's yes/no crosses — no key material.
  void chrome.runtime.sendMessage({ type: 'approval-decision', decision });
}

const container = document.getElementById('approval-root');
if (container) {
  const parsed = parseApprovalParams(window.location.search);
  const root = createRoot(container);

  if (parsed === null) {
    root.render(
      <div role="alert">
        This approval request is invalid or has expired. You can close this
        window.
      </div>,
    );
  } else {
    const storage = new ChromeStorageAdapter();
    const remoteVault = new BackgroundKeyVaultProxy();
    const keyVault = new InertApprovalKeyVault();

    root.render(
      <StrictMode>
        <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
          <ApprovalApp
            request={parsed.request}
            locked={parsed.locked}
            onDecision={sendDecision}
          />
        </WalletProvider>
      </StrictMode>,
    );
  }
}

export {};
