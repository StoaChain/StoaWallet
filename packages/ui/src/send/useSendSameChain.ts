import {
  getGaslessGating,
  type GaslessGating,
  type GaslessResultArtifact,
} from '@stoawallet/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useWallet,
  type ContextSendParams,
  type ContextSendResult,
} from '../context/WalletContext';

/**
 * Staged state machine for a same-chain send.
 *
 * `building` is set SYNCHRONOUSLY on `confirm()` entry (before the first await
 * over keypair re-derivation) so the double-submit guard and progress UI engage
 * immediately. `preview` is the explicit-confirm checkpoint: `send()` lands here
 * and submit does NOT run until `confirm()`. The core op is atomic
 * (simulate+submit in one call) so the hook cannot observe that boundary: it
 * exposes ONE honest in-flight stage (`sending`) covering the whole core op
 * rather than advertising a `submitting` stage it can never actually reach.
 *
 * `pending` is reserved EXCLUSIVELY for the genuinely ambiguous case: the core
 * op THREW/timed out after being dispatched (the tx may be on-chain), so the
 * hook lands on `pending` rather than a re-armed idle to make an auto-resubmit /
 * double-spend impossible. A clean DISCRIMINATED `{ok:false}` core result — and
 * every pre-flight rejection (invalid-amount, insufficient-funds) — maps to an
 * `error` state with that reason, NEVER `pending`: no tx was ever built.
 */
export type SendState =
  | { readonly status: 'idle' }
  | { readonly status: 'preview' }
  | { readonly status: 'building' }
  | { readonly status: 'sending' }
  | { readonly status: 'success'; readonly requestKey: string }
  | {
      readonly status: 'error';
      readonly reason: string;
      readonly detail?: string;
      readonly selfPaidFallbackPossible?: boolean;
    }
  | { readonly status: 'pending'; readonly requestKey?: string };

/** The resolved preview a user reviews before the explicit confirm. */
export interface SendPreview {
  readonly recipient: string;
  readonly amount: string;
  readonly chainId: string;
  /** Hint only; core re-resolves new-account existence authoritatively. */
  readonly isNewAccount?: boolean;
}

export interface UseSendSameChainOptions {
  /**
   * The context send op (resolves sender + keypair SET INSIDE the context and
   * calls core). Defaults to `useWallet().sendSameChain` so the hook never holds
   * key material (XP-12). Tests inject a stub.
   */
  readonly sendSameChain?: (
    params: ContextSendParams,
  ) => Promise<ContextSendResult>;
  /**
   * Per-chain gasless gating source: either a pre-built gating fn or the parsed
   * `gasless-result.json` artifact (the hook never calls the node-only loader).
   */
  readonly gasless?:
    | GaslessResultArtifact
    | ((chainId: string) => GaslessGating);
  /** The selected chain whose gating label the form renders. */
  readonly chainId?: string;
  /** Called once on a successful submit so the caller refreshes balances. */
  readonly onSuccess?: () => void;
  /**
   * Available spendable balance for a chain, as a decimal STRING (or null when
   * unknown — e.g. a chain still loading or errored). Injected by the form which
   * composes `useBalances`; supplied so the hook can enforce the insufficient-
   * funds pre-flight (RR#3) WITHOUT itself reading balances. When it returns null
   * the amount-format checks still run, but the over-balance check is skipped
   * (we never block a send on a balance we could not read).
   */
  readonly getAvailableBalance?: (chainId: string) => string | null;
}

export interface UseSendSameChainResult {
  readonly state: SendState;
  /** The resolved preview once `send()` has run, else null. */
  readonly preview: SendPreview | null;
  /** Gating verdict for the selected chain ('verified' | 'simulate-only'). */
  readonly gating: GaslessGating;
  /** Resolve a preview for review. Does NOT sign/submit. */
  send(params: SendParams): Promise<void>;
  /** Execute sign+submit on the pending preview after explicit review. */
  confirm(): Promise<void>;
  /** Reset back to idle (e.g. cancel the preview). */
  reset(): void;
}

export interface SendParams {
  readonly recipient: string;
  readonly amount: string;
  readonly chainId: string;
  /** Hint passed through to the preview; core re-resolves the real value. */
  readonly isNewAccount?: boolean;
}

