import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import type { AdvancedAccount } from '@stoawallet/core';
import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import {
  useAdvancedAccounts,
  type ContextAddAdvancedResult,
  type ContextResolveForeignKeyResult,
} from '../useAdvancedAccounts';

const ADDRESS =
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

function makeWrapper() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider storage={storage} keyVault={keyVault}>
      {children}
    </WalletProvider>
  );
  return { wrapper, storage };
}

function makeAccount(
  overrides: Partial<AdvancedAccount> = {},
): AdvancedAccount {
  return {
    id: 'adv-1',
    address: ADDRESS,
    type: 'k-account',
    mode: 'watch-only',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('useAdvancedAccounts', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('addAccount advances idle -> in-flight -> added with the core mode and neededMore', async () => {
    const { wrapper } = makeWrapper();
    const account = makeAccount({ mode: 'send-capable' });
    const added: ContextAddAdvancedResult = {
      ok: true,
      mode: 'send-capable',
      account,
    };
    const addOp = vi.fn(async () => added);
    const listOp = vi.fn(async () => [account]);

    const { result } = renderHook(
      () =>
        useAdvancedAccounts({
          addAdvancedAccount: addOp,
          listAdvancedAccounts: listOp,
        }),
      { wrapper },
    );

    expect(result.current.state.status).toBe('idle');

    await act(async () => {
      await result.current.addAccount(ADDRESS, '0');
    });

    // The terminal state carries the SAME mode the core orchestrator decided,
    // and the address/chain are forwarded verbatim — not a hardcoded default.
    expect(addOp).toHaveBeenCalledWith(ADDRESS, '0');
    expect(result.current.state).toMatchObject({
      status: 'added',
      mode: 'send-capable',
      account,
    });
    // A send-capable add re-reads the list and surfaces the account with its mode.
    expect(result.current.advancedAccounts).toEqual([account]);
  });

  it('a send-capable addAccount passes through an in-flight stage before the terminal add', async () => {
    const { wrapper } = makeWrapper();
    const account = makeAccount({ mode: 'send-capable' });
    const d = deferred<ContextAddAdvancedResult>();
    const addOp = vi.fn(() => d.promise);
    const listOp = vi.fn(async () => [account]);

    const { result } = renderHook(
      () =>
        useAdvancedAccounts({
          addAdvancedAccount: addOp,
          listAdvancedAccounts: listOp,
        }),
      { wrapper },
    );

    act(() => {
      void result.current.addAccount(ADDRESS, '0');
    });

    // While the single core call is in flight the machine is NOT idle and NOT
    // terminal — it sits on an honest in-flight stage.
    expect(result.current.state.status).not.toBe('idle');
    expect(result.current.state.status).not.toBe('added');

    await act(async () => {
      d.resolve({ ok: true, mode: 'send-capable', account });
      await d.promise;
    });

    expect(result.current.state.status).toBe('added');
  });

  it('not-key-guarded yields a DISTINCT warning state, never an added send-capable', async () => {
    const { wrapper } = makeWrapper();
    const notGuarded: ContextAddAdvancedResult = {
      ok: false,
      reason: 'not-key-guarded',
    };
    const addOp = vi.fn(async () => notGuarded);
    const listOp = vi.fn(async () => []);

    const { result } = renderHook(
      () =>
        useAdvancedAccounts({
          addAdvancedAccount: addOp,
          listAdvancedAccounts: listOp,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.addAccount(ADDRESS, '0');
    });

    // not-key-guarded is a WARNING (the account is real but unsignable) — it is
    // neither a silent add nor a plain error, so the UI can warn distinctly.
    expect(result.current.state).toEqual({
      status: 'warning',
      reason: 'not-key-guarded',
    });
    expect(result.current.advancedAccounts).toEqual([]);
  });

  it('an unsatisfiable keyset is added watch-only with neededMore (not send-capable)', async () => {
    const { wrapper } = makeWrapper();
    const account = makeAccount({ mode: 'watch-only' });
    const watchOnly: ContextAddAdvancedResult = {
      ok: true,
      mode: 'watch-only',
      account,
      neededMore: 2,
      predicateRecognized: true,
    };
    const addOp = vi.fn(async () => watchOnly);
    const listOp = vi.fn(async () => [account]);

    const { result } = renderHook(
      () =>
        useAdvancedAccounts({
          addAdvancedAccount: addOp,
          listAdvancedAccounts: listOp,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.addAccount(ADDRESS, '0');
    });

    expect(result.current.state).toMatchObject({
      status: 'added',
      mode: 'watch-only',
      neededMore: 2,
    });
    // The added account is watch-only in the list — no send capability implied.
    expect(result.current.advancedAccounts[0].mode).toBe('watch-only');
  });

  it('an unrecognized predicate yields a DISTINCT warning state, never send-capable', async () => {
    const { wrapper } = makeWrapper();
    const account = makeAccount({ mode: 'watch-only' });
    const unrecognized: ContextAddAdvancedResult = {
      ok: true,
      mode: 'watch-only',
      account,
      neededMore: 0,
      predicateRecognized: false,
    };
    const addOp = vi.fn(async () => unrecognized);
    const listOp = vi.fn(async () => [account]);

    const { result } = renderHook(
      () =>
        useAdvancedAccounts({
          addAdvancedAccount: addOp,
          listAdvancedAccounts: listOp,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.addAccount(ADDRESS, '0');
    });

    expect(result.current.state).toEqual({
      status: 'warning',
      reason: 'unrecognized-predicate',
    });
  });

  it('pasteKey that satisfies the guard transitions the account to send-capable in the list', async () => {
    const { wrapper } = makeWrapper();
    const watchOnly = makeAccount({ mode: 'watch-only' });
    const promoted = makeAccount({ mode: 'send-capable' });
    const resolveOp = vi.fn(
      async (): Promise<ContextResolveForeignKeyResult> => ({
        ok: true,
        mode: 'send-capable',
      }),
    );
    // The list re-read AFTER a satisfying paste reflects the promotion.
    const listOp = vi
      .fn<() => Promise<AdvancedAccount[]>>()
      .mockResolvedValueOnce([watchOnly])
      .mockResolvedValue([promoted]);

    const { result } = renderHook(
      () =>
        useAdvancedAccounts({
          resolveForeignKey: resolveOp,
          listAdvancedAccounts: listOp,
        }),
      { wrapper },
    );

    const outcome = await act(async () =>
      result.current.pasteKey(watchOnly, 'ab'.repeat(32)),
    );

    expect(resolveOp).toHaveBeenCalledWith(watchOnly, 'ab'.repeat(32));
    expect(outcome).toEqual({ ok: true, mode: 'send-capable' });
    // The account flipped to send-capable in the re-read list.
    expect(result.current.advancedAccounts[0].mode).toBe('send-capable');
  });

  it('pasteKey with a mismatched key returns key-mismatch and does NOT transition', async () => {
    const { wrapper } = makeWrapper();
    const watchOnly = makeAccount({ mode: 'watch-only' });
    const resolveOp = vi.fn(
      async (): Promise<ContextResolveForeignKeyResult> => ({
        ok: false,
        reason: 'key-mismatch',
      }),
    );
    const listOp = vi.fn(async () => [watchOnly]);

    const { result } = renderHook(
      () =>
        useAdvancedAccounts({
          resolveForeignKey: resolveOp,
          listAdvancedAccounts: listOp,
        }),
      { wrapper },
    );

    const outcome = await act(async () =>
      result.current.pasteKey(watchOnly, 'cd'.repeat(32)),
    );

    expect(outcome).toEqual({ ok: false, reason: 'key-mismatch' });
    // A rejected paste leaves the account watch-only — no false promotion.
    expect(result.current.advancedAccounts[0].mode).toBe('watch-only');
  });

  it('a locked context returns reason:locked WITHOUT calling core (add + paste)', async () => {
    const { wrapper } = makeWrapper();
    const account = makeAccount();
    const lockedAdd: ContextAddAdvancedResult = { ok: false, reason: 'locked' };
    const lockedResolve: ContextResolveForeignKeyResult = {
      ok: false,
      reason: 'locked',
    };
    const addOp = vi.fn(async () => lockedAdd);
    const resolveOp = vi.fn(async () => lockedResolve);
    const listOp = vi.fn(async () => []);

    const { result } = renderHook(
      () =>
        useAdvancedAccounts({
          addAdvancedAccount: addOp,
          resolveForeignKey: resolveOp,
          listAdvancedAccounts: listOp,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.addAccount(ADDRESS, '0');
    });
    expect(result.current.state).toEqual({ status: 'error', reason: 'locked' });

    const outcome = await act(async () =>
      result.current.pasteKey(account, 'ef'.repeat(32)),
    );
    expect(outcome).toEqual({ ok: false, reason: 'locked' });
  });

  it('retains NO reference to the pasted private key after pasteKey resolves (RR#8)', async () => {
    const { wrapper } = makeWrapper();
    const watchOnly = makeAccount({ mode: 'watch-only' });
    const SECRET = '0123456789abcdef'.repeat(8);
    const resolveOp = vi.fn(
      async (): Promise<ContextResolveForeignKeyResult> => ({
        ok: true,
        mode: 'send-capable',
      }),
    );
    const listOp = vi.fn(async () => [watchOnly]);

    const { result } = renderHook(
      () =>
        useAdvancedAccounts({
          resolveForeignKey: resolveOp,
          listAdvancedAccounts: listOp,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.pasteKey(watchOnly, SECRET);
    });

    // The hook's serialized public surface must not embed the pasted secret
    // anywhere (no captured closure copy, no state field).
    const serialized = JSON.stringify({
      state: result.current.state,
      advancedAccounts: result.current.advancedAccounts,
    });
    expect(serialized).not.toContain(SECRET);
  });

  it('suppresses setState after unmount mid-action (add + paste), no post-unmount write', async () => {
    const { wrapper } = makeWrapper();
    const dAdd = deferred<ContextAddAdvancedResult>();
    const addOp = vi.fn(() => dAdd.promise);
    const dPaste = deferred<ContextResolveForeignKeyResult>();
    const resolveOp = vi.fn(() => dPaste.promise);
    const listOp = vi.fn(async () => []);

    const { result, unmount } = renderHook(
      () =>
        useAdvancedAccounts({
          addAdvancedAccount: addOp,
          resolveForeignKey: resolveOp,
          listAdvancedAccounts: listOp,
        }),
      { wrapper },
    );

    act(() => {
      void result.current.addAccount(ADDRESS, '0');
      void result.current.pasteKey(makeAccount(), 'aa'.repeat(32));
    });
    unmount();

    // Resolving after unmount must not setState — the cancelled ref suppresses
    // the post-resolution write across BOTH actions (MV3 popup close).
    await act(async () => {
      dAdd.resolve({ ok: true, mode: 'send-capable', account: makeAccount() });
      dPaste.resolve({ ok: true, mode: 'send-capable' });
      await Promise.all([dAdd.promise, dPaste.promise]);
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a subsequent addAccount RESETS a prior warning to the in-flight stage (RR#12)', async () => {
    const { wrapper } = makeWrapper();
    const account = makeAccount({ mode: 'send-capable' });
    const addOp = vi
      .fn<(a: string, c: string) => Promise<ContextAddAdvancedResult>>()
      .mockResolvedValueOnce({ ok: false, reason: 'not-key-guarded' })
      .mockResolvedValueOnce({ ok: true, mode: 'send-capable', account });
    const listOp = vi.fn(async () => [account]);

    const { result } = renderHook(
      () =>
        useAdvancedAccounts({
          addAdvancedAccount: addOp,
          listAdvancedAccounts: listOp,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.addAccount(ADDRESS, '0');
    });
    expect(result.current.state.status).toBe('warning');

    // The prior warning must NOT bleed into the next add: the second call clears
    // it and drives a fresh in-flight -> added cycle.
    const d = deferred<void>();
    act(() => {
      void result.current.addAccount(ADDRESS, '1').then(() => d.resolve());
    });
    expect(result.current.state.status).not.toBe('warning');

    await act(async () => {
      await d.promise;
    });
    expect(result.current.state.status).toBe('added');
  });

  it('never logs the pasted private key, across add and paste (NEVER-LOG-SECRETS)', async () => {
    const { wrapper } = makeWrapper();
    const watchOnly = makeAccount({ mode: 'watch-only' });
    const SECRET = 'deadbeef'.repeat(8);
    const addOp = vi.fn(
      async (): Promise<ContextAddAdvancedResult> => ({
        ok: true,
        mode: 'send-capable',
        account: makeAccount({ mode: 'send-capable' }),
      }),
    );
    const resolveOp = vi.fn(
      async (): Promise<ContextResolveForeignKeyResult> => ({
        ok: true,
        mode: 'send-capable',
      }),
    );
    const listOp = vi.fn(async () => [watchOnly]);

    const { result } = renderHook(
      () =>
        useAdvancedAccounts({
          addAdvancedAccount: addOp,
          resolveForeignKey: resolveOp,
          listAdvancedAccounts: listOp,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.addAccount(ADDRESS, '0');
      await result.current.pasteKey(watchOnly, SECRET);
    });

    for (const spy of [errorSpy, logSpy, warnSpy, infoSpy, debugSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SECRET);
      }
    }
  });
});
