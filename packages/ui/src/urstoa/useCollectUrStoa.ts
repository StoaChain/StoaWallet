import { useCallback, useEffect, useRef, useState } from 'react';

import {
  useWallet,
  type ContextUrStoaCollectParams,
  type ContextUrStoaResult,
} from '../context/WalletContext';
import { unwrapDecimal } from './amount';

/**
 * Staged state machine for an UrStoa Collect (chain 0, gasless).
 *
 * `building` is set SYNCHRONOUSLY on `collect()` entry (before the first await
 * over the signing seam) so the double-submit guard and progress UI engage
 * immediately. `submitting` covers the Collect op (build+sign+submit in one call).
 * A clean DISCRIMINATED `{ok:false}` result maps to an `error` state carrying its
 * reason+detail — a tx was definitively NOT accepted, so it is never `pending`. A
 * THROWN op (dispatched, then the network died) is genuinely ambiguous (the
 * Collect may be on-chain), so it lands on `pending` rather than a re-armed idle
 * to make an auto-resubmit / double-collect impossible.
 */
export type CollectState =
  | { readonly status: 'idle' }
  | { readonly status: 'building' }
  | { readonly status: 'submitting' }
  | { readonly status: 'success'; readonly requestKey: string }
  | { readonly status: 'error'; readonly reason: string; readonly detail?: string }
  | { readonly status: 'pending' };

/**
 * The WalletContext collect seam signature (XP-12). The hook passes the PUBLIC
 * payment-key ADDRESS only; the context resolves the keypair locally (mobile/web)
 * or routes the whole op to the background (extension). No keypair crosses.
 */
export type CollectUrStoaSeam = (params: {
  readonly paymentKeyAddress: string;
}) => Promise<ContextUrStoaResult>;

export interface UseCollectUrStoaOptions {
  /**
   * The active `k:` payment key the Collect credits. When omitted the hook
   * resolves it from `useWallet().activeAccount`. `null` is the explicit
   * idle/locked signal (no active account).
   */
  readonly account?: string | null;
  /**
   * The vault's accrued earnings as the RAW read value from the holdings hook
   * (`vaultEarnings`) — a Pact `{ decimal }` envelope, a plain number, a string,
   * or `null` when unknown. The Collect gate UNWRAPS this via the T12.1
   * `unwrapDecimal` and compares NUMERICALLY `> 0`; it MUST NOT `String()` the
   * envelope (which yields the truthy garbage `"[object Object]"`).
   */
  readonly earnings?: unknown;
  /**
   * The collect seam. Defaults to the WalletContext `urstoaCollect` op
   * (local-vs-remote handled inside). Tests inject a stub.
   */
  readonly urstoaCollect?: CollectUrStoaSeam;
  /** Fired once on a successful Collect so the caller re-reads holdings. */
  readonly refresh?: () => void;
}

export interface UseCollectUrStoaResult {
  readonly state: CollectState;
  /**
   * True when there are non-zero earnings to collect — the view binds the Collect
   * button's enabled state to this. Driven by the T12.1 `{decimal}`-unwrap + a
   * numeric `> 0`, NEVER a truthiness check on the raw envelope.
   */
  readonly canCollect: boolean;
  /** Submit the Collect. No-op when earnings are zero, locked, or a submit is in flight. */
  collect(): Promise<void>;
}

/** Statuses from which a fresh `collect()` may start. */
function isArmed(status: CollectState['status']): boolean {
  return status === 'idle' || status === 'error' || status === 'success';
}

/**
 * Decide whether there are earnings to collect.
 *
 * COLLECT-DISABLED GUARD (RR#7): unwrap the raw `{ decimal }` earnings via the
 * T12.1 `unwrapDecimal` (the SAME `mayComeWithDeimal` path the hover figure uses)
 * and compare NUMERICALLY `> 0`. This deliberately AVOIDS `String(earnings)` —
 * which would stringify `{ decimal: "0" }` to the truthy `"[object Object]"` and
 * mis-enable Collect — and AVOIDS a plain truthiness check, under which the string
 * `"0"` is truthy and would wrongly enable a zero-earnings Collect. A `NaN`
 * (unparseable) earnings reads as not-positive, so the gate fails closed.
 */
