import {
  type UrStoaHoldingsResult,
  type VaultTotalResult,
  getUrStoaHoldings as coreGetUrStoaHoldings,
  getVaultTotal as coreGetVaultTotal,
} from '@stoawallet/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useWallet } from '../context/WalletContext';

/**
 * Async read seam over the T12.2 core UrStoa reads, injectable so tests stub the
 * network off-band. `getUrStoaHoldings` resolves the account's wallet/vault/
 * earnings figures; `getVaultTotal` resolves the live staked vault total. Both
 * resolve their endpoint through the active-node config inside core — this hook
 * never hardcodes a node (XP-18a). A `null`/failed read is a discriminated
 * result, never a thrown batch.
 */
export type GetUrStoaHoldingsFn = (
  account: string,
) => Promise<UrStoaHoldingsResult>;
export type GetVaultTotalFn = () => Promise<VaultTotalResult>;

export interface UseUrStoaHoldingsOptions {
  /**
   * The `k:` account to read. When omitted the hook resolves the active account
   * from `useWallet()` — the single account source (no direct manager access).
   * `null` is the explicit idle/locked signal.
   */
  readonly account?: string | null;
  /** Override the core holdings read for tests. Defaults to core. */
  readonly getUrStoaHoldings?: GetUrStoaHoldingsFn;
  /** Override the core vault-total read for tests. Defaults to core. */
  readonly getVaultTotal?: GetVaultTotalFn;
}

export interface UseUrStoaHoldingsResult {
  /** Spendable wallet UrStoa, or `null` when the holdings read is unknown/idle. */
  readonly walletBalance: string | null;
  /** Staked vault UrStoa, or `null` when the holdings read is unknown/idle. */
  readonly vaultBalance: string | null;
  /** Pending vault earnings in STOA, or `null` when unknown/idle. */
  readonly vaultEarnings: string | null;
  /**
   * Live total staked UrStoa in the vault, or `null` when unknown/idle. A `null`
   * here is the DISTINCT unknown state — never coerced to `"0"`.
   */
  readonly vaultTotal: string | null;
  /** Initial read with no data yet on screen. */
  readonly isLoading: boolean;
  /** Re-read while prior data is still displayed. */
  readonly isRefreshing: boolean;
  /**
   * True when a read resolved but could not produce trustworthy figures — the
   * holdings read failed OR the vault total was an `unknown` null balance. The
   * view shows "—"/unknown rather than a misleading "0". Distinct from `error`.
   */
  readonly isUnknown: boolean;
  /** Set ONLY on a hard vault-total read failure (`read-failed`). */
  readonly error: Error | null;
  /** No active account: nothing read, holdings cleared, not loading, not errored. */
  readonly isIdle: boolean;
  /** Re-read the active account's holdings + the live vault total. */
  refresh(): Promise<void>;
}

/**
 * The resolved holdings + vault total for a single read, stored verbatim. A
 * `null` `holdings` is the soft-unknown holdings state; a `null` `vaultTotal`
 * with `vaultTotalUnknown` set is the soft-unknown vault-total state — both
 * distinct from the hard `error` state and from a real `"0"`.
 */
interface Holdings {
  readonly walletBalance: string | null;
  readonly vaultBalance: string | null;
  readonly vaultEarnings: string | null;
  readonly vaultTotal: string | null;
  readonly unknown: boolean;
}

type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'refreshing'; data: Holdings }
  | { status: 'success'; data: Holdings }
  | { status: 'error'; error: Error; data: Holdings | null };

const EMPTY: Holdings = {
  walletBalance: null,
  vaultBalance: null,
  vaultEarnings: null,
  vaultTotal: null,
  unknown: false,
};

/**
 * State hook for the active account's UrStoa wallet/vault/earnings holdings plus
 * the live vault total, read on chain 0 (a SINGLE account — not a 10-chain
 * fan-out). Reads core ONCE per (account, refresh) pair.
 *
 * Staleness guard: every read captures the account it targets plus a monotonic
 * nonce; on resolve it commits only if BOTH still match the live values, so a
 * late result from a prior account (or a superseded refresh) is discarded.
 *
 * null≠"0": a failed holdings read OR a `null` vault total surfaces as the
 * distinct `isUnknown` state with `null` figures, never a misleading `"0"`. A
 * null active account is a first-class idle/locked state that CLEARS prior
 * holdings. Emits no telemetry — never logs the account or balances.
 */
