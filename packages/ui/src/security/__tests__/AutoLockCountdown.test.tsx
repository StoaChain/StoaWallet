import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { act, render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider, type RemoteVault } from '../../context/WalletContext';
import { AutoLockCountdown } from '../AutoLockCountdown';

const ACCOUNT = {
  index: 0,
  publicKey: 'a'.repeat(64),
  account: `k:${'a'.repeat(64)}`,
  derivationPath: "m/44'/626'/0'/0/0",
};

/**
 * A RemoteVault stub whose `getSession` returns a controllable expiry, and which
 * records lock() calls so the zero-tick lock is assertable.
 */
function makeVault(expiresAt: number | null): RemoteVault & { lockCalls: number } {
  const v = {
    lockCalls: 0,
    async unlock() {
      return { ok: true as const };
    },
    async lock() {
      v.lockCalls += 1;
    },
    async isUnlocked() {
      return true;
    },
    async getActiveAccount() {
      return ACCOUNT;
    },
    async listAccounts() {
      return [ACCOUNT];
    },
    async addAccount() {
      return { ok: true as const };
    },
    async setActiveAccount() {
      return { ok: true as const };
    },
    async signTx() {
      return { ok: true as const, signed: {} };
    },
    async urstoaExecute() {
      return { ok: true as const, requestKey: 'rk' };
    },
    async getSession() {
      return { unlocked: expiresAt !== null, expiresAt, autoLockMinutes: 2 };
    },
    async setAutoLock(minutes: number) {
      return minutes;
    },
  };
  return v;
}

const BASE = 1_000_000_000_000;

function renderCountdown(vault: RemoteVault, now: () => number): void {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider storage={storage} keyVault={keyVault} remoteVault={vault}>
      {children}
    </WalletProvider>
  );
  render(
    <Wrapper>
      <AutoLockCountdown pollMs={10_000} now={now} />
    </Wrapper>,
  );
}

describe('AutoLockCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the remaining time as m:ss from the background expiry', async () => {
    let clock = BASE;
    renderCountdown(makeVault(BASE + 120_000), () => clock); // 2:00 out
    // Let the initial getSession poll resolve.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('auto-lock-countdown')).toHaveTextContent('2:00');
  });

  it('counts DOWN as the clock advances', async () => {
    let clock = BASE;
    renderCountdown(makeVault(BASE + 120_000), () => clock);
    await act(async () => {
      await Promise.resolve();
    });
    // Advance the wall clock 75s and let the 1s ticks fire.
    clock = BASE + 75_000;
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('auto-lock-countdown')).toHaveTextContent('0:45');
  });

  it('renders nothing when there is no active auto-lock window (web/mobile)', async () => {
    let clock = BASE;
    renderCountdown(makeVault(null), () => clock);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('auto-lock-countdown')).not.toBeInTheDocument();
  });

  it('LOCKS the wallet the instant the countdown reaches zero', async () => {
    let clock = BASE;
    const vault = makeVault(BASE + 5000); // 5s out
    renderCountdown(vault, () => clock);
    await act(async () => {
      await Promise.resolve();
    });
    expect(vault.lockCalls).toBe(0);
    // Advance past expiry and let the 1s tick notice.
    clock = BASE + 6000;
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(vault.lockCalls).toBeGreaterThanOrEqual(1);
  });
});
