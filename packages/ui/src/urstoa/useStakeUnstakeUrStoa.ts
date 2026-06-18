import { useCallback, useEffect, useRef, useState } from 'react';

import {
  useWallet,
  type ContextUrStoaResult,
  type ContextUrStoaStakeParams,
} from '../context/WalletContext';

import { formatUrStoaAmount } from './amount';
import { maxUnstake } from './maxUnstake';

/**
 * Staged state machine for an UrStoa stake/unstake (chain 0, gasless).
 *
 * `building` is set SYNCHRONOUSLY on `stake()`/`unstake()` entry (before the
 * first await over the signing seam) so the double-submit guard and progress UI
 * engage immediately (RR#9). `submitting` covers the in-flight op.
 *
 * `pending` is reserved EXCLUSIVELY for the genuinely ambiguous case: the op
 * THREW/timed out AFTER being dispatched (the tx may be on-chain), so the hook
 * lands on `pending` (carrying any requestKey) rather than a re-armed idle to make
 * an auto-resubmit / double-spend impossible. A clean DISCRIMINATED `{ok:false}`
 * result — and every pre-flight rejection (insufficient-funds, vault-total-
 * unknown, locked) — maps to an `error` state with that reason, NEVER `pending`:
 * no tx was ever built.
 */
export type StakeUnstakeState =
  | { readonly status: 'idle' }
  | { readonly status: 'building' }
  | { readonly status: 'submitting' }
  | { readonly status: 'success'; readonly requestKey: string }
  | {
      readonly status: 'error';
      readonly reason: string;
      readonly detail?: string;
    }
  | { readonly status: 'pending'; readonly requestKey?: string };

/** Which operation a submit is performing — drives the floor + balance bound. */
export type StakeUnstakeKind = 'stake' | 'unstake';

/**
 * The WalletContext stake/unstake seam signature (XP-12). The hook passes PUBLIC
 * params ONLY — the active payment-key ADDRESS + a pre-formatted decimal amount;
 * the context resolves the keypair locally (mobile/web) or routes the whole op to
 * the background (extension). No keypair ever crosses from the hook.
 */
export type UrStoaOpSeam = (params: {
  readonly paymentKeyAddress: string;
  readonly amount: string;
}) => Promise<ContextUrStoaResult>;

export interface UseStakeUnstakeUrStoaOptions {
  /**
   * The active `k:` payment-key the op stakes from / unstakes to. When omitted the
   * hook reads it from `useWallet().activeAccount`. `null` is the explicit
   * locked/no-active-account signal (no seam call is made).
   */
  readonly paymentKeyAddress?: string | null;
  /**
   * STAKE seam. Defaults to the WalletContext `urstoaStake` op (local-vs-remote
   * handled inside). Tests inject a stub.
   */
  readonly urstoaStake?: UrStoaOpSeam;
  /**
   * UNSTAKE seam. Defaults to the WalletContext `urstoaUnstake` op. Tests inject a stub.
   */
  readonly urstoaUnstake?: UrStoaOpSeam;
  /**
   * The active account's spendable UrStoa wallet balance (from T12.6), as a
   * decimal STRING or null when unknown. Bounds a STAKE; null skips the bound.
   */
  readonly walletBalance?: string | null;
  /**
   * The user's own staked UrStoa (from T12.6 `vaultBalance`), as a decimal STRING
   * or null. Bounds an UNSTAKE and feeds the last-staker floor; null/unknown
   * BLOCKS the unstake (fail-closed).
   */
  readonly userStaked?: string | null;
  /**
   * The live vault total (from T12.6/T12.2 `getVaultTotal` /
   * `getUrStoaBalance(VAULT_ADDRESS)`), as a decimal STRING or null when unknown.
   * Null/unknown BLOCKS an unstake with `vault-total-unknown` — never coerced to 0.
   */
  readonly vaultTotal?: string | null;
  /** The T12.6 holdings refresh, fired once on a successful submit. */
  readonly refresh?: () => void;
}

export interface UseStakeUnstakeUrStoaResult {
  readonly state: StakeUnstakeState;
  /** Stake `amount` UrStoa (bounded by the wallet balance). */
  stake(params: { amount: string }): Promise<void>;
  /** Unstake `amount` UrStoa (bounded by the user's stake + the last-staker floor). */
  unstake(params: { amount: string }): Promise<void>;
  /** Reset back to idle. */
  reset(): void;
}

