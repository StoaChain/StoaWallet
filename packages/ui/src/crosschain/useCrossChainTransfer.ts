import {
  CROSSCHAIN_INFLIGHT_KEY,
  pollProofAndContinue as corePollProofAndContinue,
  type PollProofAndContinueOptions,
  type PollProofAndContinueParams,
  type PollProofAndContinueResult,
  type StorageAdapter,
  type StoredBlob,
} from '@stoawallet/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  useWallet,
  type ContextCrossChainParams,
  type ContextCrossChainStep0Result,
} from '../context/WalletContext';

export type { ContextCrossChainStep0Result } from '../context/WalletContext';

/**
 * Staged state machine for a cross-chain transfer (Step-0 burn → SPV proof →
 * Step-1 continuation mint).
 *
 * HONEST STAGING (PAT-001/PAT-002): the hook exposes ONLY the stages the code can
 * actually reach. `building` is set SYNCHRONOUSLY on `transfer()` entry (before
 * the first await over keypair re-derivation) so the double-submit guard and
 * progress UI engage immediately; `submitting` is the SINGLE in-flight stage for
 * the atomic step-0 leg (build/sign/submit/confirm happen inside one core call
 * the hook can't sub-observe); `waiting-spv` carries the live `spvAttempt`/
 * `spvMaxAttempts` the poll's `onProgress` emits so the UI can render the ~120s
 * block-finality wait. There are NO `confirming`/`completing` stages — the core
 * ops are atomic, so advertising them would claim a boundary the hook can never
 * render (the same discipline `useContinuationResume` follows).
 *
 * `pending` is reserved EXCLUSIVELY for the genuinely ambiguous cases where a tx
 * MAY be on chain but its confirmation was lost — `network-lost-pending` (the
 * step-0 burn), and `spv-timeout` / `continuation-pending` (the continuation).
 * In ALL pending states the burn already committed (or may have), so the hook
 * NEVER re-invokes core submit: it carries the request key for a later resume
 * and makes an auto-resubmit / double-burn impossible. Hard failures
 * (`submit-failed`, `step0-failed`, `continuation-failed`, `locked`) map to
 * `error` — no tx landed, nothing to recover.
 */
export type CrossChainTransferState =
  | { readonly step: 'configure' }
  | { readonly step: 'building' }
  | { readonly step: 'submitting' }
  | {
      readonly step: 'waiting-spv';
      readonly requestKey: string;
      readonly spvAttempt: number;
      readonly spvMaxAttempts: number;
    }
  | { readonly step: 'done'; readonly continuationKey: string }
  | {
      readonly step: 'pending';
      readonly reason: string;
      readonly requestKey: string;
    }
  | { readonly step: 'error'; readonly reason: string; readonly detail?: string };

/** Params the user supplies for a cross-chain transfer; sender resolved inside. */
export interface CrossChainTransferParams {
  readonly receiver: string;
  readonly amount: string;
  readonly sourceChain: string;
  readonly targetChain: string;
}

/**
 * The durable in-flight record persisted under `CROSSCHAIN_INFLIGHT_KEY` the
 * instant a step-0 request key exists. It carries ONLY the non-secret fields a
 * recovery view needs to resume (the request key prefilled, the chain pair, the
 * amount) — never any key material.
 */
export interface PersistedInflightTransfer {
  readonly requestKey: string;
  readonly sourceChain: string;
  readonly targetChain: string;
  readonly amount: string;
  readonly step: string;
  readonly reason?: string;
}

export interface UseCrossChainTransferOptions {
  /**
   * The context step-0 op (resolves sender + keypair SET INSIDE the context and
   * calls core). Defaults to `useWallet().sendCrossChainStep0` so the hook never
   * holds key material (XP-12). Tests inject a stub.
   */
  readonly sendCrossChainStep0?: (
    params: ContextCrossChainParams,
  ) => Promise<ContextCrossChainStep0Result>;
  /** The SPV poll-and-continue op. Defaults to the real core orchestrator. */
  readonly pollProofAndContinue?: (
    params: PollProofAndContinueParams,
    deps?: undefined,
    options?: PollProofAndContinueOptions,
  ) => Promise<PollProofAndContinueResult>;
  /**
   * Durable at-rest storage for the in-flight record. Defaults to the context-
   * injected adapter so persistence uses the same backend as the vault. Tests
   * inject the in-memory double.
   */
  readonly storage?: StorageAdapter;
  /** Called once on a completed transfer so the caller refreshes balances. */
  readonly onSuccess?: () => void;
}

export interface UseCrossChainTransferResult {
  readonly state: CrossChainTransferState;
  /** Start a cross-chain transfer. No-op while a transfer is already in flight. */
  transfer(params: CrossChainTransferParams): Promise<void>;
  /** Reset back to the configure step (e.g. after an error / pending landing). */
  reset(): void;
}

