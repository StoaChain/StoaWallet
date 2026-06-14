import {
  CROSSCHAIN_INFLIGHT_KEY,
  resumeCrossChain as coreResumeCrossChain,
  type ResumeCrossChainResult,
  type ResumeParams,
  type StorageAdapter,
} from '@stoawallet/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useOptionalWallet } from '../context/WalletContext';

/**
 * Staged state machine for RESUMING a stalled cross-chain transfer — RESUME,
 * NEVER RESTART. The source-chain burn (step 0) has already committed the user's
 * funds to escrow; this hook only drives the step-1 continuation to completion.
 * It rebuilds NOTHING and resubmits the burn in NO branch.
 *
 * Honest staging: core `resumeCrossChain` is a SINGLE async call that internally
 * polls step 0 → fetches the SPV proof → submits the continuation. The hook
 * cannot observe those internal boundaries, so it exposes ONE in-flight stage
 * (`checking`, set synchronously on `resume()` entry) rather than advertising
 * `fetching-proof` / `executing` substeps it can never actually reach — the same
 * "don't claim a stage the code can't observe" discipline the balances/send
 * hooks follow. The terminal stages are the discriminated outcomes of that call.
 *
 * Reason → step mapping (the load-bearing safety contract):
 *   - step0-pending / spv-unavailable / continuation-pending → `pending`
 *     (retryable — re-check by calling `resume` again with the SAME identity;
 *     NEVER an auto-resubmit, NEVER a restart). A thrown op also lands `pending`
 *     (ambiguous: the continuation may have dispatched).
 *   - already-completed → `success` (the continuation ALREADY landed on a prior
 *     attempt; this is NOT an error — surface success, carry any known
 *     continuationKey, and refresh balances WITHOUT resubmitting).
 *   - {ok:true} → `success` with the continuationKey.
 *   - step0-not-found → `not-found`; no-continuation → `no-continuation`
 *     (distinct informational statuses, neither error nor pending).
 *   - step0-failed / continuation-failed → `error` (hard, not auto-retried).
 *
 * The flow holds NO key material — the continuation is the public gas-station
 * path (unsigned), so the hook emits no console output at all.
 */
export type ResumeState =
  | { readonly step: 'idle' }
  | { readonly step: 'checking' }
  | {
      readonly step: 'success';
      readonly continuationKey?: string;
      readonly reason?: 'already-completed';
    }
  | {
      readonly step: 'pending';
      readonly reason: 'step0-pending' | 'spv-unavailable' | 'continuation-pending' | 'thrown';
      readonly requestKey?: string;
      readonly detail?: string;
    }
  | { readonly step: 'not-found'; readonly reason: 'step0-not-found' }
  | { readonly step: 'no-continuation'; readonly reason: 'no-continuation' }
  | {
      readonly step: 'error';
      readonly reason: 'step0-failed' | 'continuation-failed';
      readonly requestKey?: string;
      readonly detail?: string;
    }
  | { readonly step: 'same-chain' };

/**
 * The hook's own same-chain UI guard (`resume()` short-circuits before calling
 * core). The CORE may ALSO return `same-source-target` if it is invoked directly
 * with an equal pair — both surface as the same `same-chain` view state.
 */

/** The core resume op signature, injectable so tests stay off-network. */
export type ResumeCrossChainFn = (
  params: ResumeParams,
) => Promise<ResumeCrossChainResult>;

export interface UseContinuationResumeOptions {
  /**
   * The recovery resume op. Defaults to core `resumeCrossChain`. The hook never
   * holds key material — the continuation is unsigned/public — so this seam wraps
   * core directly rather than routing through the keyring context.
   */
  readonly resumeCrossChain?: ResumeCrossChainFn;
  /**
   * Called once on a terminal SUCCESS (including already-completed) so the caller
   * refreshes balances — a landed continuation credits the target chain. The hook
   * never reads balances itself.
   */
  readonly refresh?: () => void;
  /**
   * Durable at-rest storage for the cross-chain in-flight record. Defaults to the
   * context-injected adapter (mirroring `useCrossChainTransfer`) so a SUCCESSFUL
   * resume clears the SAME `CROSSCHAIN_INFLIGHT_KEY` the transfer hook persists —
   * a completed transfer must stop re-surfacing as pending on the next mount.
   * Tests inject the in-memory double.
   */
  readonly storage?: StorageAdapter;
  /** Selected request key — drives `canResume`. The view binds `disabled` to it. */
  readonly requestKey?: string;
  /** Selected source chain — drives the same-chain `canResume` guard. */
  readonly sourceChain?: string;
  /** Selected target chain — drives the same-chain `canResume` guard. */
  readonly targetChain?: string;
}

export interface UseContinuationResumeResult {
  readonly state: ResumeState;
  /**
   * True when the form has a non-blank requestKey, distinct source/target chains,
   * and no resume is in flight. The view binds `disabled={!canResume}` rather than
   * re-deriving the condition inline.
   */
  readonly canResume: boolean;
  /** Drive the step-1 continuation to completion. RESUME, never RESTART. */
  resume(params: ResumeParams): Promise<void>;
  /** Reset back to idle. */
  reset(): void;
}

/** Statuses from which a fresh resume may start (terminal or idle). */
function isArmed(step: ResumeState['step']): boolean {
  return step !== 'checking';
}