/** Statuses from which a fresh stake/unstake may start. */
function isArmed(status: StakeUnstakeState['status']): boolean {
  return status === 'idle' || status === 'error' || status === 'success';
}

/** A plain non-negative decimal: integer part, optional dot + fraction. */
const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** True when `value` is a usable non-negative plain decimal string. */
function isUsableDecimal(value: string | null | undefined): value is string {
  return typeof value === 'string' && DECIMAL_RE.test(value.trim());
}

/**
 * Compare two well-formed non-negative decimal STRINGS without float drift:
 * returns true when `amount > limit`. Both are padded to a common fractional
 * width and compared as big-integer strings, so high-precision values rank exactly
 * (a float compare would mis-rank near the smallest digit).
 */
function amountExceeds(amount: string, limit: string): boolean {
  const norm = (v: string): [string, string] => {
    const t = v.trim();
    const dot = t.indexOf('.');
    return dot === -1 ? [t, ''] : [t.slice(0, dot), t.slice(dot + 1)];
  };
  const [aInt, aFracRaw] = norm(amount);
  const [bInt, bFracRaw] = norm(limit);
  const width = Math.max(aFracRaw.length, bFracRaw.length);
  const a = `${aInt}${aFracRaw.padEnd(width, '0')}`.replace(/^0+(?=\d)/, '');
  const b = `${bInt}${bFracRaw.padEnd(width, '0')}`.replace(/^0+(?=\d)/, '');
  if (a.length !== b.length) return a.length > b.length;
  return a > b;
}

/**
 * State hook wrapping the WalletContext stake/unstake seams (XP-12) with the
 * staged state machine, the last-staker floor (REQ-21), the insufficient-funds
 * pre-flight (RR#6), the in-hook double-submit guard, the lost-response `pending`
 * landing, and the on-success T12.6 `refresh()`.
 *
 * SECURITY (XP-12): the hook NEVER touches a keypair (not even a public-only one).
 * It passes the active account ADDRESS + the formatted amount to the context seam,
 * which resolves the keypair LOCALLY (mobile/web) or routes the whole op to the
 * BACKGROUND (extension). A `locked` result from the seam maps to the `locked`
 * error state. No `console.*` output is emitted, so nothing can leak key material.
 */
