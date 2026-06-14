import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { render, screen, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ReactNode } from 'react';

import { WalletProvider, useWallet } from '../../context/WalletContext';
import type { RemoteVault } from '../../context/WalletContext';
import { WalletApp } from '../WalletApp';

/**
 * MV3 SW-lifecycle resilience at the composed-shell level. The popup mounts the
 * SAME `<WalletApp/>` behind a `WalletProvider` whose secret ops are delegated to
 * a background `remoteVault`. Because Chrome can terminate the worker (dropping
 * the in-memory mnemonic) and the idle auto-lock clears it, the popup must treat
 * the BACKGROUND as the single source of truth: it renders the unlocked HOME ONLY
 * when the background reports unlocked, and routes a mid-session `locked` to a
 * re-unlock screen carrying a distinct "session expired" affordance.
 */

const PASSWORD = 'correct horse battery staple';
const MNEMONIC =
  'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown';

async function seedLockedWallet(
  storage: InMemoryStorageAdapter,
  keyVault: InMemoryKeyVault,
) {
  const { KeyringManager } = await import('@stoawallet/core');
  const manager = new KeyringManager({ storage, keyVault });
  await manager.importWallet(MNEMONIC, PASSWORD);
  await manager.lock();
}

const ACCOUNT = {
  index: 0,
  publicKey: 'pk',
  account: 'k:pk',
  derivationPath: "m/44'/626'/0'/0'/0'",
};

function makeFakeVault(initialUnlocked: boolean): RemoteVault & {
  setUnlocked(value: boolean): void;
} {
  let unlocked = initialUnlocked;
  return {
    setUnlocked(value: boolean) {
      unlocked = value;
    },
    async unlock() {
      unlocked = true;
      return { ok: true };
    },
    async lock() {
      unlocked = false;
    },
    async isUnlocked() {
      return unlocked;
    },
    async getActiveAccount() {
      return unlocked ? ACCOUNT : null;
    },
    async listAccounts() {
      return unlocked ? [ACCOUNT] : [];
    },
    async addAccount() {
      return { ok: true };
    },
    async setActiveAccount() {
      return { ok: true };
    },
    async signTx() {
      return unlocked
        ? { ok: true, signed: {} }
        : { ok: false, reason: 'locked' };
    },
    async urstoaExecute() {
      return unlocked
        ? { ok: true as const, requestKey: 'rk' }
        : { ok: false as const, reason: 'locked' };
    },
  };
}

/**
 * A test-only control that invokes the SAME context seam the wallet screens use
 * when their op returns `{ok:false, reason:'locked'}` — `reportSessionLocked`
 * fired from a screen's `onRequireUnlock`. It drives the genuine mid-session
 * expiry path through the real context (no coupling to the send network flow).
 */
function MidSessionExpiryTrigger(): ReactNode {
  const { reportSessionLocked } = useWallet();
  return (
    <button type="button" data-testid="expire-session" onClick={reportSessionLocked}>
      expire
    </button>
  );
}

function renderPopup(
  storage: InMemoryStorageAdapter,
  keyVault: InMemoryKeyVault,
  remoteVault: RemoteVault,
) {
  return render(
    <WalletProvider
      storage={storage}
      keyVault={keyVault}
      remoteVault={remoteVault}
    >
      <WalletApp />
      <MidSessionExpiryTrigger />
    </WalletProvider>,
  );
}

describe('WalletApp — MV3 SW-lifecycle resilience', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the UnlockScreen — not HOME — when the background reports locked on popup open', async () => {
    // The SW was terminated while the popup was closed; its in-memory mnemonic is
    // gone. The popup must NOT show a stale unlocked surface — it re-derives the
    // unlocked-state from the background and routes to re-unlock.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    await seedLockedWallet(storage, keyVault);

    await act(async () => {
      renderPopup(storage, keyVault, makeFakeVault(false));
    });

    expect(
      await screen.findByRole('heading', { name: /unlock wallet/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /receive/i })).toBeNull();
  });

  it('renders the wallet HOME directly when the background reports unlocked on popup open', async () => {
    // The popup re-opened while the SW still holds the unlocked session: HOME shows
    // without forcing a re-unlock.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    await seedLockedWallet(storage, keyVault);

    await act(async () => {
      renderPopup(storage, keyVault, makeFakeVault(true));
    });

    expect(
      await screen.findByRole('tab', { name: /receive/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /unlock wallet/i })).toBeNull();
    // First-open unlocked is NOT a session-expired event.
    expect(screen.queryByText(/session expired/i)).toBeNull();
  });

  /**
   * Fire the genuine mid-session expiry seam (a screen's `onRequireUnlock` →
   * context `reportSessionLocked`) with the background already flipped to locked.
   */
  async function triggerMidSessionExpiry(): Promise<void> {
    await act(async () => {
      screen.getByTestId('expire-session').click();
    });
  }

  it('routes a mid-session locked op to re-unlock with the distinct "session expired" affordance', async () => {
    // The session was live (HOME shown), then an op returned reason:'locked' (idle
    // auto-lock fired / SW respawned). The popup routes to re-unlock WITH the
    // session-expired framing — distinct from a plain first-open lock.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    await seedLockedWallet(storage, keyVault);
    const remoteVault = makeFakeVault(true);

    await act(async () => {
      renderPopup(storage, keyVault, remoteVault);
    });

    await screen.findByRole('tab', { name: /receive/i });

    remoteVault.setUnlocked(false);
    await triggerMidSessionExpiry();

    expect(
      await screen.findByRole('heading', { name: /unlock wallet/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/session expired/i)).toBeInTheDocument();
  });

  it('resumes HOME after a re-unlock following a session expiry', async () => {
    // After the session-expired re-unlock the background re-populates the mnemonic
    // and subsequent ops succeed — the popup resumes HOME using the SAME unlock
    // flow (no second unlock implementation).
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    await seedLockedWallet(storage, keyVault);
    const remoteVault = makeFakeVault(true);

    await act(async () => {
      renderPopup(storage, keyVault, remoteVault);
    });
    await screen.findByRole('tab', { name: /receive/i });

    remoteVault.setUnlocked(false);
    await triggerMidSessionExpiry();
    await screen.findByText(/session expired/i);

    // Re-unlock through the SAME Phase-2 screen.
    const input = (await screen.findByLabelText(/password/i)) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, PASSWORD);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole('button', { name: /^unlock$/i }).click();
    });

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /receive/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/session expired/i)).toBeNull();
  });
});