export function useUrStoaHoldings(
  options: UseUrStoaHoldingsOptions = {},
): UseUrStoaHoldingsResult {
  const wallet = useWallet();
  const readHoldings = options.getUrStoaHoldings ?? coreGetUrStoaHoldings;
  const readVaultTotal = options.getVaultTotal ?? coreGetVaultTotal;
  const account =
    options.account !== undefined
      ? options.account
      : (wallet.activeAccount?.account ?? null);

  const [state, setState] = useState<FetchState>({ status: 'idle' });

  // Identity of the read currently allowed to commit: the account it targets
  // plus a monotonic nonce. A resolving read compares against these to decide
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

      // A refresh keeps the prior data on screen; only an initial read (no prior
      // data) shows the loader.
      setState((prev) =>
        refreshing && (prev.status === 'success' || prev.status === 'refreshing')
          ? { status: 'refreshing', data: prev.data }
          : { status: 'loading' },
      );

      void Promise.all([
        readHoldings(targetAccount),
        readVaultTotal(),
      ]).then(
        ([holdingsResult, totalResult]) => {
          const live = requestRef.current;
          if (live.account !== targetAccount || live.nonce !== nonce) return;

          // A hard vault-total read failure is the only case that surfaces a
          // blanking hook-level error; the soft `unknown` (null balance) does not.
          if (!totalResult.ok && totalResult.reason === 'read-failed') {
            setState((prev) => ({
              status: 'error',
              error: new Error('UrStoa vault total read failed'),
              data: prev.status === 'refreshing' ? prev.data : null,
            }));
            return;
          }

          const holdingsUnknown = !holdingsResult.ok;
          const vaultTotalUnknown = !totalResult.ok;

          const data: Holdings = {
            walletBalance: holdingsResult.ok
              ? holdingsResult.holdings.walletBalance
              : null,
            vaultBalance: holdingsResult.ok
              ? holdingsResult.holdings.vaultBalance
              : null,
            vaultEarnings: holdingsResult.ok
              ? holdingsResult.holdings.vaultEarnings
              : null,
            vaultTotal: totalResult.ok ? totalResult.vaultTotal : null,
            unknown: holdingsUnknown || vaultTotalUnknown,
          };
          setState({ status: 'success', data });
        },
        () => {
          const live = requestRef.current;
          if (live.account !== targetAccount || live.nonce !== nonce) return;
          // A thrown read (neither core read should throw, but a stubbed one
          // could) collapses to the hook-level error, preserving prior data on a
          // refresh so a transient failure never blanks populated holdings.
          setState((prev) => ({
            status: 'error',
            error: new Error('UrStoa holdings read failed'),
            data: prev.status === 'refreshing' ? prev.data : null,
          }));
        },
      );
    },
    [readHoldings, readVaultTotal],
  );

  // Drive the read off account identity. A new account (or going null) issues a
  // fresh request whose nonce supersedes any in-flight prior-account read.
  useEffect(() => {
    runFetch(account, false);
  }, [account, runFetch]);

  const refresh = useCallback(async () => {
    runFetch(account, true);
  }, [account, runFetch]);

  const data: Holdings =
    state.status === 'success' || state.status === 'refreshing'
      ? state.data
      : state.status === 'error' && state.data !== null
        ? state.data
        : EMPTY;

  return {
    walletBalance: data.walletBalance,
    vaultBalance: data.vaultBalance,
    vaultEarnings: data.vaultEarnings,
    vaultTotal: data.vaultTotal,
    isLoading: state.status === 'loading',
    isRefreshing: state.status === 'refreshing',
    isUnknown:
      (state.status === 'success' || state.status === 'refreshing') &&
      state.data.unknown,
    error: state.status === 'error' ? state.error : null,
    isIdle: state.status === 'idle',
    refresh,
  };
}