export function useStakeUnstakeUrStoa(
  options: UseStakeUnstakeUrStoaOptions = {},
): UseStakeUnstakeUrStoaResult {
  const wallet = useWallet();

  // Bridge the context op (which accepts an optional test-only core override) to
  // the public-params seam the hook uses — the hook never passes a core override.
  const contextStake = wallet.urstoaStake;
  const contextUnstake = wallet.urstoaUnstake;
  const defaultStake = useCallback<UrStoaOpSeam>(
    (p) => contextStake(p as ContextUrStoaStakeParams),
    [contextStake],
  );
  const defaultUnstake = useCallback<UrStoaOpSeam>(
    (p) => contextUnstake(p as ContextUrStoaStakeParams),
    [contextUnstake],
  );
  const stakeSeam = options.urstoaStake ?? defaultStake;
  const unstakeSeam = options.urstoaUnstake ?? defaultUnstake;

  const paymentKeyAddress =
    options.paymentKeyAddress !== undefined
      ? options.paymentKeyAddress
      : (wallet.activeAccount?.account ?? null);

  const refresh = options.refresh;

  const [state, setState] = useState<StakeUnstakeState>({ status: 'idle' });

  // The in-flight guard: a ref (not state) so two synchronous calls see the flag
  // the FIRST set, before the rendered disabled state catches up.
  const inFlightRef = useRef(false);

  // Suppress post-resolution setState after unmount (MV3 popup close mid-submit).
  // The in-flight submit is NOT aborted — only its UI write is dropped (RR#10).
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const safeSetState = useCallback((next: StakeUnstakeState) => {
    if (cancelledRef.current) return;
    setState(next);
  }, []);

  const reset = useCallback(() => {
    inFlightRef.current = false;
    safeSetState({ status: 'idle' });
  }, [safeSetState]);

  const run = useCallback(
    async (kind: StakeUnstakeKind, amount: string): Promise<void> => {
      // RR#6 double-submit guard: the ref flips synchronously, so a second call
      // fired in the same tick is a no-op and the seam is invoked once.
      if (inFlightRef.current) return;
      if (!isArmed(state.status)) return;
      inFlightRef.current = true;

      // RR#9: `building` is set synchronously BEFORE the first await so the guard
      // and progress engage immediately.
      safeSetState({ status: 'building' });

      const trimmed = amount.trim();
      if (!isUsableDecimal(trimmed) || Number(trimmed) <= 0) {
        inFlightRef.current = false;
        safeSetState({ status: 'error', reason: 'invalid-amount' });
        return;
      }

      // Resolve the floor-clamped + bounded amount BEFORE any seam call so a
      // refused amount NEVER builds a tx and can never be misread as `pending`.
      let submitAmount = trimmed;
      if (kind === 'stake') {
        // RR#6 upper bound: stake ≤ wallet balance (skip only when balance unknown).
        if (
          isUsableDecimal(options.walletBalance) &&
          amountExceeds(trimmed, options.walletBalance)
        ) {
          inFlightRef.current = false;
          safeSetState({ status: 'error', reason: 'insufficient-funds' });
          return;
        }
      } else {
        // RR#6 upper bound: unstake ≤ the user's own staked balance.
        if (
          isUsableDecimal(options.userStaked) &&
          amountExceeds(trimmed, options.userStaked)
        ) {
          inFlightRef.current = false;
          safeSetState({ status: 'error', reason: 'insufficient-funds' });
          return;
        }

        // REQ-21 / RR#3: clamp to the last-staker floor over the LIVE vault total.
        // A null/unknown vaultTotal (or userStaked) BLOCKS the unstake — the floor
        // is never lifted and nothing is coerced to 0 (the full-drain guard).
        const floor = maxUnstake(options.userStaked, options.vaultTotal);
        if (!floor.ok) {
          inFlightRef.current = false;
          safeSetState({ status: 'error', reason: 'vault-total-unknown' });
          return;
        }
        if (amountExceeds(trimmed, floor.max)) {
          submitAmount = floor.max;
        }
      }

      // XP-12: a missing active account means there is no payment key / no unlocked
      // wallet to act for — locked WITHOUT a seam call.
      if (paymentKeyAddress === null) {
        inFlightRef.current = false;
        safeSetState({ status: 'error', reason: 'locked' });
        return;
      }

      // Format to UrStoa's 3-decimal Pact scale via the SDK formatter (never a raw
      // string, never a hand-rolled trim — T12.1 owns the decimal math).
      let formattedAmount: string;
      try {
        formattedAmount = String(formatUrStoaAmount(submitAmount));
      } catch {
        inFlightRef.current = false;
        safeSetState({ status: 'error', reason: 'invalid-amount' });
        return;
      }

      // XP-12: hand the context seam PUBLIC params only. It resolves the keypair
      // locally or routes the op to the background — the hook never sees a key.
      const seam = kind === 'stake' ? stakeSeam : unstakeSeam;

      let result: ContextUrStoaResult;
      try {
        safeSetState({ status: 'submitting' });
        result = await seam({ paymentKeyAddress, amount: formattedAmount });
      } catch {
        // A THROWN op (dispatched, then the network died) is genuinely ambiguous —
        // the tx may be on-chain. Land on `pending`, NOT idle, so the UI can never
        // auto-resubmit and double-spend. The error value is not surfaced.
        inFlightRef.current = false;
        safeSetState({ status: 'pending' });
        return;
      }

      inFlightRef.current = false;

      if (result.ok) {
        safeSetState({ status: 'success', requestKey: result.requestKey });
        refresh?.();
        return;
      }

      // A clean DISCRIMINATED {ok:false} maps to a distinct error reason — never
      // success, never pending (no tx ambiguity: the op reported a definite failure
      // / a locked seam). `locked` surfaces as the hook's locked error.
      safeSetState({ status: 'error', reason: result.reason, detail: result.detail });
    },
    [
      state.status,
      safeSetState,
      options.walletBalance,
      options.userStaked,
      options.vaultTotal,
      paymentKeyAddress,
      stakeSeam,
      unstakeSeam,
      refresh,
    ],
  );

  const stake = useCallback(
    (params: { amount: string }): Promise<void> => run('stake', params.amount),
    [run],
  );
  const unstake = useCallback(
    (params: { amount: string }): Promise<void> => run('unstake', params.amount),
    [run],
  );

  return { state, stake, unstake, reset };
}
