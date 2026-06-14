import { CROSSCHAIN_INFLIGHT_KEY, type ResumeCrossChainResult } from '@stoawallet/core';
import { InMemoryStorageAdapter } from '@stoawallet/core/testing';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useContinuationResume,
  type ResumeState,
} from '../useContinuationResume';

const REQUEST_KEY = 'rk-source-burn-0';
const SOURCE = '0';
const TARGET = '3';

/** A deferred promise whose resolve/reject are exposed for manual control. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PARAMS = {
  requestKey: REQUEST_KEY,
  sourceChain: SOURCE,
  targetChain: TARGET,
};

describe('useContinuationResume', () => {
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

  it('resume() advances to success carrying the continuationKey, then calls refresh exactly once', async () => {
    const ok: ResumeCrossChainResult = {
      ok: true,
      continuationKey: 'cont-key-99',
    };
    const resumeOp = vi.fn(async () => ok);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    expect(result.current.state).toEqual({ step: 'idle' });

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    // The core op is RESUMED with the exact source-burn identity — never a fresh
    // transfer. Success carries the continuation (step-1) key, distinct from the
    // step-0 requestKey.
    expect(resumeOp).toHaveBeenCalledTimes(1);
    expect(resumeOp).toHaveBeenCalledWith(PARAMS);
    expect(result.current.state).toEqual({
      step: 'success',
      continuationKey: 'cont-key-99',
    });

    // A landed continuation changes target-chain balance — refresh once.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('sets the in-flight checking step synchronously on resume() entry before the core op resolves', async () => {
    const d = deferred<ResumeCrossChainResult>();
    const resumeOp = vi.fn(() => d.promise);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    // Fire resume but DON'T resolve the core op yet — the hook must already show
    // the in-flight `checking` stage so the UI can render progress immediately.
    act(() => {
      void result.current.resume(PARAMS);
    });
    expect(result.current.state.step).toBe('checking');

    await act(async () => {
      d.resolve({ ok: true, continuationKey: 'k' });
      await d.promise;
    });
    expect(result.current.state.step).toBe('success');
  });

  it('maps step0-pending to a pending state and never re-submits step 0 (RESUME, not RESTART)', async () => {
    const pending: ResumeCrossChainResult = {
      ok: false,
      reason: 'step0-pending',
    };
    const resumeOp = vi.fn(async () => pending);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    // Step 0 is still confirming — the hook lands on a retryable `pending` and
    // does NOT trigger a refresh (nothing changed on the target chain yet).
    expect(result.current.state).toEqual({
      step: 'pending',
      reason: 'step0-pending',
    });
    expect(refresh).not.toHaveBeenCalled();

    // RESUME-never-RESTART: re-checking from pending re-invokes the SAME resume
    // op with the SAME identity; it never rebuilds or resubmits the burn.
    await act(async () => {
      await result.current.resume(PARAMS);
    });
    expect(resumeOp).toHaveBeenCalledTimes(2);
    expect(resumeOp).toHaveBeenLastCalledWith(PARAMS);
  });

  it('maps spv-unavailable to a retryable pending (the burn is safe, proof not yet final)', async () => {
    const spv: ResumeCrossChainResult = {
      ok: false,
      reason: 'spv-unavailable',
    };
    const resumeOp = vi.fn(async () => spv);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    // Pre-finality SPV is retryable, NOT an error — funds remain in escrow.
    expect(result.current.state).toEqual({
      step: 'pending',
      reason: 'spv-unavailable',
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('maps already-completed to SUCCESS-without-resubmit: refresh runs, the continuation is NOT re-sent', async () => {
    const done: ResumeCrossChainResult = {
      ok: false,
      reason: 'already-completed',
      requestKey: REQUEST_KEY,
      continuationKey: 'cont-already',
    };
    const resumeOp = vi.fn(async () => done);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    // The continuation already landed on a prior attempt: this is a SUCCESS, not
    // an error. The hook surfaces success (carrying the known continuationKey)
    // and refreshes balances — but core was asked exactly ONCE and the hook
    // never resubmits the continuation.
    expect(result.current.state).toEqual({
      step: 'success',
      reason: 'already-completed',
      continuationKey: 'cont-already',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(resumeOp).toHaveBeenCalledTimes(1);
  });

  it('clears the durable in-flight record on a successful resume (completed transfer stops re-surfacing as pending)', async () => {
    const storage = new InMemoryStorageAdapter();
    // Seed the record a prior useCrossChainTransfer would have persisted.
    await storage.set(CROSSCHAIN_INFLIGHT_KEY, JSON.stringify({ requestKey: REQUEST_KEY }));

    const resumeOp = vi.fn(
      async (): Promise<ResumeCrossChainResult> => ({ ok: true, continuationKey: 'ck' }),
    );

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, storage, requestKey: REQUEST_KEY }),
    );

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    expect(result.current.state.step).toBe('success');
    // The completed transfer's record is gone — the next transfer-hook mount will
    // not rehydrate it as a phantom pending.
    expect(await storage.get(CROSSCHAIN_INFLIGHT_KEY)).toBeNull();
  });

  it('clears the durable in-flight record on an already-completed resume too', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.set(CROSSCHAIN_INFLIGHT_KEY, JSON.stringify({ requestKey: REQUEST_KEY }));

    const resumeOp = vi.fn(
      async (): Promise<ResumeCrossChainResult> => ({
        ok: false,
        reason: 'already-completed',
        requestKey: REQUEST_KEY,
      }),
    );

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, storage, requestKey: REQUEST_KEY }),
    );

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    expect(result.current.state.step).toBe('success');
    expect(await storage.get(CROSSCHAIN_INFLIGHT_KEY)).toBeNull();
  });

  it('maps continuation-pending to pending carrying the requestKey, never resubmitting', async () => {
    const cp: ResumeCrossChainResult = {
      ok: false,
      reason: 'continuation-pending',
      requestKey: 'rk-cont-inflight',
      detail: 'submit timed out',
    };
    const resumeOp = vi.fn(async () => cp);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    // A continuation-submit timeout may already be confirming — re-check, never
    // resubmit (a double submit would double-execute step 1). The requestKey is
    // carried so the UI can poll it.
    expect(result.current.state).toEqual({
      step: 'pending',
      reason: 'continuation-pending',
      requestKey: 'rk-cont-inflight',
      detail: 'submit timed out',
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('maps no-continuation to a distinct (non-error, non-pending) status', async () => {
    const nc: ResumeCrossChainResult = {
      ok: false,
      reason: 'no-continuation',
    };
    const resumeOp = vi.fn(async () => nc);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    // Not a cross-chain transfer at all — a distinct informational status, not a
    // hard error and not a retryable pending.
    expect(result.current.state).toEqual({
      step: 'no-continuation',
      reason: 'no-continuation',
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('maps step0-not-found to a distinct (non-error) status', async () => {
    const nf: ResumeCrossChainResult = {
      ok: false,
      reason: 'step0-not-found',
    };
    const resumeOp = vi.fn(async () => nf);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    // The burn isn't on the named source chain — a distinct "not found here"
    // status (likely a wrong source chain), not a failure of the burn itself.
    expect(result.current.state).toEqual({
      step: 'not-found',
      reason: 'step0-not-found',
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('maps step0-failed to a hard error carrying the detail AND the requestKey', async () => {
    const failed: ResumeCrossChainResult = {
      ok: false,
      reason: 'step0-failed',
      requestKey: REQUEST_KEY,
      detail: 'burn reverted on chain',
    };
    const resumeOp = vi.fn(async () => failed);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    // The burn itself failed — a hard error (no funds were escrowed). No refresh.
    // The requestKey is echoed (F-007) so the error surface can show it.
    expect(result.current.state).toEqual({
      step: 'error',
      reason: 'step0-failed',
      requestKey: REQUEST_KEY,
      detail: 'burn reverted on chain',
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('maps continuation-failed to a hard error that is NOT auto-retried', async () => {
    const failed: ResumeCrossChainResult = {
      ok: false,
      reason: 'continuation-failed',
      requestKey: 'rk-cont-fail',
      detail: 'pact error on target',
    };
    const resumeOp = vi.fn(async () => failed);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    // A definitively failed continuation is a hard error — distinct from the
    // retryable continuation-pending. The hook does not loop or auto-retry.
    expect(result.current.state).toEqual({
      step: 'error',
      reason: 'continuation-failed',
      requestKey: 'rk-cont-fail',
      detail: 'pact error on target',
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('lands on pending (not idle) when the core op THROWS — ambiguous, never auto-resubmit', async () => {
    const resumeOp = vi.fn(async () => {
      throw new Error('lost connection mid-resume');
    });
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    // A thrown op is ambiguous (the continuation may have been dispatched) — land
    // on a retryable pending, never a re-armed idle that could auto-resubmit.
    expect(result.current.state.step).toBe('pending');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('guards double-submit: two synchronous resume() calls invoke core exactly once', async () => {
    const d = deferred<ResumeCrossChainResult>();
    const resumeOp = vi.fn(() => d.promise);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    // Fire two resumes back-to-back BEFORE the first resolves. The ref-tracked
    // in-flight guard collapses the second into a no-op so core runs once.
    await act(async () => {
      void result.current.resume(PARAMS);
      void result.current.resume(PARAMS);
    });

    expect(resumeOp).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve({ ok: true, continuationKey: 'k' });
      await d.promise;
    });
    expect(resumeOp).toHaveBeenCalledTimes(1);
  });

  it('no-ops (with a hint) when sourceChain === targetChain — never calls core', async () => {
    const resumeOp = vi.fn(async () => ({ ok: true, continuationKey: 'k' }) as const);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    await act(async () => {
      await result.current.resume({
        requestKey: REQUEST_KEY,
        sourceChain: '2',
        targetChain: '2',
      });
    });

    // A same-chain "cross-chain" resume is nonsensical — the hook hints and never
    // calls core.
    expect(resumeOp).not.toHaveBeenCalled();
    const state = result.current.state as Extract<
      ResumeState,
      { step: 'same-chain' }
    >;
    expect(state.step).toBe('same-chain');
  });

  it('derives canResume from a non-blank requestKey, distinct chains, and not-in-flight', async () => {
    const d = deferred<ResumeCrossChainResult>();
    const resumeOp = vi.fn(() => d.promise);
    const refresh = vi.fn();

    const { result, rerender } = renderHook(
      ({ requestKey, sourceChain, targetChain }) =>
        useContinuationResume({
          resumeCrossChain: resumeOp,
          refresh,
          requestKey,
          sourceChain,
          targetChain,
        }),
      {
        initialProps: {
          requestKey: REQUEST_KEY,
          sourceChain: SOURCE,
          targetChain: TARGET,
        },
      },
    );

    // All preconditions met → resumable.
    expect(result.current.canResume).toBe(true);

    // Blank requestKey → not resumable (nothing to resume).
    rerender({ requestKey: '   ', sourceChain: SOURCE, targetChain: TARGET });
    expect(result.current.canResume).toBe(false);

    // Same source/target → not resumable.
    rerender({ requestKey: REQUEST_KEY, sourceChain: '4', targetChain: '4' });
    expect(result.current.canResume).toBe(false);

    // Back to valid, then go in-flight → not resumable while a resume runs.
    rerender({
      requestKey: REQUEST_KEY,
      sourceChain: SOURCE,
      targetChain: TARGET,
    });
    expect(result.current.canResume).toBe(true);

    act(() => {
      void result.current.resume(PARAMS);
    });
    expect(result.current.canResume).toBe(false);

    await act(async () => {
      d.resolve({ ok: true, continuationKey: 'k' });
      await d.promise;
    });
  });

  it('suppresses setState after unmount mid-resume (no post-unmount state write)', async () => {
    const d = deferred<ResumeCrossChainResult>();
    const resumeOp = vi.fn(() => d.promise);
    const refresh = vi.fn();

    const { result, unmount } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    act(() => {
      void result.current.resume(PARAMS);
    });
    unmount();

    // Resolving after unmount must NOT setState — the cancelled ref suppresses
    // the post-resolution write (the in-flight op itself is NOT aborted), and the
    // success refresh is suppressed too since the component is gone.
    await act(async () => {
      d.resolve({ ok: true, continuationKey: 'k' });
      await d.promise;
    });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('never logs across a full resume cycle (recovery holds no key material)', async () => {
    const resumeOp = vi.fn(async () => ({ ok: true, continuationKey: 'k' }) as const);
    const refresh = vi.fn();

    const { result } = renderHook(() =>
      useContinuationResume({ resumeCrossChain: resumeOp, refresh }),
    );

    await act(async () => {
      await result.current.resume(PARAMS);
    });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
