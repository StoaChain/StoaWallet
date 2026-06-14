import {
  type Balances,
  coreInfo,
  getBalances as coreGetBalances,
} from '@stoawallet/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useWallet } from '../context/WalletContext';
import {
  type AggregateTotal,
  type ChainBalanceReadResult,
  type ChainBalanceStatus,
  aggregateTotal,
  classifyChainBalance,
} from './balanceModel';

/**
 * Async read seam: `@stoawallet/core`'s `getBalances`, injectable so tests stub
 * the network without an AbortController. Returns the per-chain Record keyed
 * "0".."9"; one chain's failure is its own `error`, never a thrown batch.
 */
export type GetBalancesFn = (account: string) => Promise<Balances>;

export interface UseBalancesOptions {
  /**
   * The `k:` account to read. When omitted the hook resolves the active account
   * from `useWallet()` — the single account source (no direct manager access).
   * `null` is the explicit idle/locked signal.
   */
  readonly account?: string | null;
  /** Override the core read for tests. Defaults to the real core `getBalances`. */
  readonly getBalances?: GetBalancesFn;
}

export interface UseBalancesResult {
  /** One classified status per chain, length 10 in STOA_CHAINS order. Empty when idle. */
  readonly chains: ChainBalanceStatus[];
  /** Cross-chain aggregate. `includedChains===0 && erroredChains>0` ⇒ unable-to-load. */
  readonly total: AggregateTotal;
  /** Initial fetch with no data yet on screen. */
  readonly isLoading: boolean;
  /** Re-fetch while prior data is still displayed. */
  readonly isRefreshing: boolean;
  /** Set ONLY on an INITIAL-load total failure (no prior data to preserve). */
  readonly error: Error | null;
  /**
   * Set when a REFRESH fails while prior data is still on screen. Non-blanking:
   * `chains`/`total` keep showing the last good read so a transient refresh
   * failure never wipes populated balances. Cleared on the next refresh attempt
   * and on any success.
   */
  readonly refreshError: Error | null;
  /** No active account: nothing fetched, chains cleared, not loading, not errored. */
  readonly isIdle: boolean;
  /** Re-read the active account's balances. */
  refresh(): Promise<void>;
}

const EMPTY_TOTAL: AggregateTotal = {
  total: '0.000000000000',
  includedChains: 0,
  erroredChains: 0,
};

/** Chain ids ("0".."9") in ascending numeric order, derived from the result. */
function orderedChainIds(data: Balances): string[] {
  return Object.keys(data).sort((a, b) => Number(a) - Number(b));
}

/**
 * Internal fetch outcome stored verbatim; `chains`/`total` are derived from it.
 *
 * The data-bearing states carry an optional `refreshError`: a refresh that
 * rejects keeps the prior `data` and records the error here instead of
 * collapsing to the blanking top-level `error`, so populated balances survive a
 * transient refresh failure. The top-level `error` state is reserved for an
 * INITIAL load that fails with no prior data to preserve.
 */
type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'refreshing'; data: Balances; refreshError: Error | null }
  | { status: 'success'; data: Balances; refreshError: Error | null }
  | { status: 'error'; error: Error };

/**
 * State hook for the active account's cross-chain balances.
 *
 * Reads `getBalances` ONCE per (account, refresh) pair and derives the 10
 * classified chain statuses + aggregate via `useMemo` over the stored raw
 * Record, so references stay stable across unrelated renders. A null account is
 * a first-class idle/locked state rather than a perpetual load or fake error.
 *
 * Staleness guard: every fetch captures both the account it was issued for and a
 * monotonic nonce; on resolve it only commits if BOTH still match the live
 * values, so a late result from a prior account (or a superseded refresh) is
 * discarded. Cancellation is discard-only — no AbortController plumbing.
 */
export function useBalances(
  options: UseBalancesOptions = {},
): UseBalancesResult {
  const wallet = useWallet();
  const fetcher = options.getBalances ?? coreGetBalances;
  const account =
    options.account !== undefined
      ? options.account
      : (wallet.activeAccount?.account ?? null);

  const [state, setState] = useState<FetchState>({ status: 'idle' });

  // Identity of the fetch currently allowed to commit: the account it targets
  // plus a monotonic nonce. A resolving fetch compares against these to decide
  // whether it is still the latest in-flight request for the current account.
  const requestRef = useRef<{ account: string | null; nonce: number }>({
    account: null,
    nonce: 0,
  });

  const runFetch = useCallback(
    (targetAccount: string | null, refreshing: boolean) => {
      if (targetAccount === null) {
        requestRef.current = {
          account: null,
          nonce: requestRef.current.nonce + 1,
        };
        setState({ status: 'idle' });
        return;
      }

      const nonce = requestRef.current.nonce + 1;
      requestRef.current = { account: targetAccount, nonce };

      // A refresh keeps the prior data on screen and clears any stale
      // refreshError; only an initial fetch (no prior data) shows the loader.
      setState((prev) =>
        refreshing && (prev.status === 'success' || prev.status === 'refreshing')
          ? { status: 'refreshing', data: prev.data, refreshError: null }
          : { status: 'loading' },
      );

      void fetcher(targetAccount).then(
        (data) => {
          const live = requestRef.current;
          if (live.account !== targetAccount || live.nonce !== nonce) return;

          const count = Object.keys(data).length;
          if (count !== coreInfo.chainCount) {
            setState({
              status: 'error',
              error: new Error(
                `Expected ${coreInfo.chainCount} chain balances, got ${count}`,
              ),
            });
            return;
          }
          setState({ status: 'success', data, refreshError: null });
        },
        (reason: unknown) => {
          const live = requestRef.current;
          if (live.account !== targetAccount || live.nonce !== nonce) return;
          const err =
            reason instanceof Error ? reason : new Error(String(reason));
          // A failed REFRESH retains the still-valid on-screen data and surfaces
          // a non-blanking refreshError. The blanking top-level error is reserved
          // for an INITIAL-load failure where there is no prior data to keep.
          setState((prev) =>
            prev.status === 'refreshing'
              ? { status: 'success', data: prev.data, refreshError: err }
              : { status: 'error', error: err },
          );
        },
      );
    },
    [fetcher],
  );

  // Drive the fetch off account identity. A new account (or going null) issues a
  // fresh request whose nonce supersedes any in-flight prior-account fetch.
  useEffect(() => {
    runFetch(account, false);
  }, [account, runFetch]);

  const refresh = useCallback(async () => {
    runFetch(account, true);
  }, [account, runFetch]);

  const raw: Balances | null =
    state.status === 'success' || state.status === 'refreshing'
      ? state.data
      : null;

  const chains = useMemo<ChainBalanceStatus[]>(() => {
    if (raw === null) return [];
    return orderedChainIds(raw).map((chainId) => {
      const entry: ChainBalanceReadResult = raw[chainId];
      return classifyChainBalance(Number(chainId), entry);
    });
  }, [raw]);

  const total = useMemo<AggregateTotal>(() => {
    if (raw === null) return EMPTY_TOTAL;
    return aggregateTotal(orderedChainIds(raw).map((chainId) => raw[chainId]));
  }, [raw]);

  return {
    chains,
    total,
    isLoading: state.status === 'loading',
    isRefreshing: state.status === 'refreshing',
    error: state.status === 'error' ? state.error : null,
    refreshError:
      state.status === 'success' ? state.refreshError : null,
    isIdle: state.status === 'idle',
    refresh,
  };
}