/** Map a discriminated core result to the terminal hook state. */
function mapResult(result: ResumeCrossChainResult): ResumeState {
  if (result.ok) {
    return { step: 'success', continuationKey: result.continuationKey };
  }
  switch (result.reason) {
    case 'same-source-target':
      // Core refused an equal source/target pair — surface the same same-chain
      // hint the in-hook guard produces.
      return { step: 'same-chain' };
    case 'already-completed':
      // The continuation already landed — SUCCESS without resubmit, carrying the
      // known continuationKey (if the poll surfaced one) so the UI can link it.
      return {
        step: 'success',
        reason: 'already-completed',
        continuationKey: result.continuationKey,
      };
    case 'step0-pending':
    case 'spv-unavailable':
      return { step: 'pending', reason: result.reason };
    case 'continuation-pending':
      return {
        step: 'pending',
        reason: 'continuation-pending',
        requestKey: result.requestKey,
        detail: result.detail,
      };
    case 'step0-not-found':
      return { step: 'not-found', reason: 'step0-not-found' };
    case 'no-continuation':
      return { step: 'no-continuation', reason: 'no-continuation' };
    case 'step0-failed':
      return {
        step: 'error',
        reason: 'step0-failed',
        requestKey: result.requestKey,
        detail: result.detail,
      };
    case 'continuation-failed':
      return {
        step: 'error',
        reason: 'continuation-failed',
        requestKey: result.requestKey,
        detail: result.detail,
      };
  }
}

/**
 * State hook wrapping the recovery resume op with the staged state machine, the
 * RESUME-never-RESTART reason mapping, the in-hook double-submit guard, the
 * thrown-op `pending` landing, and the on-success balance-refresh trigger.
 *
 * The hook holds NO key material (the continuation is unsigned/public) and emits
 * no console output.
 */
export function useContinuationResume(
  options: UseContinuationResumeOptions = {},
): UseContinuationResumeResult {
  const wallet = useOptionalWallet();
  const resumeOp = options.resumeCrossChain ?? coreResumeCrossChain;
  // Prefer the injected storage; else the context adapter. With neither present
  // (standalone, no provider) the in-flight clear is a no-op — there is no durable
  // record to clear in that configuration.
  const storage = options.storage ?? wallet?.storage ?? null;
  const { refresh } = options;

  const [state, setState] = useState<ResumeState>({ step: 'idle' });

  // The in-flight guard: a ref (not state) so two synchronous resume() calls see
  // the flag the FIRST set, before the rendered disabled state catches up. A
  // double submit would risk double-executing step 1.
  const inFlightRef = useRef(false);
  // Mirror the in-flight flag into render state so `canResume` recomputes when a
  // resume starts/ends (a ref change alone does not re-render).
  const [inFlight, setInFlight] = useState(false);

  // Suppress post-resolution setState after unmount (MV3 popup close mid-resume).
  // The in-flight op is NOT aborted — only its UI write and refresh are dropped.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const safeSetState = useCallback((next: ResumeState) => {
    if (cancelledRef.current) return;
    setState(next);
  }, []);

  const reset = useCallback(() => {
    inFlightRef.current = false;
    setInFlight(false);
    safeSetState({ step: 'idle' });
  }, [safeSetState]);

  const resume = useCallback(
    async (params: ResumeParams): Promise<void> => {
      // RR#5: a same-chain "cross-chain" resume is nonsensical — hint, never call
      // core.
      if (params.sourceChain === params.targetChain) {
        safeSetState({ step: 'same-chain' });
        return;
      }

      // Double-submit guard: the ref flips synchronously, so a second resume()
      // fired in the same tick is a no-op and core is called once.
      if (inFlightRef.current) return;
      if (!isArmed(state.step)) return;
      inFlightRef.current = true;
      setInFlight(true);

      // `checking` is set synchronously BEFORE the first await so the guard and
      // progress engage immediately. It is the SINGLE honest in-flight stage —
      // core does poll/proof/submit internally and the hook cannot observe those
      // boundaries.
      safeSetState({ step: 'checking' });

      let result: ResumeCrossChainResult;
      try {
        // RESUME, NEVER RESTART: pass the SAME source-burn identity through to
        // core, which re-derives the continuation from on-chain state. No branch
        // here rebuilds or resubmits the burn.
        result = await resumeOp({
          requestKey: params.requestKey,
          sourceChain: params.sourceChain,
          targetChain: params.targetChain,
        });
      } catch {
        // A thrown op is ambiguous (the continuation may have dispatched) — land
        // on `pending`, never a re-armed idle, so the UI can never auto-resubmit.
        // The thrown value is not surfaced (it could carry transport detail).
        inFlightRef.current = false;
        setInFlight(false);
        safeSetState({ step: 'pending', reason: 'thrown' });
        return;
      }

      inFlightRef.current = false;
      setInFlight(false);

      const next = mapResult(result);
      safeSetState(next);

      // A landed continuation (fresh OR already-completed) credits the target
      // chain — refresh once. Suppressed after unmount via the cancelled ref.
      if (next.step === 'success') {
        // Clear the durable in-flight record: the transfer that persisted it under
        // `CROSSCHAIN_INFLIGHT_KEY` is now complete, so it must stop re-surfacing
        // as pending on the next `useCrossChainTransfer` mount. Guarded so a
        // storage failure can't strand the success surface. Runs even after
        // unmount (the write is idempotent and not a setState).
        try {
          await storage?.remove(CROSSCHAIN_INFLIGHT_KEY);
        } catch {
          // A storage-remove failure is non-fatal: the resume still succeeded.
        }
        if (!cancelledRef.current) {
          refresh?.();
        }
      }
    },
    [resumeOp, refresh, storage, state.step, safeSetState],
  );

  const canResume = useMemo(
    () =>
      !!(options.requestKey ?? '').trim() &&
      options.sourceChain !== options.targetChain &&
      !inFlight,
    [options.requestKey, options.sourceChain, options.targetChain, inFlight],
  );

  return { state, canResume, resume, reset };
}