/** Statuses from which a new send/confirm may start. */
function isArmed(status: SendState['status']): boolean {
  return status === 'idle' || status === 'error' || status === 'success';
}

/** Max on-chain fractional precision for a Stoa coin amount. */
const MAX_FRACTION_DIGITS = 12;
/** A plain non-negative decimal: integer part, optional dot + fraction. */
const DECIMAL_RE = /^\d+(\.\d+)?$/;

/**
 * Reject an amount that is empty, NaN, ≤ 0, not a plain decimal, or carries
 * more than 12 fractional digits — BEFORE any context/core call. Mirrors core's
 * `formatStoaAmount` contract so the hook fails fast (and never calls core) on a
 * malformed amount instead of relying on a thrown core validation.
 */
function isValidAmount(amount: string): boolean {
  const trimmed = amount.trim();
  if (trimmed === '' || !DECIMAL_RE.test(trimmed)) return false;
  const dot = trimmed.indexOf('.');
  const fraction = dot === -1 ? '' : trimmed.slice(dot + 1);
  if (fraction.length > MAX_FRACTION_DIGITS) return false;
  // ≤ 0 (including "0", "0.0", "0.000") is not a transfer.
  return Number(trimmed) > 0;
}

/**
 * Compare two well-formed non-negative decimal STRINGS without floating-point
 * drift: returns true when `amount > available`. Both are padded to a common
 * fractional width and compared as big integers, so 12-decimal precision is
 * exact (a float compare would mis-rank values near the 12th decimal).
 */
function amountExceedsBalance(amount: string, available: string): boolean {
  const norm = (v: string): [string, string] => {
    const t = v.trim();
    const dot = t.indexOf('.');
    return dot === -1 ? [t, ''] : [t.slice(0, dot), t.slice(dot + 1)];
  };
  const [aInt, aFracRaw] = norm(amount);
  const [bInt, bFracRaw] = norm(available);
  const width = Math.max(aFracRaw.length, bFracRaw.length);
  const a = `${aInt}${aFracRaw.padEnd(width, '0')}`.replace(/^0+(?=\d)/, '');
  const b = `${bInt}${bFracRaw.padEnd(width, '0')}`.replace(/^0+(?=\d)/, '');
  if (a.length !== b.length) return a.length > b.length;
  return a > b;
}

/**
 * State hook wrapping the context same-chain send op with the staged state
 * machine, the explicit preview→confirm gate, the in-hook double-submit guard,
 * the lost-response `pending` landing, gasless gating, and the on-success
 * refresh trigger.
 *
 * The hook NEVER touches key material: it calls the context-provided send op,
 * which resolves and consumes the keypair SET internally (XP-12). No console
 * output is emitted, so nothing can leak a mnemonic/password/keypair.
 */
