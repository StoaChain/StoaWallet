import { useCallback, useEffect, useRef, useState } from 'react';

import {
  useWallet,
  type ContextUrStoaResult,
  type ContextUrStoaTransferParams,
} from '../context/WalletContext';

import { formatUrStoaAmount, URSTOA_DECIMALS } from './amount';

/**
 * The WalletContext native-transfer seam signature (XP-12). The hook passes PUBLIC
 * params ONLY — the sender + receiver addresses and a pre-formatted decimal amount;
 * the context resolves the keypair locally (mobile/web) or routes the whole op to
 * the background (extension). No keypair ever crosses from the hook.
 */
export type TransferUrStoaSeam = (params: {
  readonly senderAddress: string;
  readonly receiverAddress: string;
  readonly amount: string;
}) => Promise<ContextUrStoaResult>;

/**
 * Staged state machine for a native UrStoa transfer (chain 0, no chain selector).
 *
 * `send()` validates the recipient + amount and lands on `preview` — the explicit
 * RR#5 confirm checkpoint. Submit does NOT run until `confirm()`. On `confirm()`,
 * `building` is set SYNCHRONOUSLY (RR#9) before the first await over the signing
 * seam, then `submitting` covers the atomic op.
 *
 * `pending` is reserved EXCLUSIVELY for the genuinely ambiguous case: the op
 * THREW/timed out after being dispatched (the tx may be on-chain), so the hook
 * lands on `pending` rather than a re-armed idle to make an auto-resubmit /
 * double-spend impossible (RR#6). A clean DISCRIMINATED `{ok:false}` result —
 * and every pre-flight rejection (invalid-recipient, insufficient-funds, locked) —
 * maps to an `error` with that reason, NEVER `pending`: no tx was ever built.
 */
export type TransferState =
  | { readonly status: 'idle' }
  | { readonly status: 'preview' }
  | { readonly status: 'building' }
  | { readonly status: 'submitting' }
  | { readonly status: 'success'; readonly requestKey: string }
  | { readonly status: 'error'; readonly reason: string; readonly detail?: string }
  | { readonly status: 'pending'; readonly requestKey?: string };

/** The resolved preview a user reviews before the explicit confirm. */
export interface TransferPreview {
  readonly recipient: string;
  readonly amount: string;
}

export interface TransferParams {
  readonly recipient: string;
  readonly amount: string;
}

export interface UseTransferUrStoaOptions {
  /**
   * The active `k:` account funding the transfer (sender === payment key). When
   * omitted the hook reads it from `useWallet().activeAccount`. `null` is the
   * explicit locked/no-active-account signal (no seam call is made).
   */
  readonly senderAddress?: string | null;
  /**
   * The native-transfer seam. Defaults to the WalletContext `urstoaTransfer` op
   * (local-vs-remote handled inside). Tests inject a stub.
   */
  readonly urstoaTransfer?: TransferUrStoaSeam;
  /**
   * Available spendable UrStoa balance (the T12.6 `walletBalance`), as a decimal
   * STRING or null when unknown. Used for the insufficient-funds pre-flight; a
   * null balance skips the over-balance check (never block a send on an unread
   * balance).
   */
  readonly walletBalance?: string | null;
  /** Fired once on a successful transfer so T12.6 holdings re-read (RR on success). */
  readonly refresh?: () => void;
}

export interface UseTransferUrStoaResult {
  readonly state: TransferState;
  /** The resolved preview once `send()` has run, else null. */
  readonly preview: TransferPreview | null;
  /** Validate + resolve a preview for review. Does NOT sign/submit (RR#5). */
  send(params: TransferParams): Promise<void>;
  /** Execute sign+submit on the pending preview after explicit review. */
  confirm(): Promise<void>;
  /** Reset back to idle (e.g. cancel the preview). */
  reset(): void;
}

