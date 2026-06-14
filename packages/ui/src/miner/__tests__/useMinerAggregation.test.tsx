import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import {
  KeyringManager,
  minerInflightKey,
  type AggregateAcrossChainsParams,
  type AggregateAcrossChainsResult,
  type Balances,
  type MinerChainProgress,
  type ResumeCrossChainResult,
  type SignableKeypair,
  type StorageAdapter,
} from '@stoawallet/core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider, useWallet } from '../../context/WalletContext';
import {
  useMinerAggregation,
  type ResolveSweepSignersResult,
  type UseMinerAggregationOptions,
} from '../useMinerAggregation';

const ACCOUNT =
  'k:1111111111111111111111111111111111111111111111111111111111111111';

const MNEMONIC =
  'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown';
const PASSWORD = 'correct horse battery staple';

const SENDER_KEYPAIR: SignableKeypair = {
  publicKey: '1111111111111111111111111111111111111111111111111111111111111111',
  privateKey: 'aa'.repeat(32),
  seedType: 'koala',
};

const GAS_KEYPAIR: SignableKeypair = {
  publicKey: 'gas000000000000000000000000000000000000000000000000000000000000',
  privateKey: 'bb'.repeat(32),
  seedType: 'koala',
};

/** A deferred promise whose resolve is exposed for manual control. */
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
 * A pre-scan balance set with positive balances on chains 1 and 2, the target
 * chain 0 funded too (must be excluded), and the rest absent.
 */
function balancesFundedOn(chainIds: string[], extras?: Balances): Balances {
  const out: Balances = {};
  for (let i = 0; i < 10; i += 1) {
    const id = String(i);
    out[id] = chainIds.includes(id)
      ? { balance: '5.000000000000', exists: true }
      : { balance: '0.0', exists: false };
  }
  return { ...out, ...(extras ?? {}) };
}

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

const OK_SIGNERS: ResolveSweepSignersResult = {
  ok: true,
  signingKeypairs: [SENDER_KEYPAIR],
  gasStationKeypair: GAS_KEYPAIR,
};

/** Build the standard injected options with sensible defaults per test. */
function baseOptions(
  over: Partial<UseMinerAggregationOptions>,
): UseMinerAggregationOptions {
  return {
    account: ACCOUNT,
    getBalances: vi.fn(async () => balancesFundedOn(['1', '2'])),
    resolveSigningKeypairs: vi.fn(async () => OK_SIGNERS),
    aggregateAcrossChains: vi.fn(
      async (): Promise<AggregateAcrossChainsResult> => ({ results: [] }),
    ),
    resumeCrossChain: vi.fn(
      async (): Promise<ResumeCrossChainResult> => ({
        ok: false,
        reason: 'step0-pending',
      }),
    ),
    refresh: vi.fn(),
    storage: new InMemoryStorageAdapter(),
    ...over,
  };
}

