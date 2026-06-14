import { describe, expect, it, vi } from 'vitest';

import { InMemoryStorageAdapter } from '../../testing/inMemory';
import { MINER_AGGREGATION_KEY } from '../../storage/storageKeys';
import {
  aggregateAcrossChains,
  minerInflightKey,
  type AggregateDeps,
  type RemoteSignTransaction,
} from '../aggregate';
import type { SweepSource } from '../sweepPlan';
import type { MinerChainProgress } from '../aggregate';
import type { SendCrossChainStep0Result } from '../../crosschain/sendCrossChainStep0';
import type { PollProofAndContinueResult } from '../../crosschain/pollAndContinue';

/**
 * `aggregateAcrossChains` is the PARALLEL miner-aggregation sweep orchestrator.
 * It REUSES the Phase-5 `sendCrossChainStep0` (build → sign → submit → confirm)
 * and `pollProofAndContinue` (SPV poll + continuation) per source chain — it does
 * NOT re-call the SDK trio. The two Phase-5 orchestrators are injected here as
 * stubs so the suite stays fully off-network and pins the money-safety branching:
 * isolation, TIMEOUT-as-pending (never resubmit), per-chain progress, and the
 * XP-5 per-source-chain durable persistence.
 */

const PUB = 'a'.repeat(64);
const ACCOUNT = `k:${PUB}`;
const GAS_PUB = 'f'.repeat(64);

const senderKeypair = { publicKey: PUB, privateKey: 'c'.repeat(64) };
const gasStationKeypair = { publicKey: GAS_PUB, privateKey: 'd'.repeat(64) };
const secondKeypair = { publicKey: 'b'.repeat(64), privateKey: 'e'.repeat(64) };

function sendOk(requestKey: string, sourceChain: string, targetChain: string): SendCrossChainStep0Result {
  return { ok: true, requestKey, sourceChain, targetChain };
}

function pollOk(continuationKey: string): PollProofAndContinueResult {
  return { ok: true, continuationKey };
}

/**
 * Build a deps object whose `sendCrossChain`/`pollProofAndContinue` default to
 * the happy path; tests override per-source behavior by request key / source.
 */
function makeDeps(over: Partial<AggregateDeps> = {}): AggregateDeps {
  return {
    sendCrossChain: vi.fn(async (input) =>
      sendOk(`rk-${input.sourceChain}`, input.sourceChain, input.targetChain),
    ),
    pollProofAndContinue: vi.fn(async (params) => pollOk(`cont-${params.sourceChain}`)),
    ...over,
  };
}

function source(chainId: string, amount: string): SweepSource {
  return { chainId, amount };
}

const baseParams = () => ({
  targetChain: '5',
  account: ACCOUNT,
  signingKeypairs: [senderKeypair],
  storage: new InMemoryStorageAdapter(),
});