/** A k:-account is the `k:` prefix + exactly 64 hex chars (ED25519 pubkey). */
const K_ACCOUNT_RE = /^k:[0-9a-fA-F]{64}$/;
/** Max on-chain UrStoa fractional precision — UrStoa is a 3-decimal token. */
const MAX_FRACTION_DIGITS = URSTOA_DECIMALS;
/** A plain non-negative decimal: integer part, optional dot + fraction. */
const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Statuses from which a new send/confirm may start. */
function isArmed(status: TransferState['status']): boolean {
  return status === 'idle' || status === 'error' || status === 'success';
}

/**
 * Reject an amount that is empty, NaN, ≤ 0, not a plain decimal, or carries more
 * than UrStoa's 3 fractional digits — BEFORE any seam call, so a malformed amount
 * never builds a tx. Mirrors the T12.1 formatter contract for fast-fail UX.
 */
function isValidAmount(amount: string): boolean {
  const trimmed = amount.trim();
  if (trimmed === '' || !DECIMAL_RE.test(trimmed)) return false;
  const dot = trimmed.indexOf('.');
  const fraction = dot === -1 ? '' : trimmed.slice(dot + 1);
  if (fraction.length > MAX_FRACTION_DIGITS) return false;
  return Number(trimmed) > 0;
}

/**
 * Compare two well-formed non-negative decimal STRINGS as big integers (no float
 * drift): returns true when `amount > available`. String-exact at any precision —
 * a float compare would mis-rank values near the least-significant decimal.
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
 * State hook wrapping the WalletContext native-transfer seam (XP-12) with the
 * staged state machine, recipient + amount validation (fast-UX mirror of the core
 * classifier), the explicit RR#5 preview→confirm gate, the in-hook RR#6
 * double-submit guard, the lost-response `pending` landing, and the on-success
 * T12.6 `refresh()`.
 *
 * SECURITY (XP-12): the hook NEVER touches a keypair. It passes the active account
 * ADDRESS (sender === payment key, PAT-004) + the recipient + amount to the
 * context seam, which resolves the keypair LOCALLY (mobile/web) or routes the
 * whole op to the BACKGROUND (extension). A `locked` result (no active account, or
 * a seam-side lock) maps to the locked error state. No `console.*` output is
 * emitted, so nothing can leak a keypair/recipient/amount.
 */
