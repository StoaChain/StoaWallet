import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import {
  CROSSCHAIN_INFLIGHT_KEY,
  type PollProofAndContinueOptions,
  type PollProofAndContinueParams,
  type PollProofAndContinueResult,
  type StorageAdapter,
} from '@stoawallet/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import {
  useCrossChainTransfer,
  type ContextCrossChainStep0Result,
  type CrossChainTransferState,
} from '../useCrossChainTransfer';

const RECEIVER =
  'k:2222222222222222222222222222222222222222222222222222222222222222';

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

const STEP0_OK: ContextCrossChainStep0Result = {
  ok: true,
  requestKey: 'rk-step0',
  sourceChain: '0',
  targetChain: '1',
};

const POLL_OK: PollProofAndContinueResult = {
  ok: true,
  continuationKey: 'ck-done',
};

function makeWrapper(storage?: StorageAdapter) {
  const store = storage ?? new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider storage={store} keyVault={keyVault}>
      {children}
    </WalletProvider>
  );
  return { wrapper, storage: store };
}

const PARAMS = {
  receiver: RECEIVER,
  amount: '3.25',
  sourceChain: '0',
  targetChain: '1',
} as const;

describe('useCrossChainTransfer', () => {
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

  it('advances submitting→waiting-spv(with live attempts)→done and refreshes once', async () => {
    const { wrapper } = makeWrapper();
    const step0 = vi.fn(async () => STEP0_OK);
    const refresh = vi.fn();
    let progress: ((a: number, m: number) => void) | undefined;
    const pollDef = deferred<PollProofAndContinueResult>();
    const poll = vi.fn(
      (
        _p: PollProofAndContinueParams,
        _d: unknown,
        opts?: PollProofAndContinueOptions,
      ) => {
        progress = opts?.onProgress;
        return pollDef.promise;
      },
    );

    const { result } = renderHook(
      () =>
        useCrossChainTransfer({
          sendCrossChainStep0: step0,
          pollProofAndContinue: poll,
          onSuccess: refresh,
        }),
      { wrapper },
    );

    expect(result.current.state).toEqual({ step: 'configure' });

    // Drive the whole flow. building is set synchronously; once step-0 resolves
    // the hook is in waiting-spv (poll is still pending) carrying the requestKey.
    await act(async () => {
      void result.current.transfer(PARAMS);
    });

    // The step-0 seam was called once with the user's transfer params.
    expect(step0).toHaveBeenCalledTimes(1);
    expect(step0).toHaveBeenCalledWith({
      receiver: RECEIVER,
      amount: '3.25',
      sourceChain: '0',
      targetChain: '1',
    });

    // The poll is in flight: state is waiting-spv carrying the step-0 requestKey.
    await waitFor(() => {
      expect(result.current.state.step).toBe('waiting-spv');
    });
    const waiting = result.current.state as Extract<
      CrossChainTransferState,
      { step: 'waiting-spv' }
    >;
    expect(waiting.requestKey).toBe('rk-step0');

    // T5.3 onProgress drives the spvAttempt/spvMaxAttempts the UI renders.
    act(() => {
      progress?.(7, 30);
    });
    await waitFor(() => {
      const w = result.current.state as Extract<
        CrossChainTransferState,
        { step: 'waiting-spv' }
      >;
      expect(w.spvAttempt).toBe(7);
      expect(w.spvMaxAttempts).toBe(30);
    });

    // Resolve the poll: the continuation lands, state is done with the key, and
    // exactly one balance refresh fires.
    await act(async () => {
      pollDef.resolve(POLL_OK);
      await pollDef.promise;
    });

    expect(result.current.state).toEqual({
      step: 'done',
      continuationKey: 'ck-done',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('guards double-submit: two synchronous transfer() invoke core step-0 once', async () => {
    const { wrapper } = makeWrapper();
    const step0Def = deferred<ContextCrossChainStep0Result>();
    const step0 = vi.fn(() => step0Def.promise);
    const poll = vi.fn(async () => POLL_OK);

    const { result } = renderHook(
      () =>
        useCrossChainTransfer({
          sendCrossChainStep0: step0,
          pollProofAndContinue: poll,
        }),
      { wrapper },
    );

    // Fire two transfers in the same tick BEFORE step-0 resolves. The ref-tracked
    // in-flight guard collapses the second — a double-submit would double-burn.
    await act(async () => {
      void result.current.transfer(PARAMS);
      void result.current.transfer(PARAMS);
    });

    expect(step0).toHaveBeenCalledTimes(1);

    await act(async () => {
      step0Def.resolve(STEP0_OK);
      await step0Def.promise;
    });
    expect(step0).toHaveBeenCalledTimes(1);
  });

  it('network-lost-pending from step-0 → pending carrying requestKey; core NOT re-called', async () => {
    const { wrapper } = makeWrapper();
    const step0 = vi.fn(
      async (): Promise<ContextCrossChainStep0Result> => ({
        ok: false,
        reason: 'network-lost-pending',
        requestKey: 'rk-ambiguous',
      }),
    );
    const poll = vi.fn(async () => POLL_OK);

    const { result } = renderHook(
      () =>
        useCrossChainTransfer({
          sendCrossChainStep0: step0,
          pollProofAndContinue: poll,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.transfer(PARAMS);
    });

    // A lost-response step-0 is ambiguous: the burn MAY be on chain. Land on
    // pending carrying the requestKey; NEVER continue to poll-and-resubmit.
    expect(result.current.state).toEqual({
      step: 'pending',
      reason: 'network-lost-pending',
      requestKey: 'rk-ambiguous',
    });
    expect(poll).not.toHaveBeenCalled();

    // A subsequent transfer() while pending is a no-op — never re-burn.
    await act(async () => {
      await result.current.transfer(PARAMS);
    });
    expect(step0).toHaveBeenCalledTimes(1);
  });

  it('spv-timeout from the poll → pending carrying the step-0 requestKey, no resubmit', async () => {
    const { wrapper } = makeWrapper();
    const step0 = vi.fn(async () => STEP0_OK);
    const poll = vi.fn(
      async (): Promise<PollProofAndContinueResult> => ({
        ok: false,
        reason: 'spv-timeout',
        requestKey: 'rk-step0',
      }),
    );

    const { result } = renderHook(
      () =>
        useCrossChainTransfer({
          sendCrossChainStep0: step0,
          pollProofAndContinue: poll,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.transfer(PARAMS);
    });

    // The proof never arrived within the bound: the burn already committed, so
    // this is PENDING (resume later via the request key), never a resubmit.
    await waitFor(() => {
      expect(result.current.state).toEqual({
        step: 'pending',
        reason: 'spv-timeout',
        requestKey: 'rk-step0',
      });
    });
    expect(step0).toHaveBeenCalledTimes(1);
  });

  it('submit-failed from step-0 → error (NOT pending)', async () => {
    const { wrapper } = makeWrapper();
    const step0 = vi.fn(
      async (): Promise<ContextCrossChainStep0Result> => ({
        ok: false,
        reason: 'submit-failed',
        detail: 'rejected by node',
      }),
    );
    const poll = vi.fn(async () => POLL_OK);

    const { result } = renderHook(
      () =>
        useCrossChainTransfer({
          sendCrossChainStep0: step0,
          pollProofAndContinue: poll,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.transfer(PARAMS);
    });

    // A definitive submit failure (the tx did NOT land) is a hard error, never
    // the ambiguous pending reserved for lost responses.
    const state = result.current.state as Extract<
      CrossChainTransferState,
      { step: 'error' }
    >;
    expect(state.step).toBe('error');
    expect(state.reason).toBe('submit-failed');
    expect(poll).not.toHaveBeenCalled();
  });

  it('locked → step:error reason:locked WITHOUT calling poll', async () => {
    const { wrapper } = makeWrapper();
    const step0 = vi.fn(
      async (): Promise<ContextCrossChainStep0Result> => ({
        ok: false,
        reason: 'locked',
      }),
    );
    const poll = vi.fn(async () => POLL_OK);

    const { result } = renderHook(
      () =>
        useCrossChainTransfer({
          sendCrossChainStep0: step0,
          pollProofAndContinue: poll,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.transfer(PARAMS);
    });

    expect(result.current.state).toEqual({ step: 'error', reason: 'locked' });
    expect(poll).not.toHaveBeenCalled();
  });

  it('persists the in-flight transfer the instant a requestKey exists, and a fresh hook rehydrates it', async () => {
    const { wrapper, storage } = makeWrapper();
    const step0 = vi.fn(async () => STEP0_OK);
    // Hold the poll open so the first hook stays mid-flight (popup still open).
    const pollDef = deferred<PollProofAndContinueResult>();
    const poll = vi.fn(() => pollDef.promise);

    const first = renderHook(
      () =>
        useCrossChainTransfer({
          sendCrossChainStep0: step0,
          pollProofAndContinue: poll,
        }),
      { wrapper },
    );

    await act(async () => {
      void first.result.current.transfer(PARAMS);
    });
    await waitFor(() => {
      expect(first.result.current.state.step).toBe('waiting-spv');
    });

    // The instant step-0 yields a requestKey it is written to durable storage —
    // NOT only React state — so an MV3 popup close mid-poll cannot strand funds.
    const persisted = await storage.get(CROSSCHAIN_INFLIGHT_KEY);
    expect(persisted).not.toBeNull();
    const parsed = JSON.parse(
      typeof persisted === 'string'
        ? persisted
        : new TextDecoder().decode(persisted as Uint8Array),
    );
    expect(parsed.requestKey).toBe('rk-step0');
    expect(parsed.sourceChain).toBe('0');
    expect(parsed.targetChain).toBe('1');
    expect(parsed.amount).toBe('3.25');

    // The popup closes mid-poll: the first hook unmounts with the entry persisted.
    first.unmount();

    // A FRESH hook instance (popup reopened) over the SAME storage rehydrates the
    // pending transfer into a recoverable state carrying the request key.
    const second = renderHook(
      () =>
        useCrossChainTransfer({
          sendCrossChainStep0: step0,
          pollProofAndContinue: poll,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(second.result.current.state.step).toBe('pending');
    });
    const rehydrated = second.result.current.state as Extract<
      CrossChainTransferState,
      { step: 'pending' }
    >;
    expect(rehydrated.requestKey).toBe('rk-step0');
  });

  it('clears the persisted entry on done', async () => {
    const { wrapper, storage } = makeWrapper();
    const step0 = vi.fn(async () => STEP0_OK);
    const poll = vi.fn(async () => POLL_OK);

    const { result } = renderHook(
      () =>
        useCrossChainTransfer({
          sendCrossChainStep0: step0,
          pollProofAndContinue: poll,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.transfer(PARAMS);
    });

    await waitFor(() => {
      expect(result.current.state.step).toBe('done');
    });
    // A completed transfer leaves no durable in-flight entry behind to rehydrate.
    expect(await storage.get(CROSSCHAIN_INFLIGHT_KEY)).toBeNull();
  });

  it('a storage.set rejection after a confirmed step-0 still surfaces the requestKey (not stuck in submitting)', async () => {
    // Storage whose WRITE fails but reads/removes succeed — a persist() failure
    // must NOT strand the burn: the in-memory requestKey is the last-resort
    // recovery handle, so the hook still advances to waiting-spv carrying it.
    const base = new InMemoryStorageAdapter();
    const storage: StorageAdapter = {
      get: (k) => base.get(k),
      set: () => Promise.reject(new Error('quota exceeded')),
      remove: (k) => base.remove(k),
    };
    const { wrapper } = makeWrapper(storage);
    const step0 = vi.fn(async () => STEP0_OK);
    // Hold the poll open so the hook parks in waiting-spv after the failed persist.
    const pollDef = deferred<PollProofAndContinueResult>();
    const poll = vi.fn(() => pollDef.promise);

    const { result } = renderHook(
      () =>
        useCrossChainTransfer({
          sendCrossChainStep0: step0,
          pollProofAndContinue: poll,
        }),
      { wrapper },
    );

    await act(async () => {
      void result.current.transfer(PARAMS);
    });

    // Despite the persist() rejection, the burn's requestKey reaches the UI via
    // the waiting-spv state — it is never trapped in submitting.
    await waitFor(() => {
      expect(result.current.state.step).toBe('waiting-spv');
    });
    const waiting = result.current.state as Extract<
      CrossChainTransferState,
      { step: 'waiting-spv' }
    >;
    expect(waiting.requestKey).toBe('rk-step0');

    await act(async () => {
      pollDef.resolve(POLL_OK);
      await pollDef.promise;
    });
  });

  it('aborts the poll on unmount: the signal passed to poll is aborted, no setState after unmount', async () => {
    const { wrapper } = makeWrapper();
    const step0 = vi.fn(async () => STEP0_OK);
    let capturedSignal: AbortSignal | undefined;
    const pollDef = deferred<PollProofAndContinueResult>();
    const poll = vi.fn(
      (
        _p: PollProofAndContinueParams,
        _d: unknown,
        opts?: PollProofAndContinueOptions,
      ) => {
        capturedSignal = opts?.signal;
        return pollDef.promise;
      },
    );

    const { result, unmount } = renderHook(
      () =>
        useCrossChainTransfer({
          sendCrossChainStep0: step0,
          pollProofAndContinue: poll,
        }),
      { wrapper },
    );

    await act(async () => {
      void result.current.transfer(PARAMS);
    });
    await waitFor(() => {
      expect(result.current.state.step).toBe('waiting-spv');
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    // Popup closes mid-poll: the cleanup ABORTS the (idempotent) poll loop.
    unmount();
    expect(capturedSignal?.aborted).toBe(true);

    // Resolving after unmount must NOT setState — cancelledRef drops the write.
    await act(async () => {
      pollDef.resolve(POLL_OK);
      await pollDef.promise;
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('never logs a secret across a full transfer cycle', async () => {
    const { wrapper } = makeWrapper();
    const step0 = vi.fn(async () => STEP0_OK);
    const poll = vi.fn(async () => POLL_OK);

    const { result } = renderHook(
      () =>
        useCrossChainTransfer({
          sendCrossChainStep0: step0,
          pollProofAndContinue: poll,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.transfer(PARAMS);
    });
    await waitFor(() => {
      expect(result.current.state.step).toBe('done');
    });

    // The hook holds no key material (XP-12); a full cycle emits no console
    // output at all, so nothing can leak a mnemonic/keypair/password.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