describe('aggregateAcrossChains', () => {
  it('(a) sweeps two funded sources in parallel and reports both done with a continuationKey', async () => {
    const deps = makeDeps();
    const { results } = await aggregateAcrossChains(
      {
        ...baseParams(),
        sources: [source('1', '5.000000000000'), source('2', '3.000000000000')],
      },
      deps,
    );

    expect(results).toHaveLength(2);
    const byChain = Object.fromEntries(results.map((r) => [r.chainId, r]));
    expect(byChain['1'].outcome).toBe('done');
    expect(byChain['1'].continuationKey).toBe('cont-1');
    expect(byChain['2'].outcome).toBe('done');
    expect(byChain['2'].continuationKey).toBe('cont-2');
    // REUSE proof: both legs of the Phase-5 machinery were invoked per source.
    expect(deps.sendCrossChain).toHaveBeenCalledTimes(2);
    expect(deps.pollProofAndContinue).toHaveBeenCalledTimes(2);
  });

  it('(a2) threads each source self-transfer as receiver===sender===account into the reused sendCrossChain', async () => {
    const deps = makeDeps();
    await aggregateAcrossChains(
      { ...baseParams(), sources: [source('1', '5.000000000000')] },
      deps,
    );
    const call = (deps.sendCrossChain as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.sender).toBe(ACCOUNT);
    expect(call.receiver).toBe(ACCOUNT);
    expect(call.senderPublicKey).toBe(PUB);
    expect(call.sourceChain).toBe('1');
    expect(call.targetChain).toBe('5');
  });

  it('(b) ISOLATES a hard submit-throw: chain 1 done + chain 2 submit-failed → [done, error], function RESOLVES', async () => {
    const deps = makeDeps({
      sendCrossChain: vi.fn(async (input) => {
        if (input.sourceChain === '2') {
          return { ok: false, reason: 'submit-failed', detail: 'boom' } as SendCrossChainStep0Result;
        }
        return sendOk(`rk-${input.sourceChain}`, input.sourceChain, input.targetChain);
      }),
    });

    const { results } = await aggregateAcrossChains(
      { ...baseParams(), sources: [source('1', '5'), source('2', '3')] },
      deps,
    );

    const byChain = Object.fromEntries(results.map((r) => [r.chainId, r]));
    expect(byChain['1'].outcome).toBe('done');
    expect(byChain['2'].outcome).toBe('error');
    expect(byChain['2'].detail).toBe('boom');
    // A hard failure on chain 2 never advanced its SPV continuation.
    expect((deps.pollProofAndContinue as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].sourceChain)).toEqual(['1']);
  });

  it('(c) maps sendCrossChain network-lost-pending → network-lost terminal carrying requestKey, never re-called', async () => {
    const send = vi.fn(async () => ({
      ok: false,
      reason: 'network-lost-pending',
      requestKey: 'rk-pending',
    }) as SendCrossChainStep0Result);
    const deps = makeDeps({ sendCrossChain: send });

    const { results } = await aggregateAcrossChains(
      { ...baseParams(), sources: [source('1', '5')] },
      deps,
    );

    expect(results[0].outcome).toBe('network-lost');
    expect(results[0].requestKey).toBe('rk-pending');
    // PENDING ≠ retry: the signed Step-0 submit is never replayed (anti-double-spend).
    expect(send).toHaveBeenCalledTimes(1);
    // A pending Step-0 never advances to the continuation.
    expect(deps.pollProofAndContinue).not.toHaveBeenCalled();
  });

  it('(d) maps pollProofAndContinue spv-timeout → spv-timeout terminal carrying requestKey, continuation never resubmitted', async () => {
    const poll = vi.fn(async (params: { requestKey: string }) => ({
      ok: false,
      reason: 'spv-timeout',
      requestKey: params.requestKey,
    }) as PollProofAndContinueResult);
    const deps = makeDeps({ pollProofAndContinue: poll });

    const { results } = await aggregateAcrossChains(
      { ...baseParams(), sources: [source('1', '5')] },
      deps,
    );

    expect(results[0].outcome).toBe('spv-timeout');
    expect(results[0].requestKey).toBe('rk-1');
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('(d2) maps a submitContinuation TIMEOUT (pollProofAndContinue continuation-pending) → continuation-pending terminal (RR#1), distinct from continuation-failed', async () => {
    const deps = makeDeps({
      pollProofAndContinue: vi.fn(async (params: { requestKey: string; sourceChain: string }) => {
        if (params.sourceChain === '1') {
          return { ok: false, reason: 'continuation-pending', requestKey: params.requestKey, detail: 'submit timed out' } as PollProofAndContinueResult;
        }
        return { ok: false, reason: 'continuation-failed', requestKey: params.requestKey, detail: 'reverted on chain' } as PollProofAndContinueResult;
      }),
    });

    const { results } = await aggregateAcrossChains(
      { ...baseParams(), sources: [source('1', '5'), source('2', '3')] },
      deps,
    );

    const byChain = Object.fromEntries(results.map((r) => [r.chainId, r]));
    // TIMEOUT on the continuation submit is PENDING — recovery, never auto-resubmit.
    expect(byChain['1'].outcome).toBe('continuation-pending');
    expect(byChain['1'].requestKey).toBe('rk-1');
    // A definitive on-chain continuation failure is a HARD error — the OPPOSITE branch.
    expect(byChain['2'].outcome).toBe('error');
    expect(byChain['2'].requestKey).toBe('rk-2');
  });

  it('(e1) reads the resolved keypairs exactly ONCE up-front — never inside the per-chain loop', async () => {
    const deps = makeDeps();
    let reads = 0;
    const params = baseParams();
    // A getter counts every access of `signingKeypairs`; a per-chain resolution
    // would read it once per source — we require exactly one up-front read.
    Object.defineProperty(params, 'signingKeypairs', {
      get() {
        reads += 1;
        return [senderKeypair];
      },
      configurable: true,
    });

    await aggregateAcrossChains(
      { ...params, sources: [source('1', '5'), source('2', '3'), source('3', '1')] },
      deps,
    );

    expect(reads).toBe(1);
  });

  it('(e2) a chain-0 source with a MISSING gasStationKeypair → that chain error, others unaffected', async () => {
    const deps = makeDeps();
    const { results } = await aggregateAcrossChains(
      {
        ...baseParams(),
        // No gasStationKeypair provided, yet a chain-"0" source is present.
        sources: [source('0', '5'), source('1', '3')],
      },
      deps,
    );

    const byChain = Object.fromEntries(results.map((r) => [r.chainId, r]));
    expect(byChain['0'].outcome).toBe('error');
    expect(byChain['1'].outcome).toBe('done');
    // The chain-0 source short-circuits BEFORE reaching the reused Step-0 build.
    expect((deps.sendCrossChain as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].sourceChain)).toEqual(['1']);
  });

  it('(e3) a chain-0 source WITH a gasStationKeypair threads its public key into the reused sendCrossChain', async () => {
    const deps = makeDeps();
    await aggregateAcrossChains(
      { ...baseParams(), gasStationKeypair, sources: [source('0', '5')] },
      deps,
    );
    const call = (deps.sendCrossChain as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.gasStationPublicKey).toBe(GAS_PUB);
  });

  it('(f) persists the per-chain in-flight record on confirming under the miner namespace and clears it on done — amount matches (RR#3)', async () => {
    const storage = new InMemoryStorageAdapter();
    const setSpy = vi.spyOn(storage, 'set');
    const deps = makeDeps();

    const { results } = await aggregateAcrossChains(
      { ...baseParams(), storage, sources: [source('1', '5.000000000000')] },
      deps,
    );

    // Persisted the instant the Step-0 requestKey existed (confirming).
    const persistedCall = setSpy.mock.calls.find((c) => c[0] === minerInflightKey('1'));
    expect(persistedCall).toBeDefined();
    const record = JSON.parse(persistedCall![1] as string);
    expect(record.requestKey).toBe('rk-1');
    expect(record.sourceChain).toBe('1');
    expect(record.targetChain).toBe('5');
    expect(record.amount).toBe('5.000000000000');
    // The miner namespace is derived from the shared registry constant.
    expect(minerInflightKey('1').startsWith(MINER_AGGREGATION_KEY)).toBe(true);
    // On done the record is cleared so it is not re-presented as actionable pending.
    expect(results[0].outcome).toBe('done');
    expect(await storage.get(minerInflightKey('1'))).toBeNull();
  });

  it('(f2) a pending chain KEEPS its persisted in-flight record (recovery needs the requestKey)', async () => {
    const storage = new InMemoryStorageAdapter();
    const deps = makeDeps({
      pollProofAndContinue: vi.fn(async (params: { requestKey: string }) => ({
        ok: false,
        reason: 'spv-timeout',
        requestKey: params.requestKey,
      }) as PollProofAndContinueResult),
    });

    await aggregateAcrossChains(
      { ...baseParams(), storage, sources: [source('1', '7.5')] },
      deps,
    );

    const raw = await storage.get(minerInflightKey('1'));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).requestKey).toBe('rk-1');
  });

  it('(g) emits the staged per-chain progress sequence with the forwarded SPV attempt/max', async () => {
    const updates: Array<{ chainId: string; update: MinerChainProgress }> = [];
    const deps = makeDeps({
      pollProofAndContinue: vi.fn(async (params, _deps, options) => {
        // Forward the T5.3 onProgress cadence (30 attempts × 5000ms).
        options?.onProgress?.(1, 30);
        return pollOk(`cont-${params.sourceChain}`);
      }),
    });

    await aggregateAcrossChains(
      {
        ...baseParams(),
        sources: [source('1', '5')],
        onChainProgress: (chainId, update) => updates.push({ chainId, update }),
      },
      deps,
    );

    const stages = updates.map((u) => u.update.stage);
    expect(stages).toEqual([
      'submitting',
      'confirming',
      'waiting-spv',
      'completing',
      'done',
    ]);
    const confirming = updates.find((u) => u.update.stage === 'confirming')!;
    expect(confirming.update.requestKey).toBe('rk-1');
    const spv = updates.find((u) => u.update.stage === 'waiting-spv')!;
    expect(spv.update.spvAttempt).toBe(1);
    expect(spv.update.spvMaxAttempts).toBe(30);
  });

  it('(g2) a pending chain ends on a network-lost progress update carrying its requestKey', async () => {
    const updates: Array<{ chainId: string; update: MinerChainProgress }> = [];
    const deps = makeDeps({
      sendCrossChain: vi.fn(async () => ({
        ok: false,
        reason: 'network-lost-pending',
        requestKey: 'rk-nl',
      }) as SendCrossChainStep0Result),
    });

    await aggregateAcrossChains(
      {
        ...baseParams(),
        sources: [source('1', '5')],
        onChainProgress: (chainId, update) => updates.push({ chainId, update }),
      },
      deps,
    );

    const last = updates[updates.length - 1];
    expect(last.update.stage).toBe('network-lost');
    expect(last.update.requestKey).toBe('rk-nl');
  });

  it('(h) a present-but-guard-read-fails self-transfer → guard-unavailable pending, NEVER fabricated keys-all (RR#6)', async () => {
    // The reused Phase-5 build surfaces guard-unavailable (a BuildStep0Reason)
    // when the target account exists but its keyset read fails. A transient read
    // failure on the shared target must isolate to that source, not misroute it.
    const deps = makeDeps({
      sendCrossChain: vi.fn(async (input) => {
        if (input.sourceChain === '1') {
          return { ok: false, reason: 'guard-unavailable' } as SendCrossChainStep0Result;
        }
        return sendOk(`rk-${input.sourceChain}`, input.sourceChain, input.targetChain);
      }),
    });

    const { results } = await aggregateAcrossChains(
      { ...baseParams(), sources: [source('1', '5'), source('2', '3')] },
      deps,
    );

    const byChain = Object.fromEntries(results.map((r) => [r.chainId, r]));
    expect(byChain['1'].outcome).toBe('guard-unavailable');
    // The sibling source — same target — is unaffected by the transient read.
    expect(byChain['2'].outcome).toBe('done');
  });

  it('(i) per-source stage-sensitive abort: a poll-stage source forwards the signal; a mid-submit source completes and persists its requestKey', async () => {
    const controller = new AbortController();
    const storage = new InMemoryStorageAdapter();
    let pollSawSignal = false;

    const deps = makeDeps({
      sendCrossChain: vi.fn(async (input) => {
        // The signed Step-0 submit is NEVER aborted — it completes and yields a
        // requestKey even though teardown was requested mid-flight.
        controller.abort();
        return sendOk(`rk-${input.sourceChain}`, input.sourceChain, input.targetChain);
      }),
      pollProofAndContinue: vi.fn(async (params, _deps, options) => {
        if (options?.signal?.aborted) pollSawSignal = true;
        return { ok: false, reason: 'spv-timeout', requestKey: params.requestKey } as PollProofAndContinueResult;
      }),
    });

    await aggregateAcrossChains(
      { ...baseParams(), storage, sources: [source('1', '5')], signal: controller.signal },
      deps,
    );

    // The mid-submit source persisted its requestKey (never dropped on teardown).
    expect(JSON.parse((await storage.get(minerInflightKey('1'))) as string).requestKey).toBe('rk-1');
    // The poll loop received the aborted signal so it can stop idempotent reads.
    expect(pollSawSignal).toBe(true);
  });

  it('(j) threads an advanced (multi-key) active account keypair SET through each sendCrossChain (RR#2/XP-2)', async () => {
    const deps = makeDeps();
    const set = [senderKeypair, secondKeypair];

    await aggregateAcrossChains(
      { ...baseParams(), signingKeypairs: set, sources: [source('1', '5')] },
      deps,
    );

    const call = (deps.sendCrossChain as ReturnType<typeof vi.fn>).mock.calls[0];
    // The whole resolved SET is forwarded as the second arg (post-XP-2 signature).
    expect(call[1]).toBe(set);
  });

  it('(j2) chain-0 source forwards the sender set PLUS the gas-station keypair to the reused sendCrossChain', async () => {
    const deps = makeDeps();
    await aggregateAcrossChains(
      { ...baseParams(), gasStationKeypair, sources: [source('0', '5')] },
      deps,
    );
    const keypairs = (deps.sendCrossChain as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(keypairs).toContain(senderKeypair);
    expect(keypairs).toContain(gasStationKeypair);
  });

  it('(k) never prints any secret across a full sweep (console-spy)', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];
    const deps = makeDeps({
      sendCrossChain: vi.fn(async (input) => {
        if (input.sourceChain === '2') {
          return { ok: false, reason: 'submit-failed', detail: 'fail' } as SendCrossChainStep0Result;
        }
        return sendOk(`rk-${input.sourceChain}`, input.sourceChain, input.targetChain);
      }),
    });

    await aggregateAcrossChains(
      { ...baseParams(), gasStationKeypair, sources: [source('0', '5'), source('1', '3'), source('2', '1')] },
      deps,
    );

    const secrets = [
      senderKeypair.privateKey,
      gasStationKeypair.privateKey,
      secondKeypair.privateKey,
    ];
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const text = JSON.stringify(call);
        for (const secret of secrets) {
          expect(text.includes(secret)).toBe(false);
        }
      }
      spy.mockRestore();
    }
  });

  it('(l) threads the optional signTransaction override into the reused sendCrossChain per source (remote-mode signing)', async () => {
    const signTransaction: RemoteSignTransaction = vi.fn(async (tx) => tx);
    const deps = makeDeps();

    await aggregateAcrossChains(
      {
        ...baseParams(),
        signTransaction,
        sources: [source('1', '5'), source('2', '3')],
      },
      deps,
    );

    // Each reused sendCrossChain receives the override as its third arg so the
    // real step-0 routes signing through the background (remote mode), while the
    // public-only keypair set still flows in as the second arg for cap construction.
    const calls = (deps.sendCrossChain as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][2]).toBe(signTransaction);
    expect(calls[1][2]).toBe(signTransaction);
  });

  it('(l2) omits the signTransaction override when none is passed (local mode keeps the keypair-set path)', async () => {
    const deps = makeDeps();
    await aggregateAcrossChains(
      { ...baseParams(), sources: [source('1', '5')] },
      deps,
    );
    const call = (deps.sendCrossChain as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toBeUndefined();
  });

  it('(m) re-persists a PENDING poll outcome with its TRUE reason so a rehydrate shows the real stage (not always network-lost)', async () => {
    const storage = new InMemoryStorageAdapter();
    const deps = makeDeps({
      pollProofAndContinue: vi.fn(async (params: { requestKey: string }) => ({
        ok: false,
        reason: 'spv-timeout',
        requestKey: params.requestKey,
      }) as PollProofAndContinueResult),
    });

    await aggregateAcrossChains(
      { ...baseParams(), storage, sources: [source('1', '5')] },
      deps,
    );

    // The record was first persisted on `confirming` (placeholder reason), then
    // re-persisted on the spv-timeout poll outcome with the TRUE stage — so a
    // popup-close rehydrate shows spv-timeout, not the hardcoded network-lost.
    const raw = await storage.get(minerInflightKey('1'));
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw as string);
    expect(record.reason).toBe('spv-timeout');
    expect(record.requestKey).toBe('rk-1');
  });

  it('(m2) re-persists a continuation-pending poll outcome with reason continuation-pending', async () => {
    const storage = new InMemoryStorageAdapter();
    const deps = makeDeps({
      pollProofAndContinue: vi.fn(async (params: { requestKey: string }) => ({
        ok: false,
        reason: 'continuation-pending',
        requestKey: params.requestKey,
        detail: 'submit timed out',
      }) as PollProofAndContinueResult),
    });

    await aggregateAcrossChains(
      { ...baseParams(), storage, sources: [source('1', '5')] },
      deps,
    );

    const raw = await storage.get(minerInflightKey('1'));
    const record = JSON.parse(raw as string);
    expect(record.reason).toBe('continuation-pending');
  });

  it('never throws out of the function even if every source hard-fails', async () => {
    const deps = makeDeps({
      sendCrossChain: vi.fn(async () => {
        throw new Error('unexpected raw throw');
      }),
    });

    await expect(
      aggregateAcrossChains(
        { ...baseParams(), sources: [source('1', '5'), source('2', '3')] },
        deps,
      ),
    ).resolves.toMatchObject({ results: expect.any(Array) });
  });
});
