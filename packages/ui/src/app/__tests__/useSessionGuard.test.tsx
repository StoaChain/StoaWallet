import { render, screen, act, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider, useWallet } from '../../context/WalletContext';
import { useSessionGuard } from '../useSessionGuard';

import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import type { RemoteVault } from '../../context/WalletContext';

/**
 * The popup-lifecycle guard. MV3 can terminate the background service worker at
 * any time (dropping the in-memory mnemonic) and the idle auto-lock clears it —
 * so the popup must treat the BACKGROUND as the single source of truth for the
 * unlocked-state, re-deriving it on every popup open rather than caching a stale
 * "unlocked" assumption across its own teardown.
 *
 * The guard:
 *   - on mount, asks the background `isUnlocked()` (the remote-vault seam); the
 *     UNLOCKED surface renders ONLY when the background reports unlocked.
 *   - tracks a `sessionExpired` flag set when a mid-session op reports
 *     `{ok:false, reason:'locked'}`, so the re-unlock screen can show a distinct
 *     "session expired" framing (vs a first-open lock).
 *   - on the web/test path (NO remoteVault), defers to the local context state —
 *     the background query is skipped and `status` is `local`.
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

/** A fake background custody surface whose unlocked-state the test drives. */
function makeFakeVault(initialUnlocked: boolean): RemoteVault & {
  setUnlocked(value: boolean): void;
  unlockCalls: number;
} {
  let unlocked = initialUnlocked;
  return {
    unlockCalls: 0,
    setUnlocked(value: boolean) {
      unlocked = value;
    },
    async unlock() {
      this.unlockCalls += 1;
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
      return unlocked
        ? {
            index: 0,
            publicKey: 'pk',
            account: 'k:pk',
            derivationPath: "m/44'/626'/0'/0'/0'",
          }
        : null;
    },
    async listAccounts() {
      return unlocked
        ? [
            {
              index: 0,
              publicKey: 'pk',
              account: 'k:pk',
              derivationPath: "m/44'/626'/0'/0'/0'",
            },
          ]
        : [];
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

/** A probe that renders the guard's status + flags as inspectable text. */
function GuardProbe(): ReactNode {
  const guard = useSessionGuard();
  return (
    <div>
      <span data-testid="status">{guard.status}</span>
      <span data-testid="expired">{String(guard.sessionExpired)}</span>
      <button
        type="button"
        onClick={() => guard.reportSessionLocked()}
      >
        report-locked
      </button>
    </div>
  );
}

/** Reads the live context so a test can drive a real unlock through the seam. */
function UnlockDriver(): ReactNode {
  const { unlock } = useWallet();
  return (
    <button type="button" onClick={() => void unlock(PASSWORD)}>
      do-unlock
    </button>
  );
}

describe('useSessionGuard', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports "locked" when the background isUnlocked() resolves false (SW killed / auto-locked)', async () => {
    // The popup re-opened after the SW was terminated: the local context may look
    // settled, but the background — the single source of truth — holds no session.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    await seedLockedWallet(storage, keyVault);
    const remoteVault = makeFakeVault(false);

    await act(async () => {
      render(
        <WalletProvider
          storage={storage}
          keyVault={keyVault}
          remoteVault={remoteVault}
        >
          <GuardProbe />
        </WalletProvider>,
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('locked'),
    );
  });

  it('resolves to "locked" (not a permanent "checking") when the first-mount isUnlocked() REJECTS (M-1, sleeping/erroring SW)', async () => {
    // The MV3 "could not establish connection / port closed" case: the SW is
    // spinning up and chrome.runtime.sendMessage rejects. Without a catch the
    // guard stays `checking` forever and the popup renders a permanent spinner.
    // Fail SAFE to `locked` → route to the unlock screen.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    await seedLockedWallet(storage, keyVault);

    const remoteVault = makeFakeVault(false);
    remoteVault.isUnlocked = async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    };

    await act(async () => {
      render(
        <WalletProvider
          storage={storage}
          keyVault={keyVault}
          remoteVault={remoteVault}
        >
          <GuardProbe />
        </WalletProvider>,
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('locked'),
    );
  });

  it('reports "unlocked" when the background isUnlocked() resolves true', async () => {
    // Popup opened while the SW still holds the unlocked mnemonic — the guard must
    // surface unlocked so the wallet HOME renders directly without a re-unlock.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    await seedLockedWallet(storage, keyVault);
    const remoteVault = makeFakeVault(true);

    await act(async () => {
      render(
        <WalletProvider
          storage={storage}
          keyVault={keyVault}
          remoteVault={remoteVault}
        >
          <GuardProbe />
        </WalletProvider>,
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unlocked'),
    );
    // A first-open unlocked session is NOT a session-expired event.
    expect(screen.getByTestId('expired')).toHaveTextContent('false');
  });

  it('uses "local" status and skips the background query on the web/test path (no remoteVault)', async () => {
    // Without a remoteVault there is no background to query; the guard defers to
    // the local context state, leaving WalletApp's existing branching unchanged.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    await seedLockedWallet(storage, keyVault);

    await act(async () => {
      render(
        <WalletProvider storage={storage} keyVault={keyVault}>
          <GuardProbe />
        </WalletProvider>,
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('local'),
    );
    expect(screen.getByTestId('expired')).toHaveTextContent('false');
  });

  it('sets sessionExpired when a mid-session op reports locked, and clears it after a successful unlock', async () => {
    // An op returning {ok:false,reason:'locked'} mid-session (idle auto-lock fired
    // or the SW respawned between ops) must raise the distinct session-expired
    // affordance — then a fresh unlock resumes the session and clears the flag.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    await seedLockedWallet(storage, keyVault);
    const remoteVault = makeFakeVault(true);

    await act(async () => {
      render(
        <WalletProvider
          storage={storage}
          keyVault={keyVault}
          remoteVault={remoteVault}
        >
          <GuardProbe />
          <UnlockDriver />
        </WalletProvider>,
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unlocked'),
    );

    // Mid-session lock surfaces (e.g. signTx returned reason 'locked').
    await act(async () => {
      screen.getByRole('button', { name: 'report-locked' }).click();
    });
    expect(screen.getByTestId('expired')).toHaveTextContent('true');

    // A fresh unlock re-populates the background and clears the expired framing.
    remoteVault.setUnlocked(false);
    await act(async () => {
      screen.getByRole('button', { name: 'do-unlock' }).click();
    });

    await waitFor(() =>
      expect(screen.getByTestId('expired')).toHaveTextContent('false'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('unlocked'),
    );
  });
});