export function useSendSameChain(
  options: UseSendSameChainOptions = {},
): UseSendSameChainResult {
  const wallet = useWallet();
  const sendOp = options.sendSameChain ?? wallet.sendSameChain;

  const [state, setState] = useState<SendState>({ status: 'idle' });
  const [preview, setPreview] = useState<SendPreview | null>(null);

  // Cancellation idiom (deliberately NOT the useBalances nonce/identity guard):
  // a send is a SINGLE-SHOT action with no re-fired identity to supersede, so
  // there is no "latest request wins" race to arbitrate — only "did the
  // component unmount mid-flight?" (MV3 popup close) and "is a submit already
  // in flight?". Hence a plain unmount `cancelledRef` (drop the post-resolution
  // UI write) plus an `inFlightRef` (collapse a double-confirm), NOT a monotonic
  // nonce. Future single-shot actions (Phase 11/12) should copy THIS idiom; the
  // nonce guard belongs only to re-fireable reads like balances.

  // The in-flight guard: a ref (not state) so two synchronous confirm() calls
  // see the flag the FIRST set, before the rendered disabled state catches up.
  const inFlightRef = useRef(false);
  // The preview a pending confirm() will submit, captured at send() time.
  const previewRef = useRef<SendPreview | null>(null);

  // Suppress post-resolution setState after unmount (MV3 popup close mid-send).
  // The in-flight submit is NOT aborted — only its UI write is dropped.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const safeSetState = useCallback((next: SendState) => {
    if (cancelledRef.current) return;
    setState(next);
  }, []);

  const gatingFn = useMemo(() => {
    const g = options.gasless;
    if (typeof g === 'function') return g;
    return getGaslessGating(g);
  }, [options.gasless]);

  const gating = useMemo(
    () => gatingFn(options.chainId ?? ''),
    [gatingFn, options.chainId],
  );

  const reset = useCallback(() => {
    inFlightRef.current = false;
    previewRef.current = null;
    setPreview(null);
    safeSetState({ status: 'idle' });
  }, [safeSetState]);

  const send = useCallback(
    async (params: SendParams): Promise<void> => {
      // Only start a preview from an armed state — never interrupt an in-flight
      // submit or an existing preview.
      if (inFlightRef.current) return;
      if (!isArmed(state.status)) return;

      const next: SendPreview = {
        recipient: params.recipient,
        amount: params.amount,
        chainId: params.chainId,
        isNewAccount: params.isNewAccount,
      };
      previewRef.current = next;
      setPreview(next);
      safeSetState({ status: 'preview' });
    },
    [state.status, safeSetState],
  );

  const confirm = useCallback(async (): Promise<void> => {
    const current = previewRef.current;
    if (current === null) return;

    // RR#6 double-submit guard: the ref flips synchronously, so a second
    // confirm() fired in the same tick is a no-op and core is called once.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    // Consume the preview so a confirm() AFTER a terminal landing (success /
    // error / pending) finds nothing to submit — a fresh send() must re-arm.
    previewRef.current = null;

    // RR#3 amount + insufficient-funds pre-flight: validate BEFORE any context/
    // core call so a malformed or over-balance amount NEVER builds a tx and can
    // never be misread as an ambiguous `pending`. The over-balance check runs
    // only when a balance is known (null ⇒ unreadable ⇒ skip, never block).
    if (!isValidAmount(current.amount)) {
      inFlightRef.current = false;
      safeSetState({ status: 'error', reason: 'invalid-amount' });
      return;
    }
    const available = options.getAvailableBalance?.(current.chainId) ?? null;
    if (available !== null && amountExceedsBalance(current.amount, available)) {
      inFlightRef.current = false;
      safeSetState({ status: 'error', reason: 'insufficient-funds' });
      return;
    }

    // RR#9: `building` is set synchronously BEFORE the first await so the guard
    // and progress engage immediately, covering keypair re-derivation.
    safeSetState({ status: 'building' });

    let result: ContextSendResult;
    try {
      // The core op is atomic (simulate+submit in one call); the hook cannot
      // observe the boundary, so it shows ONE honest in-flight stage rather than
      // a `submitting` stage that would lie about progress.
      safeSetState({ status: 'sending' });
      result = await sendOp({
        recipient: current.recipient,
        amount: current.amount,
        chainId: current.chainId,
      });
    } catch {
      // A THROWN rejection (the op was dispatched, then the network died) is
      // genuinely ambiguous — the tx may be on-chain. Land on `pending`, NOT
      // idle, so the UI can never auto-resubmit and double-spend. A clean
      // DISCRIMINATED {ok:false} core result is handled below and maps to an
      // `error` reason, NEVER here. The error value is not surfaced (it could
      // carry transport detail); only the ambiguity is.
      inFlightRef.current = false;
      safeSetState({ status: 'pending' });
      return;
    }

    inFlightRef.current = false;

    if (result.ok) {
      safeSetState({ status: 'success', requestKey: result.requestKey });
      options.onSuccess?.();
      return;
    }

    // Every non-ok core/context reason is surfaced as a distinct error state —
    // gas-payer-rejected carries its self-paid fallback hint; locked is routed
    // as its own reason; success is NEVER reported for a failure.
    const errorState: SendState =
      result.reason === 'gas-payer-rejected'
        ? {
            status: 'error',
            reason: 'gas-payer-rejected',
            detail: result.detail,
            selfPaidFallbackPossible: result.selfPaidFallbackPossible,
          }
        : 'detail' in result
          ? { status: 'error', reason: result.reason, detail: result.detail }
          : { status: 'error', reason: result.reason };
    safeSetState(errorState);
  }, [sendOp, options, safeSetState]);

  return { state, preview, gating, send, confirm, reset };
}
