import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import type {
  UrStoaHoldingsResult,
  VaultTotalResult,
} from '@stoawallet/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { useUrStoaHoldings } from '../useUrStoaHoldings';

const ACCOUNT_A = 'k:aaa';
const ACCOUNT_B = 'k:bbb';

function okHoldings(
  over: Partial<{
    walletBalance: string;
    vaultBalance: string;
    vaultEarnings: string;
  }> = {},
): UrStoaHoldingsResult {
  return {
    ok: true,
    holdings: {
      walletBalance: over.walletBalance ?? '0',
      vaultBalance: over.vaultBalance ?? '0',
      vaultEarnings: over.vaultEarnings ?? '0',
    },
  };
}

function okTotal(vaultTotal: string): VaultTotalResult {
  return { ok: true, vaultTotal };
}

function makeWrapper() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider storage={storage} keyVault={keyVault}>
      {children}
    </WalletProvider>
  );
  return { wrapper };
}

describe('useUrStoaHoldings', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads once for the active account and exposes wallet/vault/earnings/total', async () => {
    const { wrapper } = makeWrapper();
    const getUrStoaHoldings = vi.fn(async () =>
      okHoldings({
        walletBalance: '12.5',
        vaultBalance: '3.25',
        vaultEarnings: '0.7',
      }),
    );
    const getVaultTotal = vi.fn(async () => okTotal('1000.0'));

    const { result } = renderHook(
      () =>
        useUrStoaHoldings({
          account: ACCOUNT_A,
          getUrStoaHoldings,
          getVaultTotal,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Each read fires exactly once for the active account — no re-fetch on
    // unrelated re-renders, and the holdings read is keyed to the account.
    expect(getUrStoaHoldings).toHaveBeenCalledTimes(1);
    expect(getUrStoaHoldings).toHaveBeenCalledWith(ACCOUNT_A);
    expect(getVaultTotal).toHaveBeenCalledTimes(1);

    // The four headline figures surface verbatim from the core read — the view
    // renders these, so a drift in any one is a user-visible wrong balance.
    expect(result.current.walletBalance).toBe('12.5');
    expect(result.current.vaultBalance).toBe('3.25');
    expect(result.current.vaultEarnings).toBe('0.7');
    expect(result.current.vaultTotal).toBe('1000.0');
    expect(result.current.error).toBeNull();
    expect(result.current.isIdle).toBe(false);
  });

  it('surfaces a distinct unknown state (NOT "0") when the holdings read fails', async () => {
    const { wrapper } = makeWrapper();
    const getUrStoaHoldings = vi.fn(
      async (): Promise<UrStoaHoldingsResult> => ({
        ok: false,
        reason: 'read-failed',
      }),
    );
    const getVaultTotal = vi.fn(async () => okTotal('1000.0'));

    const { result } = renderHook(
      () =>
        useUrStoaHoldings({
          account: ACCOUNT_A,
          getUrStoaHoldings,
          getVaultTotal,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // A failed holdings read must NOT collapse to a misleading "0" — the user
    // would mistake an unreadable account for an empty one. The figures are
    // null (unknown) instead.
    expect(result.current.walletBalance).toBeNull();
    expect(result.current.vaultBalance).toBeNull();
    expect(result.current.vaultEarnings).toBeNull();
    expect(result.current.isUnknown).toBe(true);
  });

  it('surfaces vaultTotal as unknown (NOT "0") when getVaultTotal returns unknown', async () => {
    const { wrapper } = makeWrapper();
    const getUrStoaHoldings = vi.fn(async () => okHoldings());
    const getVaultTotal = vi.fn(
      async (): Promise<VaultTotalResult> => ({ ok: false, reason: 'unknown' }),
    );

    const { result } = renderHook(
      () =>
        useUrStoaHoldings({
          account: ACCOUNT_A,
          getUrStoaHoldings,
          getVaultTotal,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // A null vault balance is the DISTINCT unknown state — coercing it to "0"
    // would let the last-staker floor (T12.7) lift incorrectly.
    expect(result.current.vaultTotal).toBeNull();
    expect(result.current.isUnknown).toBe(true);
  });

  it('sets error only when the vault total read fails (read-failed)', async () => {
    const { wrapper } = makeWrapper();
    const getUrStoaHoldings = vi.fn(async () => okHoldings());
    const getVaultTotal = vi.fn(
      async (): Promise<VaultTotalResult> => ({
        ok: false,
        reason: 'read-failed',
      }),
    );

    const { result } = renderHook(
      () =>
        useUrStoaHoldings({
          account: ACCOUNT_A,
          getUrStoaHoldings,
          getVaultTotal,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // A hard total-read failure is the one case that surfaces a hook-level
    // error (distinct from the soft `unknown` null-balance case).
    expect(result.current.error).not.toBeNull();
    expect(result.current.vaultTotal).toBeNull();
  });

  it('treats a null active account as idle/locked: no read, no error, prior holdings cleared', async () => {
    const { wrapper } = makeWrapper();
    const getUrStoaHoldings = vi.fn(async () =>
      okHoldings({ walletBalance: '5.0' }),
    );
    const getVaultTotal = vi.fn(async () => okTotal('1000.0'));

    const { result, rerender } = renderHook(
      ({ account }: { account: string | null }) =>
        useUrStoaHoldings({ account, getUrStoaHoldings, getVaultTotal }),
      { wrapper, initialProps: { account: ACCOUNT_A as string | null } },
    );

    await waitFor(() => expect(result.current.walletBalance).toBe('5.0'));
    expect(getUrStoaHoldings).toHaveBeenCalledTimes(1);

    // Account goes null (lock / no wallet): a distinct idle state, NOT a
    // perpetual load nor a spurious error. Prior holdings are CLEARED so a
    // re-lock never leaves the previous account's balances on screen.
    rerender({ account: null });
    await waitFor(() => expect(result.current.isIdle).toBe(true));
    expect(result.current.walletBalance).toBeNull();
    expect(result.current.vaultBalance).toBeNull();
    expect(result.current.vaultTotal).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    // The null account triggered no additional read.
    expect(getUrStoaHoldings).toHaveBeenCalledTimes(1);
  });

  it('re-fetches on account change and discards a late result from the prior account', async () => {
    const { wrapper } = makeWrapper();
    let resolveA: (r: UrStoaHoldingsResult) => void = () => {};
    const aResult = okHoldings({ walletBalance: '99.0' });
    const bResult = okHoldings({ walletBalance: '7.0' });

    const getUrStoaHoldings = vi.fn((account: string) => {
      if (account === ACCOUNT_A) {
        return new Promise<UrStoaHoldingsResult>((resolve) => {
          resolveA = resolve;
        });
      }
      return Promise.resolve(bResult);
    });
    const getVaultTotal = vi.fn(async () => okTotal('1000.0'));

    const { result, rerender } = renderHook(
      ({ account }: { account: string }) =>
        useUrStoaHoldings({ account, getUrStoaHoldings, getVaultTotal }),
      { wrapper, initialProps: { account: ACCOUNT_A } },
    );

    // A's read is in flight (unresolved). Switch to B before it resolves.
    expect(result.current.isLoading).toBe(true);
    rerender({ account: ACCOUNT_B });
    await waitFor(() => expect(result.current.walletBalance).toBe('7.0'));

    // A resolves LATE, after the switch. Its stale result must be discarded so
    // the current account B's holdings are never overwritten.
    await act(async () => {
      resolveA(aResult);
    });
    expect(result.current.walletBalance).toBe('7.0');
  });

  it('toggles isRefreshing (not isLoading) on refresh() when data is present', async () => {
    const { wrapper } = makeWrapper();
    let resolveHoldings: (r: UrStoaHoldingsResult) => void = () => {};
    const getUrStoaHoldings = vi.fn(
      () =>
        new Promise<UrStoaHoldingsResult>((resolve) => {
          resolveHoldings = resolve;
        }),
    );
    const getVaultTotal = vi.fn(async () => okTotal('1000.0'));

    const { result } = renderHook(
      () =>
        useUrStoaHoldings({
          account: ACCOUNT_A,
          getUrStoaHoldings,
          getVaultTotal,
        }),
      { wrapper },
    );

    // Initial read in flight: isLoading true, isRefreshing false (no data yet).
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isRefreshing).toBe(false);

    await act(async () => {
      resolveHoldings(okHoldings({ walletBalance: '4.0' }));
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // refresh() with data already on screen is a re-fetch: isRefreshing, NOT a
    // reset to the blocking initial isLoading.
    act(() => {
      void result.current.refresh();
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.isLoading).toBe(false);
    // The prior balance stays visible during the refresh (non-blanking).
    expect(result.current.walletBalance).toBe('4.0');

    await act(async () => {
      resolveHoldings(okHoldings({ walletBalance: '8.0' }));
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.walletBalance).toBe('8.0');
  });

  it('never logs the account or balances as telemetry', async () => {
    const { wrapper } = makeWrapper();
    const getUrStoaHoldings = vi.fn(async () =>
      okHoldings({ walletBalance: '12.5' }),
    );
    const getVaultTotal = vi.fn(async () => okTotal('1000.0'));

    const { result } = renderHook(
      () =>
        useUrStoaHoldings({
          account: ACCOUNT_A,
          getUrStoaHoldings,
          getVaultTotal,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