export function useTransferUrStoa(
  options: UseTransferUrStoaOptions = {},
): UseTransferUrStoaResult {
  const wallet = useWallet();

  const senderAddress =
    options.senderAddress !== undefined
      ? options.senderAddress
      : (wallet.activeAccount?.account ?? null);

  // Bridge the context op (which accepts an optional test-only core override) to
  // the public-params seam the hook uses — the hook never passes a core override.
  const contextTransfer = wallet.urstoaTransfer;
  const defaultTransfer = useCallback<TransferUrStoaSeam>(
    (p) => contextTransfer(p as ContextUrStoaTransferParams),
    [contextTransfer],
  );
  const transferSeam = options.urstoaTransfer ?? defaultTransfer;

  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [preview, setPreview] = useState<TransferPreview | null>(null);

  // The in-flight guard: a ref (not state) so two synchronous confirm() calls see
  // the flag the FIRST set, before the rendered disabled state catches up (RR#6).
  const inFlightRef = useRef(false);
  // The preview a pending confirm() will submit, captured at send() time.
  const previewRef = useRef<TransferPreview | null>(null);
  // The sender captured at send() time, used by confirm().
  const senderRef = useRef<string | null>(null);

  // Suppress post-resolution setState after unmount (MV3 popup close mid-send).
  // The in-flight submit is NOT aborted — only its UI write is dropped (RR#10).
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const safeSetState = useCallback((next: TransferState) => {
    if (cancelledRef.current) return;
    setState(next);
  }, []);

  const reset = useCallback(() => {
    inFlightRef.current = false;
    previewRef.current = null;
    senderRef.current = null;
    setPreview(null);
    safeSetState({ status: 'idle' });
  }, [safeSetState]);

  const send = useCallback(
    async (params: TransferParams): Promise<void> => {
      // Only start a preview from an armed state — never interrupt an in-flight
      // submit or an existing preview.
      if (inFlightRef.current) return;
      if (!isArmed(state.status)) return;

      const recipient = params.recipient.trim();

      // RECIPIENT validation (fast-UX mirror of the T12.5 core classifier; the
      // authoritative boundary is core). Reject non-k:/malformed.
      if (!K_ACCOUNT_RE.test(recipient)) {
        senderRef.current = null;
        previewRef.current = null;
        setPreview(null);
        safeSetState({ status: 'error', reason: 'invalid-recipient' });
        return;
      }

      // A locked wallet / no active account surfaces locked WITHOUT a preview.
      if (senderAddress === null) {
        senderRef.current = null;
        previewRef.current = null;
        setPreview(null);
        safeSetState({ status: 'error', reason: 'locked' });
        return;
      }

      if (recipient === senderAddress) {
        senderRef.current = null;
        previewRef.current = null;
        setPreview(null);
        safeSetState({ status: 'error', reason: 'invalid-recipient' });
        return;
      }

      // AMOUNT validation + insufficient-funds (the T12.6 walletBalance is the
      // available spendable balance). Both run BEFORE any preview/submit.
      if (!isValidAmount(params.amount)) {
        safeSetState({ status: 'error', reason: 'invalid-amount' });
        return;
      }
      const available = options.walletBalance ?? null;
      if (available !== null && amountExceedsBalance(params.amount, available)) {
        safeSetState({ status: 'error', reason: 'insufficient-funds' });
        return;
      }

      const next: TransferPreview = {
        recipient,
        amount: params.amount,
      };
      senderRef.current = senderAddress;
      previewRef.current = next;
      setPreview(next);
      safeSetState({ status: 'preview' });
    },
    [state.status, senderAddress, options.walletBalance, safeSetState],
  );

  const confirm = useCallback(async (): Promise<void> => {
    const current = previewRef.current;
    if (current === null) return;

    // RR#6 double-submit guard: the ref flips synchronously, so a second
    // confirm() in the same tick is a no-op and the seam is called once.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    // Consume the preview so a confirm() AFTER a terminal landing (success /
    // error / pending) finds nothing to submit — a fresh send() must re-arm.
    previewRef.current = null;

    // RR#9: `building` is set synchronously BEFORE the first await so the guard
    // and progress engage immediately.
    safeSetState({ status: 'building' });

    // Re-resolve the sender at confirm time so a wallet that locked between the
    // preview and the confirm surfaces `locked` and the seam is never called.
    const sender = senderAddress ?? senderRef.current;
    if (sender === null) {
      inFlightRef.current = false;
      safeSetState({ status: 'error', reason: 'locked' });
      return;
    }

    // T12.1: format the STRING amount to the injection-safe 3-decimal Pact literal
    // (UrStoa's on-chain scale) — no Number round-trip (RR#4). A throw here is a
    // malformed amount the preview already screened, mapped to error.
    let formatted: string;
    try {
      formatted = formatUrStoaAmount(current.amount);
    } catch {
      inFlightRef.current = false;
      safeSetState({ status: 'error', reason: 'invalid-amount' });
      return;
    }

    let result: ContextUrStoaResult;
    try {
      safeSetState({ status: 'submitting' });
      // XP-12: hand the context seam PUBLIC params only. It resolves the keypair
      // locally or routes the whole op to the background — the hook never sees a key.
      result = await transferSeam({
        senderAddress: sender,
        receiverAddress: current.recipient,
        amount: formatted,
      });
    } catch {
      // A THROWN rejection (the op was dispatched, then the network died) is
      // genuinely ambiguous — the tx may be on-chain. Land on `pending`, NOT
      // idle, so the UI can never auto-resubmit and double-spend.
      inFlightRef.current = false;
      safeSetState({ status: 'pending' });
      return;
    }

    inFlightRef.current = false;

    if (result.ok) {
      safeSetState({ status: 'success', requestKey: result.requestKey });
      options.refresh?.();
      return;
    }

    // A clean discriminated failure is a distinct error reason — never success,
    // never the ambiguous pending. A `locked` seam surfaces as the locked error.
    safeSetState({ status: 'error', reason: result.reason, detail: result.detail });
  }, [senderAddress, transferSeam, options, safeSetState]);

  return { state, preview, send, confirm, reset };
}
