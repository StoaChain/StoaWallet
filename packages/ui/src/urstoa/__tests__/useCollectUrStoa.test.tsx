import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import type { ContextUrStoaResult } from '../../context/WalletContext';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import {
  useCollectUrStoa,
  type CollectUrStoaSeam,
} from '../useCollectUrStoa';

const ACCOUNT = 'k:abc';

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

describe('useCollectUrStoa', () => {
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

  it('advances idle → building → submitting → success carrying the request key, calling the seam with the payment key ONLY (no keypair — XP-12)', async () => {
    const { wrapper } = makeWrapper();
    let resolveCollect: (r: ContextUrStoaResult) => void = () => {};
    const urstoaCollect: CollectUrStoaSeam = vi.fn(
      () =>
        new Promise<ContextUrStoaResult>((resolve) => {
          resolveCollect = resolve;
        }),
    );

    const { result } = renderHook(
      () =>
        useCollectUrStoa({
          account: ACCOUNT,
          earnings: { decimal: '5.0' },
          urstoaCollect,
        }),
      { wrapper },
    );

    expect(result.current.state.status).toBe('idle');

    act(() => {
      void result.current.collect();
    });

    await waitFor(() => expect(result.current.state.status).toBe('submitting'));

    await act(async () => {
      resolveCollect({ ok: true, requestKey: 'rk-collect-1' });
    });

    await waitFor(() => expect(result.current.state.status).toBe('success'));
    expect(result.current.state).toEqual({
      status: 'success',
      requestKey: 'rk-collect-1',
    });
    // The seam received the active payment key and NO key material (the context
    // resolves the keypair locally or in the background — XP-12).
    expect(urstoaCollect).toHaveBeenCalledTimes(1);
    const call = (urstoaCollect as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      paymentKeyAddress: string;
    };
    expect(call.paymentKeyAddress).toBe(ACCOUNT);
    expect(JSON.stringify(call).toLowerCase()).not.toMatch(
      /privatekey|secretkey|gasstationkey/,
    );
  });

  it('maps a discriminated collect-failed result onto an error state with its reason+detail', async () => {
    const { wrapper } = makeWrapper();
    const urstoaCollect: CollectUrStoaSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({
        ok: false,
        reason: 'collect-failed',
        detail: 'node rejected',
      }),
    );

    const { result } = renderHook(
      () =>
        useCollectUrStoa({
          account: ACCOUNT,
          earnings: { decimal: '5.0' },
          urstoaCollect,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.collect();
    });

    expect(result.current.state).toEqual({
      status: 'error',
      reason: 'collect-failed',
      detail: 'node rejected',
    });
  });

  // The COLLECT-DISABLED GUARD (RR#7): the gate uses the {decimal}-UNWRAPPED
  // earnings via a numeric `> 0` comparison — NOT String()/truthiness.
  it.each([
    ['{ decimal: "0" }', { decimal: '0' } as unknown],
    ['{ decimal: "0.0" }', { decimal: '0.0' } as unknown],
    ['plain number 0', 0 as unknown],
    ['plain string "0"', '0' as unknown],
    ['null (unknown earnings)', null as unknown],
  ])(
    'disables Collect and no-ops the seam when earnings are %s',
    async (_label, earnings) => {
      const { wrapper } = makeWrapper();
      const urstoaCollect: CollectUrStoaSeam = vi.fn(
        async (): Promise<ContextUrStoaResult> => ({ ok: true, requestKey: 'rk' }),
      );

      const { result } = renderHook(
        () =>
          useCollectUrStoa({
            account: ACCOUNT,
            earnings,
            urstoaCollect,
          }),
        { wrapper },
      );

      expect(result.current.canCollect).toBe(false);

      await act(async () => {
        await result.current.collect();
      });

      expect(urstoaCollect).not.toHaveBeenCalled();
      expect(result.current.state.status).toBe('idle');
    },
  );

  it('enables Collect for a non-zero { decimal: "5.0" } earnings (proves the T12.1 unwrap, not String())', async () => {
    const { wrapper } = makeWrapper();
    const urstoaCollect: CollectUrStoaSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({ ok: true, requestKey: 'rk' }),
    );

    const { result } = renderHook(
      () =>
        useCollectUrStoa({
          account: ACCOUNT,
          earnings: { decimal: '5.0' },
          urstoaCollect,
        }),
      { wrapper },
    );

    expect(result.current.canCollect).toBe(true);
  });

  it('short-circuits to {reason:"locked"} WITHOUT calling the seam when there is no active account', async () => {
    const { wrapper } = makeWrapper();
    const urstoaCollect: CollectUrStoaSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({ ok: true, requestKey: 'rk' }),
    );

    const { result } = renderHook(
      () =>
        useCollectUrStoa({
          account: null,
          earnings: { decimal: '5.0' },
          urstoaCollect,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.collect();
    });

    expect(urstoaCollect).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: 'error', reason: 'locked' });
  });

  it('maps a locked seam result to the locked error state', async () => {
    const { wrapper } = makeWrapper();
    const urstoaCollect: CollectUrStoaSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({ ok: false, reason: 'locked' }),
    );

    const { result } = renderHook(
      () =>
        useCollectUrStoa({
          account: ACCOUNT,
          earnings: { decimal: '5.0' },
          urstoaCollect,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.collect();
    });

    expect(result.current.state).toEqual({ status: 'error', reason: 'locked' });
  });

  it('guards against double-submit: two synchronous collect() invoke the seam exactly once', async () => {
    const { wrapper } = makeWrapper();
    let resolveCollect: (r: ContextUrStoaResult) => void = () => {};
    const urstoaCollect: CollectUrStoaSeam = vi.fn(
      () =>
        new Promise<ContextUrStoaResult>((resolve) => {
          resolveCollect = resolve;
        }),
    );

    const { result } = renderHook(
      () =>
        useCollectUrStoa({
          account: ACCOUNT,
          earnings: { decimal: '5.0' },
          urstoaCollect,
        }),
      { wrapper },
    );

    await act(async () => {
      void result.current.collect();
      void result.current.collect();
    });

    await waitFor(() => expect(result.current.state.status).toBe('submitting'));
    expect(urstoaCollect).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCollect({ ok: true, requestKey: 'rk' });
    });
    await waitFor(() => expect(result.current.state.status).toBe('success'));
  });

  it('lands on pending when the seam THROWS after dispatch, never a re-armed idle', async () => {
    const { wrapper } = makeWrapper();
    const urstoaCollect: CollectUrStoaSeam = vi.fn(async (): Promise<ContextUrStoaResult> => {
      throw new Error('network died after submit');
    });

    const { result } = renderHook(
      () =>
        useCollectUrStoa({
          account: ACCOUNT,
          earnings: { decimal: '5.0' },
          urstoaCollect,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.collect();
    });

    expect(result.current.state.status).toBe('pending');
  });

  it('fires the holdings refresh() once on a successful collect', async () => {
    const { wrapper } = makeWrapper();
    const urstoaCollect: CollectUrStoaSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({ ok: true, requestKey: 'rk' }),
    );
    const refresh = vi.fn();

    const { result } = renderHook(
      () =>
        useCollectUrStoa({
          account: ACCOUNT,
          earnings: { decimal: '5.0' },
          urstoaCollect,
          refresh,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.collect();
    });

    await waitFor(() => expect(result.current.state.status).toBe('success'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire refresh() on a failed collect', async () => {
    const { wrapper } = makeWrapper();
    const urstoaCollect: CollectUrStoaSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({
        ok: false,
        reason: 'collect-failed',
        detail: 'rejected',
      }),
    );
    const refresh = vi.fn();

    const { result } = renderHook(
      () =>
        useCollectUrStoa({
          account: ACCOUNT,
          earnings: { decimal: '5.0' },
          urstoaCollect,
          refresh,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.collect();
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it('REMOTE/extension success: the seam (background-routed) returns {ok:true} and the hook reaches success — no longer locked', async () => {
    const { wrapper } = makeWrapper();
    const urstoaCollect: CollectUrStoaSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({ ok: true, requestKey: 'rk-remote-collect' }),
    );

    const { result } = renderHook(
      () =>
        useCollectUrStoa({
          account: ACCOUNT,
          earnings: { decimal: '5.0' },
          urstoaCollect,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.collect();
    });

    expect(urstoaCollect).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({
      status: 'success',
      requestKey: 'rk-remote-collect',
    });
  });

  it('uses the WalletContext seam by default: a locked wallet (no active account) returns locked', async () => {
    // No `urstoaCollect` injected → the hook uses `wallet.urstoaCollect`. With no
    // unlocked wallet the context op returns locked, so the hook lands on locked.
    const { wrapper } = makeWrapper();

    const { result } = renderHook(
      () =>
        useCollectUrStoa({
          account: ACCOUNT,
          earnings: { decimal: '5.0' },
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.collect();
    });

    expect(result.current.state).toEqual({ status: 'error', reason: 'locked' });
  });

  it('never logs key material via console', async () => {
    const { wrapper } = makeWrapper();
    const urstoaCollect: CollectUrStoaSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({ ok: true, requestKey: 'rk' }),
    );

    const { result } = renderHook(
      () =>
        useCollectUrStoa({
          account: ACCOUNT,
          earnings: { decimal: '5.0' },
          urstoaCollect,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.collect();
    });

    await waitFor(() => expect(result.current.state.status).toBe('success'));
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
