import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import type { Balances, ChainBalance } from '@stoawallet/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { useBalances } from '../useBalances';

const ACCOUNT_A = 'k:aaa';
const ACCOUNT_B = 'k:bbb';

/** Build a 10-chain Record keyed "0".."9", letting individual chains override. */
function makeBalances(
  overrides: Record<string, ChainBalance> = {},
  base: ChainBalance = { balance: '0.0', exists: false },
): Balances {
  const out: Balances = {};
  for (let i = 0; i < 10; i += 1) {
    out[String(i)] = overrides[String(i)] ?? base;
  }
  return out;
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

describe('useBalances', () => {
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

  it('fetches once for the active account and classifies all 10 chains in STOA_CHAINS order', async () => {
    const { wrapper } = makeWrapper();
    // Chain 4 funded, the rest absent — proves per-chain classification AND order.
    const getBalances = vi.fn(async () =>
      makeBalances({ '4': { balance: '12.5', exists: true } }),
    );

    const { result } = renderHook(
      () => useBalances({ account: ACCOUNT_A, getBalances }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Called exactly once with the active account — not re-fetched on re-render.
    expect(getBalances).toHaveBeenCalledTimes(1);
    expect(getBalances).toHaveBeenCalledWith(ACCOUNT_A);

    // Ten classified statuses, indexed by chain id, with the funded chain at 4.
    expect(result.current.chains).toHaveLength(10);
    expect(result.current.chains[4]).toEqual({
      kind: 'funded',
      chainId: 4,
      balance: '12.5',
    });
    expect(result.current.chains[0]).toEqual({ kind: 'absent', chainId: 0 });
    // Total only includes the single funded chain (12.5), no errored chains.
    expect(result.current.total.total).toBe('12.500000000000');
    expect(result.current.total.includedChains).toBe(1);
    expect(result.current.total.erroredChains).toBe(0);
  });

  it('isolates a single chain error inside chains and keeps the hook-level error null', async () => {
    const { wrapper } = makeWrapper();
    const getBalances = vi.fn(async () =>
      makeBalances(
        { '2': { balance: '0.0', exists: false, error: 'rpc timeout' } },
        { balance: '1.0', exists: true },
      ),
    );

    const { result } = renderHook(
      () => useBalances({ account: ACCOUNT_A, getBalances }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // A per-chain read failure surfaces as that chain's `errored` status, never
    // as a hook-level error — the other nine chains still render their balance.
    expect(result.current.error).toBeNull();
    const errored = result.current.chains.filter((c) => c.kind === 'errored');
    expect(errored).toEqual([
      { kind: 'errored', chainId: 2, error: 'rpc timeout' },
    ]);
    expect(
      result.current.chains.filter((c) => c.kind !== 'errored'),
    ).toHaveLength(9);
  });

  it('exposes isLoading on the initial fetch and switches refresh() to isRefreshing once data is present', async () => {
    const { wrapper } = makeWrapper();
    let resolveFetch: (b: Balances) => void = () => {};
    const getBalances = vi.fn(
      () =>
        new Promise<Balances>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const { result } = renderHook(
      () => useBalances({ account: ACCOUNT_A, getBalances }),
      { wrapper },
    );

    // Initial fetch in flight: isLoading true (no data yet), isRefreshing false.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isRefreshing).toBe(false);

    await act(async () => {
      resolveFetch(makeBalances());
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // refresh() with data already present is a re-fetch: isRefreshing, NOT a
    // reset to the blocking initial isLoading state.
    act(() => {
      void result.current.refresh();
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    expect(result.current.isLoading).toBe(false);

    await act(async () => {
      resolveFetch(makeBalances());
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
  });

  it('re-fetches when the active account changes and discards a late result from the prior account', async () => {
    const { wrapper } = makeWrapper();
    let resolveA: (b: Balances) => void = () => {};
    const aResult = makeBalances({ '0': { balance: '99.0', exists: true } });
    const bResult = makeBalances({ '0': { balance: '7.0', exists: true } });

    const getBalances = vi.fn((account: string) => {
      if (account === ACCOUNT_A) {
        return new Promise<Balances>((resolve) => {
          resolveA = resolve;
        });
      }
      return Promise.resolve(bResult);
    });

    const { result, rerender } = renderHook(
      ({ account }: { account: string }) =>
        useBalances({ account, getBalances }),
      { wrapper, initialProps: { account: ACCOUNT_A } },
    );

    // A's fetch is in flight (unresolved). Switch to B.
    expect(result.current.isLoading).toBe(true);
    rerender({ account: ACCOUNT_B });
    await waitFor(() =>
      expect(result.current.chains[0]).toEqual({
        kind: 'funded',
        chainId: 0,
        balance: '7.0',
      }),
    );

    // A resolves LATE, after the switch. Its stale result must be discarded so
    // B's balances are never overwritten by the prior account's data.
    await act(async () => {
      resolveA(aResult);
    });
    expect(result.current.chains[0]).toEqual({
      kind: 'funded',
      chainId: 0,
      balance: '7.0',
    });
  });

  it('treats a null active account as idle/locked: no fetch, no error, prior chains cleared', async () => {
    const { wrapper } = makeWrapper();
    const getBalances = vi.fn(async () =>
      makeBalances({ '0': { balance: '5.0', exists: true } }),
    );

    const { result, rerender } = renderHook(
      ({ account }: { account: string | null }) =>
        useBalances({ account, getBalances }),
      { wrapper, initialProps: { account: ACCOUNT_A as string | null } },
    );

    await waitFor(() => expect(result.current.chains).toHaveLength(10));
    expect(getBalances).toHaveBeenCalledTimes(1);

    // Account goes null (lock / no wallet): a distinct idle state, NOT a
    // perpetual isLoading and NOT a spurious error. Stale balances are cleared.
    rerender({ account: null });
    await waitFor(() => expect(result.current.chains).toHaveLength(0));
    expect(result.current.isIdle).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    // No additional fetch was triggered by the null account.
    expect(getBalances).toHaveBeenCalledTimes(1);
  });

  it('flags the total as unable-to-load when every existing chain errored (vs all-absent)', async () => {
    const { wrapper } = makeWrapper();
    // All ten chains errored — includedChains stays 0 because of failures, not
    // because the account is empty.
    const getBalances = vi.fn(async () =>
      makeBalances({}, { balance: '0.0', exists: false, error: 'down' }),
    );

    const { result } = renderHook(
      () => useBalances({ account: ACCOUNT_A, getBalances }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // The view must distinguish "unable to load" from a real zero: includedChains
    // is 0 AND erroredChains is >0, so the total is not a trustworthy "0".
    expect(result.current.error).toBeNull();
    expect(result.current.total.includedChains).toBe(0);
    expect(result.current.total.erroredChains).toBe(10);
  });

  it('surfaces a hook-level error when getBalances returns the wrong chain count', async () => {
    const { wrapper } = makeWrapper();
    // Eight chains instead of ten — rendering this as rows would show the wrong
    // count, so the hook must refuse it as a distinct error.
    const getBalances = vi.fn(async () => {
      const partial: Balances = {};
      for (let i = 0; i < 8; i += 1) {
        partial[String(i)] = { balance: '0.0', exists: false };
      }
      return partial;
    });

    const { result } = renderHook(
      () => useBalances({ account: ACCOUNT_A, getBalances }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    // Wrong-count is a hard error, not a per-chain errored status.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.chains).toHaveLength(0);
  });

  it('surfaces a hook-level error only when getBalances itself rejects (total failure)', async () => {
    const { wrapper } = makeWrapper();
    const getBalances = vi.fn(async () => {
      throw new Error('network unreachable');
    });

    const { result } = renderHook(
      () => useBalances({ account: ACCOUNT_A, getBalances }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('network unreachable');
    expect(result.current.isLoading).toBe(false);

    // Even a total failure stays silent — no console noise leaks from the hook.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
