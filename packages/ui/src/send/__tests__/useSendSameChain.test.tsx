import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import type {
  GaslessResultArtifact,
  SameChainSendResult,
} from '@stoawallet/core';
import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { useSendSameChain, type SendState } from '../useSendSameChain';

const RECIPIENT =
  'k:1111111111111111111111111111111111111111111111111111111111111111';

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

/**
 * A parsed gasless artifact with chain "0" submit-verified (pass) and chain "1"
 * left as a non-pass entry, so gating returns 'verified' for 0 and
 * 'simulate-only' for 1.
 */
const ARTIFACT: GaslessResultArtifact = {
  results: [
    { chainId: '0', outcome: 'pass' },
    { chainId: '1', outcome: 'simulate-only / not submit-verified' },
  ],
};

function makeWrapper() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider storage={storage} keyVault={keyVault}>
      {children}
    </WalletProvider>
  );
  return { wrapper };
}

const OK_RESULT: SameChainSendResult = {
  ok: true,
  requestKey: 'rk-123',
  status: 'success',
};

describe('useSendSameChain', () => {
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

  it('send() resolves a preview WITHOUT calling core; confirm() then advances to success with the requestKey', async () => {
    const { wrapper } = makeWrapper();
    const sendOp = vi.fn(async () => OK_RESULT);

    const { result } = renderHook(
      () =>
        useSendSameChain({ sendSameChain: sendOp, gasless: ARTIFACT }),
      { wrapper },
    );

    // send() produces a preview and DOES NOT call core — submit must wait for
    // an explicit confirm() so the user can review recipient/amount first.
    await act(async () => {
      await result.current.send({
        recipient: RECIPIENT,
        amount: '1.5',
        chainId: '0',
      });
    });

    expect(sendOp).not.toHaveBeenCalled();
    expect(result.current.preview).toMatchObject({
      recipient: RECIPIENT,
      amount: '1.5',
      chainId: '0',
    });
    expect(result.current.state.status).toBe('preview');

    // confirm() executes sign+submit and reaches success carrying the requestKey.
    await act(async () => {
      await result.current.confirm();
    });

    expect(sendOp).toHaveBeenCalledTimes(1);
    expect(sendOp).toHaveBeenCalledWith({
      recipient: RECIPIENT,
      amount: '1.5',
      chainId: '0',
    });
    expect(result.current.state).toEqual({
      status: 'success',
      requestKey: 'rk-123',
    });
  });

  it('maps a gas-payer-rejected core result to a DISTINCT error state, never success', async () => {
    const { wrapper } = makeWrapper();
    const rejected: SameChainSendResult = {
      ok: false,
      reason: 'gas-payer-rejected',
      detail: 'DALOS rate-limit',
      selfPaidFallbackPossible: true,
    };
    const sendOp = vi.fn(async () => rejected);

    const { result } = renderHook(
      () => useSendSameChain({ sendSameChain: sendOp, gasless: ARTIFACT }),
      { wrapper },
    );

    await act(async () => {
      await result.current.send({
        recipient: RECIPIENT,
        amount: '2',
        chainId: '0',
      });
    });
    await act(async () => {
      await result.current.confirm();
    });

    // A gas-payer refusal is surfaced as its own error reason with the
    // self-paid-fallback hint — it is NEVER reported as a success.
    expect(result.current.state).toEqual({
      status: 'error',
      reason: 'gas-payer-rejected',
      detail: 'DALOS rate-limit',
      selfPaidFallbackPossible: true,
    });
  });

  it('surfaces reason:locked WITHOUT calling core when the context send op reports locked', async () => {
    const { wrapper } = makeWrapper();
    const lockedResult = {
      ok: false,
      reason: 'locked',
    } as unknown as SameChainSendResult;
    const sendOp = vi.fn(async () => lockedResult);

    const { result } = renderHook(
      () => useSendSameChain({ sendSameChain: sendOp, gasless: ARTIFACT }),
      { wrapper },
    );

    await act(async () => {
      await result.current.send({
        recipient: RECIPIENT,
        amount: '1',
        chainId: '0',
      });
    });
    await act(async () => {
      await result.current.confirm();
    });

    // A locked wallet is routed to a locked error reason; the keypair never
    // existed so this is a first-class state, not a generic failure.
    const state = result.current.state as Extract<
      SendState,
      { status: 'error' }
    >;
    expect(state.status).toBe('error');
    expect(state.reason).toBe('locked');
  });

  it('invokes the success refresh callback exactly once after a successful submit', async () => {
    const { wrapper } = makeWrapper();
    const sendOp = vi.fn(async () => OK_RESULT);
    const onSuccess = vi.fn();

    const { result } = renderHook(
      () =>
        useSendSameChain({
          sendSameChain: sendOp,
          gasless: ARTIFACT,
          onSuccess,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.send({
        recipient: RECIPIENT,
        amount: '1',
        chainId: '0',
      });
    });
    expect(onSuccess).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.confirm();
    });

    // Success triggers exactly one balance-refresh; the hook never re-reads
    // balances itself.
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('reflects the selected chain gasless gating from the injected artifact (verified vs simulate-only)', async () => {
    const { wrapper } = makeWrapper();
    const sendOp = vi.fn(async () => OK_RESULT);

    const { result, rerender } = renderHook(
      ({ chainId }: { chainId: string }) =>
        useSendSameChain({
          sendSameChain: sendOp,
          gasless: ARTIFACT,
          chainId,
        }),
      { wrapper, initialProps: { chainId: '0' } },
    );

    // Chain 0 is submit-verified in the artifact → unconditional 'verified'.
    expect(result.current.gating).toBe('verified');

    // Chain 1 is a non-pass entry → the hedged 'simulate-only' label.
    rerender({ chainId: '1' });
    expect(result.current.gating).toBe('simulate-only');
  });

  it('guards against double-submit: two synchronous confirm() calls invoke core exactly once', async () => {
    const { wrapper } = makeWrapper();
    const d = deferred<SameChainSendResult>();
    const sendOp = vi.fn(() => d.promise);

    const { result } = renderHook(
      () => useSendSameChain({ sendSameChain: sendOp, gasless: ARTIFACT }),
      { wrapper },
    );

    await act(async () => {
      await result.current.send({
        recipient: RECIPIENT,
        amount: '1',
        chainId: '0',
      });
    });

    // Fire two confirms back-to-back BEFORE the first resolves. The ref-tracked
    // in-flight guard must collapse the second into a no-op so core is called
    // once — a double-submit would double-spend.
    await act(async () => {
      void result.current.confirm();
      void result.current.confirm();
    });

    expect(sendOp).toHaveBeenCalledTimes(1);

    await act(async () => {
      d.resolve(OK_RESULT);
      await d.promise;
    });
    expect(sendOp).toHaveBeenCalledTimes(1);
  });

  it('transitions to pending (not idle) when the context send op rejects AFTER submit, and does NOT re-send', async () => {
    const { wrapper } = makeWrapper();
    const sendOp = vi.fn(async () => {
      throw new Error('lost response after submit');
    });

    const { result } = renderHook(
      () => useSendSameChain({ sendSameChain: sendOp, gasless: ARTIFACT }),
      { wrapper },
    );

    await act(async () => {
      await result.current.send({
        recipient: RECIPIENT,
        amount: '1',
        chainId: '0',
      });
    });
    await act(async () => {
      await result.current.confirm();
    });

    // A rejection AFTER submit is ambiguous: the tx may be on-chain. Land on
    // `pending` (not a re-armed idle) so the UI can never auto-resubmit and
    // double-spend.
    expect(result.current.state.status).toBe('pending');

    // A subsequent confirm() while pending must be a no-op — no re-send.
    await act(async () => {
      await result.current.confirm();
    });
    expect(sendOp).toHaveBeenCalledTimes(1);
  });

  describe('amount + insufficient-funds pre-flight (RR#3)', () => {
    /** Run send()→confirm() with a given amount/balance and return the state. */
    async function runWith(opts: {
      amount: string;
      getAvailableBalance?: (chainId: string) => string | null;
    }): Promise<{ state: SendState; sendOp: ReturnType<typeof vi.fn> }> {
      const { wrapper } = makeWrapper();
      const sendOp = vi.fn(async () => OK_RESULT);
      const { result } = renderHook(
        () =>
          useSendSameChain({
            sendSameChain: sendOp,
            gasless: ARTIFACT,
            chainId: '0',
            getAvailableBalance: opts.getAvailableBalance,
          }),
        { wrapper },
      );
      await act(async () => {
        await result.current.send({
          recipient: RECIPIENT,
          amount: opts.amount,
          chainId: '0',
        });
      });
      await act(async () => {
        await result.current.confirm();
      });
      return { state: result.current.state, sendOp };
    }

    it.each(['0', '-1', 'abc', '', '   ', '1.0000000000001'])(
      'rejects amount %p as invalid-amount WITHOUT calling core',
      async (amount) => {
        const { state, sendOp } = await runWith({ amount });
        expect(state).toEqual({ status: 'error', reason: 'invalid-amount' });
        // A malformed amount must fail fast — core is never invoked, so it can
        // never be misread as an ambiguous pending.
        expect(sendOp).not.toHaveBeenCalled();
        expect(state.status).not.toBe('pending');
      },
    );

    it('rejects an amount over the selected-chain balance as insufficient-funds WITHOUT calling core', async () => {
      const { state, sendOp } = await runWith({
        amount: '5',
        getAvailableBalance: () => '4.999999999999',
      });
      expect(state).toEqual({ status: 'error', reason: 'insufficient-funds' });
      expect(sendOp).not.toHaveBeenCalled();
    });

    it('allows an amount equal to the available balance (boundary) — core IS called', async () => {
      const { state, sendOp } = await runWith({
        amount: '4.5',
        getAvailableBalance: () => '4.5',
      });
      expect(sendOp).toHaveBeenCalledTimes(1);
      expect(state.status).toBe('success');
    });

    it('skips the over-balance check when the balance is unknown (null) but still enforces amount>0', async () => {
      // A null balance (chain still loading / errored) must never BLOCK a send,
      // but the format/positivity checks still apply.
      const ok = await runWith({ amount: '999', getAvailableBalance: () => null });
      expect(ok.sendOp).toHaveBeenCalledTimes(1);
      expect(ok.state.status).toBe('success');

      const bad = await runWith({ amount: '0', getAvailableBalance: () => null });
      expect(bad.sendOp).not.toHaveBeenCalled();
      expect(bad.state).toEqual({ status: 'error', reason: 'invalid-amount' });
    });
  });

  it('a core {ok:false, reason:"invalid-amount"} result maps to error (NOT pending)', async () => {
    const { wrapper } = makeWrapper();
    const invalid = {
      ok: false,
      reason: 'invalid-amount',
    } as unknown as SameChainSendResult;
    // The hook's pre-flight passes (well-formed amount), but core itself returns
    // a discriminated invalid-amount — that clean result must land on `error`
    // with the reason, NEVER the ambiguous `pending` reserved for thrown ops.
    const sendOp = vi.fn(async () => invalid);

    const { result } = renderHook(
      () => useSendSameChain({ sendSameChain: sendOp, gasless: ARTIFACT }),
      { wrapper },
    );

    await act(async () => {
      await result.current.send({
        recipient: RECIPIENT,
        amount: '1.5',
        chainId: '0',
      });
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(sendOp).toHaveBeenCalledTimes(1);
    const state = result.current.state as Extract<SendState, { status: 'error' }>;
    expect(state.status).toBe('error');
    expect(state.reason).toBe('invalid-amount');
    expect(result.current.state.status).not.toBe('pending');
  });

  it('never logs a secret across a full send cycle', async () => {
    const { wrapper } = makeWrapper();
    const sendOp = vi.fn(async () => OK_RESULT);

    const { result } = renderHook(
      () => useSendSameChain({ sendSameChain: sendOp, gasless: ARTIFACT }),
      { wrapper },
    );

    await act(async () => {
      await result.current.send({
        recipient: RECIPIENT,
        amount: '1',
        chainId: '0',
      });
    });
    await act(async () => {
      await result.current.confirm();
    });

    // The hook holds no key material (XP-12), so a full cycle emits no console
    // output at all — nothing to leak a mnemonic/password/keypair through.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('suppresses setState after unmount mid-send (no act warning, no post-unmount state write)', async () => {
    const { wrapper } = makeWrapper();
    const d = deferred<SameChainSendResult>();
    const sendOp = vi.fn(() => d.promise);

    const { result, unmount } = renderHook(
      () => useSendSameChain({ sendSameChain: sendOp, gasless: ARTIFACT }),
      { wrapper },
    );

    await act(async () => {
      await result.current.send({
        recipient: RECIPIENT,
        amount: '1',
        chainId: '0',
      });
    });

    // Start the submit, then unmount (popup closes) before it resolves.
    act(() => {
      void result.current.confirm();
    });
    unmount();

    // Resolving after unmount must NOT setState — the cancelled ref suppresses
    // the post-resolution write. The in-flight submit itself is NOT aborted.
    await act(async () => {
      d.resolve(OK_RESULT);
      await d.promise;
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