describe('useMinerAggregation', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(a) derives sources from the pre-scan via buildSweepPlan: target + zero/absent excluded', async () => {
    const { wrapper } = makeWrapper();
    const opts = baseOptions({ targetChain: '0' });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => expect(result.current.sources.length).toBe(2));

    // Funded chains 1 and 2 are the sources; target 0 (also funded) is excluded,
    // and every absent/zero chain is dropped by buildSweepPlan.
    expect(result.current.sources.map((s) => s.chainId)).toEqual(['1', '2']);
    // Default amount is the full balance the pre-scan reported, 12-decimal.
    expect(result.current.sources[0].amount).toBe('5.000000000000');
    expect(result.current.sources.every((s) => s.progress === 'idle')).toBe(true);
  });

  it('(b) changing targetChain re-derives sources WITHOUT re-fetching balances', async () => {
    const { wrapper } = makeWrapper();
    const getBalances = vi.fn(async () => balancesFundedOn(['1', '2', '3']));
    const opts = baseOptions({ targetChain: '0', getBalances });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => expect(result.current.sources.length).toBe(3));
    expect(getBalances).toHaveBeenCalledTimes(1);

    // Selecting chain 2 as the new target excludes it from sources, with NO new fetch.
    act(() => result.current.setTargetChain('2'));
    expect(result.current.sources.map((s) => s.chainId)).toEqual(['1', '3']);
    expect(getBalances).toHaveBeenCalledTimes(1);
  });

  it('(c) aggregate() resolves the signer set ONCE up-front (+gas once for chain 0 source), not per chain', async () => {
    const { wrapper } = makeWrapper();
    const resolveSigningKeypairs = vi.fn(async () => OK_SIGNERS);
    const aggregate = vi.fn(
      async (
        _params: AggregateAcrossChainsParams,
      ): Promise<AggregateAcrossChainsResult> => ({
        results: [
          { chainId: '1', outcome: 'done' as const, requestKey: 'rk1' },
          { chainId: '2', outcome: 'done' as const, requestKey: 'rk2' },
        ],
      }),
    );
    // A funded chain-0 source forces the gas-station keypair into the call. Target 9.
    const getBalances = vi.fn(async () => balancesFundedOn(['0', '1', '2']));
    const opts = baseOptions({
      targetChain: '9',
      getBalances,
      resolveSigningKeypairs,
      aggregateAcrossChains: aggregate,
    });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => expect(result.current.sources.length).toBe(3));

    await act(async () => {
      await result.current.aggregate();
    });

    // Resolver invoked exactly ONCE — not once per source chain (the password-modal race fix).
    expect(resolveSigningKeypairs).toHaveBeenCalledTimes(1);
    // The resolved SET + gas keypair are threaded into the single core call.
    expect(aggregate).toHaveBeenCalledTimes(1);
    const passed = aggregate.mock.calls[0][0];
    expect(passed.signingKeypairs).toEqual([SENDER_KEYPAIR]);
    expect(passed.gasStationKeypair).toEqual(GAS_KEYPAIR);
    expect(passed.account).toBe(ACCOUNT);
    expect(passed.targetChain).toBe('9');
    expect(passed.sources.map((s) => s.chainId)).toEqual(['0', '1', '2']);
  });

  it('(d) two synchronous aggregate() calls invoke core exactly ONCE (double-submit guard)', async () => {
    const { wrapper } = makeWrapper();
    const def = deferred<AggregateAcrossChainsResult>();
    const aggregate = vi.fn(() => def.promise);
    const opts = baseOptions({ targetChain: '0', aggregateAcrossChains: aggregate });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => expect(result.current.sources.length).toBe(2));

    await act(async () => {
      void result.current.aggregate();
      void result.current.aggregate();
      def.resolve({ results: [] });
    });

    expect(aggregate).toHaveBeenCalledTimes(1);
  });

  it('(e) per-chain progress lands on the matching entry; one errors → the other reaches done', async () => {
    const { wrapper } = makeWrapper();
    let emit: ((chainId: string, u: MinerChainProgress) => void) | undefined;
    const def = deferred<AggregateAcrossChainsResult>();
    const aggregate = vi.fn((params: AggregateAcrossChainsParams) => {
      emit = params.onChainProgress;
      return def.promise;
    });
    const opts = baseOptions({ targetChain: '0', aggregateAcrossChains: aggregate });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => expect(result.current.sources.length).toBe(2));

    await act(async () => {
      void result.current.aggregate();
    });

    // Chain 1 errors; chain 2 advances independently to done — allSettled isolation.
    act(() => {
      emit?.('1', { stage: 'error', detail: 'submit-failed' });
      emit?.('2', { stage: 'submitting' });
      emit?.('2', { stage: 'confirming', requestKey: 'rk2' });
      emit?.('2', { stage: 'done', requestKey: 'rk2', continuationKey: 'ck2' });
    });

    const c1 = result.current.sources.find((s) => s.chainId === '1');
    const c2 = result.current.sources.find((s) => s.chainId === '2');
    expect(c1?.progress).toBe('error');
    expect(c2?.progress).toBe('done');
    expect(c2?.requestKey).toBe('rk2');

    await act(async () => {
      def.resolve({ results: [] });
    });
  });

  it('(f) network-lost chain → pending carrying requestKey + continue affordance, NO resubmit', async () => {
    const { wrapper } = makeWrapper();
    let emit: ((chainId: string, u: MinerChainProgress) => void) | undefined;
    const def = deferred<AggregateAcrossChainsResult>();
    const aggregate = vi.fn((params: AggregateAcrossChainsParams) => {
      emit = params.onChainProgress;
      return def.promise;
    });
    const opts = baseOptions({ targetChain: '0', aggregateAcrossChains: aggregate });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => expect(result.current.sources.length).toBe(2));

    await act(async () => {
      void result.current.aggregate();
    });
    act(() => {
      emit?.('1', { stage: 'network-lost', requestKey: 'rk-lost', detail: 'timeout' });
    });

    const c1 = result.current.sources.find((s) => s.chainId === '1');
    // A network-lost terminal is PENDING (not error, not re-armed idle), carries the
    // requestKey, and offers a continue affordance routed to the Phase-5 recovery view.
    expect(c1?.progress).toBe('network-lost');
    expect(c1?.requestKey).toBe('rk-lost');
    expect(c1?.recoveryRoute).toEqual({
      requestKey: 'rk-lost',
      sourceChain: '1',
      targetChain: '0',
    });
    // PENDING, not a hard error: no `error` set, no re-armed idle — the ONLY
    // affordance is the recovery route (continue), so a resubmit is impossible.
    expect(c1?.error).toBeUndefined();
    expect(c1?.progress).not.toBe('idle');
    // The hook surface exposes no per-chain resubmit/retry control at all.
    expect(
      Object.keys(result.current).some((k) => /retry|resubmit/i.test(k)),
    ).toBe(false);

    await act(async () => {
      def.resolve({ results: [] });
    });
  });

  it('(g) locked wallet / failed signer resolution → reason:"locked", core NOT called', async () => {
    const { wrapper } = makeWrapper();
    const resolveSigningKeypairs = vi.fn(
      async (): Promise<ResolveSweepSignersResult> => ({
        ok: false,
        reason: 'locked',
      }),
    );
    const aggregate = vi.fn(
      async (): Promise<AggregateAcrossChainsResult> => ({ results: [] }),
    );
    const opts = baseOptions({
      targetChain: '0',
      resolveSigningKeypairs,
      aggregateAcrossChains: aggregate,
    });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => expect(result.current.sources.length).toBe(2));

    await act(async () => {
      await result.current.aggregate();
    });

    expect(result.current.locked).toBe(true);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('(h) seeded pending in-flight record rehydrates into the matching source entry on mount', async () => {
    const { wrapper } = makeWrapper();
    const storage = new InMemoryStorageAdapter();
    // A prior sweep left chain 1 pending (popup closed mid-poll).
    await storage.set(
      minerInflightKey('1'),
      JSON.stringify({
        requestKey: 'rk-rehydrate',
        sourceChain: '1',
        targetChain: '0',
        amount: '5.000000000000',
        step: 'step-0',
        reason: 'spv-timeout',
      }),
    );
    const opts = baseOptions({ targetChain: '0', storage });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => {
      const c1 = result.current.sources.find((s) => s.chainId === '1');
      expect(c1?.requestKey).toBe('rk-rehydrate');
    });
    const c1 = result.current.sources.find((s) => s.chainId === '1');
    expect(c1?.progress).toBe('spv-timeout');
    expect(c1?.recoveryRoute?.requestKey).toBe('rk-rehydrate');
  });

  it('(h2) already-completed rehydrate reconciles via resumeCrossChain and CLEARS the stale record', async () => {
    const { wrapper } = makeWrapper();
    const storage = new InMemoryStorageAdapter();
    await storage.set(
      minerInflightKey('2'),
      JSON.stringify({
        requestKey: 'rk-stale',
        sourceChain: '2',
        targetChain: '0',
        amount: '5.000000000000',
        step: 'step-0',
        reason: 'spv-timeout',
      }),
    );
    const resumeCrossChain = vi.fn(
      async (): Promise<ResumeCrossChainResult> => ({
        ok: false,
        reason: 'already-completed',
        requestKey: 'rk-stale',
      }),
    );
    const opts = baseOptions({ targetChain: '0', storage, resumeCrossChain });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    // The reconciliation detects the burn already completed and clears the record.
    await waitFor(() => expect(resumeCrossChain).toHaveBeenCalled());
    await waitFor(async () => {
      expect(await storage.get(minerInflightKey('2'))).toBeNull();
    });
    // The chain is NOT re-presented as actionable pending.
    const c2 = result.current.sources.find((s) => s.chainId === '2');
    expect(c2?.progress).not.toBe('spv-timeout');
  });

  it('(i) on settle (all sources terminal) the Phase-3 refresh() is triggered', async () => {
    const { wrapper } = makeWrapper();
    const refresh = vi.fn();
    const aggregate = vi.fn(
      async (): Promise<AggregateAcrossChainsResult> => ({
        results: [
          { chainId: '1', outcome: 'done' as const, requestKey: 'rk1' },
          { chainId: '2', outcome: 'done' as const, requestKey: 'rk2' },
        ],
      }),
    );
    const opts = baseOptions({
      targetChain: '0',
      refresh,
      aggregateAcrossChains: aggregate,
    });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => expect(result.current.sources.length).toBe(2));

    await act(async () => {
      await result.current.aggregate();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.isExecuting).toBe(false);
  });

  it('(j) unmount mid-sweep → no setState-after-unmount warning', async () => {
    const { wrapper } = makeWrapper();
    const def = deferred<AggregateAcrossChainsResult>();
    const aggregate = vi.fn(() => def.promise);
    const opts = baseOptions({ targetChain: '0', aggregateAcrossChains: aggregate });
    const { result, unmount } = renderHook(() => useMinerAggregation(opts), {
      wrapper,
    });

    await waitFor(() => expect(result.current.sources.length).toBe(2));

    await act(async () => {
      void result.current.aggregate();
    });

    // Unmount while the sweep is still in flight, then resolve it.
    unmount();
    await act(async () => {
      def.resolve({ results: [] });
    });

    const warned = errorSpy.mock.calls.some((c: unknown[]) =>
      String(c[0]).includes('unmounted'),
    );
    expect(warned).toBe(false);
  });

  it('(k) no console output prints the keypair secret across a full sweep', async () => {
    const { wrapper } = makeWrapper();
    let emit: ((chainId: string, u: MinerChainProgress) => void) | undefined;
    const def = deferred<AggregateAcrossChainsResult>();
    const aggregate = vi.fn((params: AggregateAcrossChainsParams) => {
      emit = params.onChainProgress;
      return def.promise;
    });
    const opts = baseOptions({ targetChain: '0', aggregateAcrossChains: aggregate });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => expect(result.current.sources.length).toBe(2));

    await act(async () => {
      void result.current.aggregate();
    });
    act(() => {
      emit?.('1', { stage: 'submitting' });
      emit?.('1', { stage: 'done', requestKey: 'rk1', continuationKey: 'ck1' });
    });
    await act(async () => {
      def.resolve({ results: [] });
    });

    const secret = String(SENDER_KEYPAIR.privateKey);
    const allCalls = [
      ...errorSpy.mock.calls,
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...infoSpy.mock.calls,
    ].flat();
    expect(allCalls.some((c) => String(c).includes(secret))).toBe(false);
  });

  it('(l) the PRODUCTION default getBalances (none injected) reads the active account balances via the core seam', async () => {
    const core = await import('@stoawallet/core');
    const getBalancesSpy = vi
      .spyOn(core, 'getBalances')
      .mockResolvedValue(balancesFundedOn(['1', '2']));

    const { wrapper } = makeWrapper();
    // No getBalances injected — the hook must default to the core balances seam,
    // not a permanent-empty sources list. account supplied so the pre-scan runs.
    const opts = baseOptions({ targetChain: '0', getBalances: undefined });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => expect(getBalancesSpy).toHaveBeenCalledWith(ACCOUNT));
    await waitFor(() => expect(result.current.sources.map((s) => s.chainId)).toEqual(['1', '2']));
  });

  it('(m) the PRODUCTION default resolver (none injected) resolves a LOCAL signer via the context seam and threads it (no remote override)', async () => {
    // A real unlocked local wallet, sharing ONE manager with the provider: the
    // context resolveActiveMinerSigners re-derives the real keypair set; the hook's
    // default resolver routes through it.
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    const seed = new KeyringManager({ storage, keyVault });
    const { account } = await seed.importWallet(MNEMONIC, PASSWORD);
    // importWallet already left the manager unlocked with the active account set,
    // so the shared manager resolves the active signer SET on demand.

    const wrapper = ({ children }: { children: ReactNode }) => (
      <WalletProvider storage={storage} keyVault={keyVault} manager={seed}>
        {children}
      </WalletProvider>
    );

    const aggregate = vi.fn(
      async (
        _params: AggregateAcrossChainsParams,
      ): Promise<AggregateAcrossChainsResult> => ({ results: [] }),
    );
    const opts = baseOptions({
      account: account.account,
      targetChain: '0',
      getBalances: vi.fn(async () => balancesFundedOn(['1', '2'])),
      resolveSigningKeypairs: undefined,
      aggregateAcrossChains: aggregate,
    });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => expect(result.current.sources.length).toBe(2));
    await act(async () => {
      await result.current.aggregate();
    });

    expect(result.current.locked).toBe(false);
    expect(aggregate).toHaveBeenCalledTimes(1);
    const passed = aggregate.mock.calls[0][0];
    // Local mode: real key material is threaded, no remote sign override.
    expect(passed.signingKeypairs[0].publicKey).toBe(account.publicKey);
    expect(passed.signingKeypairs[0].privateKey).not.toBe('');
    expect(passed.signTransaction).toBeUndefined();
  });

  it('(m2) a REMOTE-mode default resolver threads a public-only set + the background sign override into the sweep (XP-12)', async () => {
    const storage = new InMemoryStorageAdapter();
    const keyVault = new InMemoryKeyVault();
    const seed = new KeyringManager({ storage, keyVault });
    const { account } = await seed.importWallet(MNEMONIC, PASSWORD);
    await seed.lock();
    const remoteAccount = {
      index: account.index,
      publicKey: account.publicKey,
      account: account.account,
      derivationPath: account.derivationPath,
    };
    const signTx = vi.fn(async () => ({
      ok: true as const,
      signed: { cmd: '{}', hash: 'remote-signed', sigs: [] },
    }));
    const remoteVault = {
      unlock: vi.fn(async () => ({ ok: true as const })),
      lock: vi.fn(async () => {}),
      isUnlocked: vi.fn(async () => true),
      getActiveAccount: vi.fn(async () => remoteAccount),
      listAccounts: vi.fn(async () => [remoteAccount]),
      addAccount: vi.fn(async () => ({ ok: true as const })),
      setActiveAccount: vi.fn(async () => ({ ok: true as const })),
      signTx,
      urstoaExecute: vi.fn(async () => ({ ok: true as const, requestKey: 'rk' })),
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WalletProvider storage={storage} keyVault={keyVault} remoteVault={remoteVault}>
        {children}
      </WalletProvider>
    );

    let threadedSign: ((tx: unknown) => Promise<unknown>) | undefined;
    const aggregate = vi.fn(
      async (params: AggregateAcrossChainsParams): Promise<AggregateAcrossChainsResult> => {
        threadedSign = params.signTransaction as never;
        return { results: [] };
      },
    );
    const opts = baseOptions({
      account: remoteAccount.account,
      targetChain: '9',
      getBalances: vi.fn(async () => balancesFundedOn(['0', '1'])),
      resolveSigningKeypairs: undefined,
      aggregateAcrossChains: aggregate,
    });
    // Render the context alongside so we can mirror the background's active account
    // (the popup does this via the session guard) before resolving signers.
    const { result } = renderHook(
      () => ({
        miner: useMinerAggregation(opts),
        wallet: useWallet(),
      }),
      { wrapper },
    );
    await act(async () => {
      await result.current.wallet.refreshRemoteUnlocked();
    });

    // Chain-0 source forces the gas-station resolution; target 9 keeps both sources.
    await waitFor(() => expect(result.current.miner.sources.length).toBe(2));
    await act(async () => {
      await result.current.miner.aggregate();
    });

    expect(aggregate).toHaveBeenCalledTimes(1);
    const passed = aggregate.mock.calls[0][0];
    // XP-12: the popup-side set is public-only (no secret), and the override is threaded.
    expect(passed.signingKeypairs[0].privateKey).toBe('');
    expect(passed.signingKeypairs[0].publicKey).toBe(remoteAccount.publicKey);
    expect(passed.gasStationKeypair?.privateKey).toBe('');
    expect(passed.signTransaction).toBeDefined();
    // The threaded override routes signing through the background.
    const out = await threadedSign!({ cmd: '{}', hash: 'u' });
    expect(signTx).toHaveBeenCalled();
    expect((out as { hash?: string }).hash).toBe('remote-signed');
  });

  it('(p) reAggregateSource re-runs the sweep for ONLY the named source (guard-unavailable retry, never re-burns siblings)', async () => {
    const { wrapper } = makeWrapper();
    const resolveSigningKeypairs = vi.fn(async () => OK_SIGNERS);
    const aggregate = vi.fn(
      async (
        _params: AggregateAcrossChainsParams,
      ): Promise<AggregateAcrossChainsResult> => ({ results: [] }),
    );
    const opts = baseOptions({
      targetChain: '0',
      getBalances: vi.fn(async () => balancesFundedOn(['1', '2'])),
      resolveSigningKeypairs,
      aggregateAcrossChains: aggregate,
    });
    const { result } = renderHook(() => useMinerAggregation(opts), { wrapper });

    await waitFor(() => expect(result.current.sources.length).toBe(2));

    await act(async () => {
      await result.current.reAggregateSource('2');
    });

    // The retry re-runs the sweep with EXACTLY the one named source — sibling
    // chain 1 is NOT re-swept (it may carry a pending burn; only the pre-burn
    // guard-unavailable source is safe to retry).
    expect(aggregate).toHaveBeenCalledTimes(1);
    const passed = aggregate.mock.calls[0][0];
    expect(passed.sources.map((s) => s.chainId)).toEqual(['2']);
  });

  it('(n) switching account mid-flight does not setState-after-unmount (single-owner cancelledRef)', async () => {
    const { wrapper } = makeWrapper();
    const def = deferred<AggregateAcrossChainsResult>();
    const aggregate = vi.fn(() => def.promise);
    const opts = baseOptions({ targetChain: '0', aggregateAcrossChains: aggregate });
    const { result, rerender, unmount } = renderHook(
      (props: { account: string }) =>
        useMinerAggregation({ ...opts, account: props.account }),
      { wrapper, initialProps: { account: ACCOUNT } },
    );

    await waitFor(() => expect(result.current.sources.length).toBe(2));
    await act(async () => {
      void result.current.aggregate();
    });

    // Switch account mid-flight (re-runs the pre-scan effect), then resolve + unmount.
    await act(async () => {
      rerender({ account: 'k:' + '2'.repeat(64) });
    });
    unmount();
    await act(async () => {
      def.resolve({ results: [] });
    });

    const warned = errorSpy.mock.calls.some((c: unknown[]) =>
      String(c[0]).includes('unmounted'),
    );
    expect(warned).toBe(false);
  });
});