/**
 * Steps from which a NEW transfer may start. `pending` is DELIBERATELY excluded:
 * a pending transfer carries an unconfirmed burn that must NEVER be re-burned by
 * a fresh transfer() — the user must explicitly `reset()` (acknowledging the
 * prior request key) before starting a new one.
 */
function isArmed(step: CrossChainTransferState['step']): boolean {
  return step === 'configure' || step === 'error' || step === 'done';
}

/** Decode a stored blob to a UTF-8 string regardless of the backend's representation. */
function blobToString(raw: StoredBlob): string {
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

/**
 * State hook driving the cross-chain transfer state machine: it calls the
 * context step-0 seam, then the core SPV poll-and-continue, threading a durable
 * in-flight record through the injected storage so an MV3 popup close mid-poll
 * never strands funds. The hook NEVER touches key material — the context seam
 * resolves and consumes the keypair SET internally (XP-12). No console output is
 * emitted, so nothing can leak a mnemonic/password/keypair.
 */
export function useCrossChainTransfer(
  options: UseCrossChainTransferOptions = {},
): UseCrossChainTransferResult {
  const wallet = useWallet();
  const step0Op = options.sendCrossChainStep0 ?? wallet.sendCrossChainStep0;
  const pollOp = options.pollProofAndContinue ?? corePollProofAndContinue;
  const storage = options.storage ?? wallet.storage;
  const onSuccess = options.onSuccess;

  const [state, setState] = useState<CrossChainTransferState>({
    step: 'configure',
  });

  // The in-flight guard: a ref (not state) so two synchronous transfer() calls
  // see the flag the FIRST set, before the rendered disabled state catches up.
  const inFlightRef = useRef(false);

  // Suppress post-resolution setState after unmount (MV3 popup close mid-poll).
  // The signed submit is NOT abortable; only the poll loop is aborted and the
  // post-resolution UI write is dropped.
  const cancelledRef = useRef(false);
  // The poll's AbortController — the cleanup aborts the idempotent poll on
  // unmount. The submit leg is never threaded through this.
  const pollAbortRef = useRef<AbortController | null>(null);

  const safeSetState = useCallback((next: CrossChainTransferState) => {
    if (cancelledRef.current) return;
    setState(next);
  }, []);

  const persist = useCallback(
    async (record: PersistedInflightTransfer): Promise<void> => {
      await storage.set(CROSSCHAIN_INFLIGHT_KEY, JSON.stringify(record));
    },
    [storage],
  );

  const clearPersisted = useCallback(async (): Promise<void> => {
    await storage.remove(CROSSCHAIN_INFLIGHT_KEY);
  }, [storage]);

  // REHYDRATE on MOUNT: a transfer persisted by a prior hook instance (popup
  // closed mid-poll) is restored into a recoverable `pending` state carrying the
  // request key, so the recovery view is reachable with the key prefilled and
  // funds are never stranded. The poll is NOT auto-resumed — resume is explicit.
  useEffect(() => {
    cancelledRef.current = false;
    let active = true;
    void (async () => {
      const raw = await storage.get(CROSSCHAIN_INFLIGHT_KEY);
      if (!active || raw === null) return;
      // Only rehydrate over a still-fresh configure state — never clobber a live
      // transfer this instance already started.
      try {
        const record = JSON.parse(blobToString(raw)) as PersistedInflightTransfer;
        if (typeof record.requestKey !== 'string') return;
        setState((prev) =>
          prev.step === 'configure'
            ? {
                step: 'pending',
                reason: record.reason ?? 'spv-timeout',
                requestKey: record.requestKey,
              }
            : prev,
        );
      } catch {
        // A corrupt in-flight blob is ignored: a recovery view can still be
        // reached manually, and a malformed record must not crash the mount.
      }
    })();
    return () => {
      active = false;
      cancelledRef.current = true;
      // Abort the idempotent poll loop on unmount; the submit is never aborted.
      pollAbortRef.current?.abort();
    };
  }, [storage]);

  const reset = useCallback(() => {
    inFlightRef.current = false;
    safeSetState({ step: 'configure' });
    // The user acknowledged the prior request key by resetting — drop the durable
    // in-flight record so a dismissed/completed transfer never re-surfaces as
    // pending on the next mount. Guarded so reset() can never throw.
    void storage.remove(CROSSCHAIN_INFLIGHT_KEY).catch(() => {
      // A storage-remove failure is non-fatal: reset still returns to configure.
    });
  }, [safeSetState, storage]);

  const transfer = useCallback(
    async (params: CrossChainTransferParams): Promise<void> => {
      // RR#6 double-submit guard: the ref flips synchronously, so a second
      // transfer() fired in the same tick is a no-op and core is called once.
      // Guard on BOTH the ref and the rendered step so a mid-flight call lands.
      if (inFlightRef.current) return;
      if (!isArmed(state.step)) return;
      inFlightRef.current = true;

      // RR#9: `building` is set synchronously BEFORE the first await so the guard
      // and progress engage immediately, covering keypair re-derivation.
      safeSetState({ step: 'building' });

      let step0: ContextCrossChainStep0Result;
      try {
        safeSetState({ step: 'submitting' });
        step0 = await step0Op({
          receiver: params.receiver,
          amount: params.amount,
          sourceChain: params.sourceChain,
          targetChain: params.targetChain,
        });
      } catch {
        // A THROWN step-0 rejection is ambiguous — the burn may be on chain but
        // we hold no request key. Land on a generic error (not pending, which
        // requires a key to resume). The error value is not surfaced.
        inFlightRef.current = false;
        safeSetState({ step: 'error', reason: 'step0-failed' });
        return;
      }

      if (!step0.ok) {
        inFlightRef.current = false;
        // TIMEOUT=PENDING: a lost step-0 response carries a request key the user
        // can resume from — NEVER resubmit. Persist it durably so a popup close
        // does not strand it, then land on pending.
        if (step0.reason === 'network-lost-pending' && step0.requestKey) {
          await persist({
            requestKey: step0.requestKey,
            sourceChain: params.sourceChain,
            targetChain: params.targetChain,
            amount: params.amount,
            step: 'pending',
            reason: step0.reason,
          });
          safeSetState({
            step: 'pending',
            reason: step0.reason,
            requestKey: step0.requestKey,
          });
          return;
        }
        // Every other non-ok reason (locked / submit-failed / step0-failed /
        // build refusals) is a hard error: no tx landed, nothing to resume.
        const detail = 'detail' in step0 ? step0.detail : undefined;
        safeSetState(
          detail !== undefined
            ? { step: 'error', reason: step0.reason, detail }
            : { step: 'error', reason: step0.reason },
        );
        return;
      }

      // Step-0 committed: a request key now exists. Persist it durably the INSTANT
      // it is known (anti-fund-stranding) BEFORE the ~120s poll — a popup close
      // mid-poll must leave a rehydratable record, not a lost burn.
      const { requestKey, sourceChain, targetChain } = step0;
      try {
        await persist({
          requestKey,
          sourceChain,
          targetChain,
          amount: params.amount,
          step: 'waiting-spv',
        });
      } catch {
        // A storage WRITE failure must NOT strand the burn: the in-memory
        // requestKey is the last-resort recovery handle, so advance to waiting-spv
        // carrying it (the durable record is best-effort) rather than rejecting and
        // leaving the UI stuck in `submitting` with the key trapped. inFlightRef is
        // reset on the poll's resolution below as usual.
      }
      safeSetState({
        step: 'waiting-spv',
        requestKey,
        spvAttempt: 0,
        spvMaxAttempts: 0,
      });

      // The poll is cancellable (idempotent reads); the cleanup aborts it on
      // unmount. The signed submit above is NEVER aborted.
      const controller = new AbortController();
      pollAbortRef.current = controller;

      const pollResult = await pollOp(
        { requestKey, sourceChain, targetChain },
        undefined,
        {
          signal: controller.signal,
          onProgress: (attempt, maxAttempts) => {
            safeSetState({
              step: 'waiting-spv',
              requestKey,
              spvAttempt: attempt,
              spvMaxAttempts: maxAttempts,
            });
          },
        },
      );

      pollAbortRef.current = null;
      inFlightRef.current = false;

      if (pollResult.ok) {
        // The continuation minted: clear the durable record (nothing to resume)
        // and refresh balances once.
        await clearPersisted();
        safeSetState({ step: 'done', continuationKey: pollResult.continuationKey });
        onSuccess?.();
        return;
      }

      // spv-timeout / continuation-pending → PENDING carrying the request key:
      // the burn committed; resume later, NEVER resubmit. continuation-failed →
      // a hard error (the continuation did not land); keep the durable record so
      // a recovery view can still surface the burn's request key.
      if (
        pollResult.reason === 'spv-timeout' ||
        pollResult.reason === 'continuation-pending'
      ) {
        await persist({
          requestKey: pollResult.requestKey,
          sourceChain,
          targetChain,
          amount: params.amount,
          step: 'pending',
          reason: pollResult.reason,
        });
        safeSetState({
          step: 'pending',
          reason: pollResult.reason,
          requestKey: pollResult.requestKey,
        });
        return;
      }

      safeSetState({
        step: 'error',
        reason: pollResult.reason,
        detail: pollResult.detail,
      });
    },
    [state.step, step0Op, pollOp, persist, clearPersisted, safeSetState, onSuccess],
  );

  return { state, transfer, reset };
}