function hasEarnings(earnings: unknown): boolean {
  if (earnings === null || earnings === undefined) return false;
  const value = Number(unwrapDecimal(earnings));
  return Number.isFinite(value) && value > 0;
}

/**
 * State hook wrapping the WalletContext Collect seam (XP-12) with the staged state
 * machine, the non-zero-earnings gate, the in-hook double-submit guard, the
 * lost-response `pending` landing, and the on-success holdings refresh.
 *
 * SECURITY (XP-12): the hook NEVER touches a keypair. It passes the active payment
 * key ADDRESS to the context seam, which resolves the keypair LOCALLY (mobile/web)
 * or routes the whole op to the BACKGROUND (extension). A `locked` seam result
 * maps to the locked error state. No `console.*` output is emitted, so nothing can
 * leak key material.
 */
export function useCollectUrStoa(
  options: UseCollectUrStoaOptions = {},
): UseCollectUrStoaResult {
  const wallet = useWallet();

  const account =
    options.account !== undefined
      ? options.account
      : (wallet.activeAccount?.account ?? null);

  const refresh = options.refresh;

  // Bridge the context op (which accepts an optional test-only core override) to
  // the public-params seam the hook uses — the hook never passes a core override.
  const contextCollect = wallet.urstoaCollect;
  const defaultCollect = useCallback<CollectUrStoaSeam>(
    (p) => contextCollect(p as ContextUrStoaCollectParams),
    [contextCollect],
  );
  const collectSeam = options.urstoaCollect ?? defaultCollect;

  const [state, setState] = useState<CollectState>({ status: 'idle' });

  // The in-flight guard: a ref (not state) so two synchronous collect() calls see
  // the flag the FIRST set, before the rendered disabled state catches up.
  const inFlightRef = useRef(false);

  // Suppress post-resolution setState after unmount (MV3 popup close mid-collect).
  // The in-flight submit is NOT aborted — only its UI write is dropped.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const safeSetState = useCallback((next: CollectState) => {
    if (cancelledRef.current) return;
    setState(next);
  }, []);

  const canCollect = hasEarnings(options.earnings);

  const collect = useCallback(async (): Promise<void> => {
    // The earnings gate: a zero/unknown-earnings collect() is a no-op — the seam
    // is never called and no success is fabricated.
    if (!canCollect) return;

    // RR#6 double-submit guard: the ref flips synchronously, so a second collect()
    // fired in the same tick is a no-op and the seam is called once.
    if (inFlightRef.current) return;
    if (!isArmed(state.status)) return;
    if (account === null) {
      // No active account ⇒ no payment key / no unlocked wallet to act for.
      safeSetState({ status: 'error', reason: 'locked' });
      return;
    }
    inFlightRef.current = true;

    // `building` is set synchronously BEFORE the first await so the guard and
    // progress engage immediately.
    safeSetState({ status: 'building' });

    let result: ContextUrStoaResult;
    try {
      safeSetState({ status: 'submitting' });
      // XP-12: hand the context seam the PUBLIC payment key only — it resolves the
      // keypair locally or routes the op to the background.
      result = await collectSeam({ paymentKeyAddress: account });
    } catch {
      // A THROWN op (dispatched, then the network died) is ambiguous — the
      // Collect may be on-chain. Land on `pending`, NOT idle, so the UI can never
      // auto-resubmit and double-collect. The error value is not surfaced.
      inFlightRef.current = false;
      safeSetState({ status: 'pending' });
      return;
    }

    inFlightRef.current = false;

    if (result.ok) {
      safeSetState({ status: 'success', requestKey: result.requestKey });
      // The collected earnings now sit in the coin balance — re-read holdings.
      refresh?.();
      return;
    }

    // A clean discriminated failure maps to an error carrying the reason + detail;
    // no tx was accepted, so this is NEVER `pending`. A `locked` seam surfaces as
    // the hook's locked error.
    safeSetState({ status: 'error', reason: result.reason, detail: result.detail });
  }, [canCollect, state.status, account, collectSeam, refresh, safeSetState]);

  return { state, canCollect, collect };
}
