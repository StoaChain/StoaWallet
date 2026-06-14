import { describe, expect, it, vi } from 'vitest';

import { resumeCrossChain } from '../resumeCrossChain';
import type { ResumeDeps, ResumeParams } from '../resumeCrossChain';

const REQUEST_KEY = 'reqkey-step0-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PACT_ID = 'pactid-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PROOF = 'spv-proof-base64-payload';
const CONT_KEY = 'reqkey-continuation-cccccccccccccccccccccccc';

/** A SigningError stand-in carrying a `.code` — mirrors @stoachain/stoa-core. */
class FakeSigningError extends Error {
  readonly code: string;
  readonly context: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SigningError';
    this.code = code;
    this.context = 'submit';
  }
}

function baseParams(over: Partial<ResumeParams> = {}): ResumeParams {
  return { requestKey: REQUEST_KEY, sourceChain: '2', targetChain: '0', ...over };
}

/**
 * Build a fully-stubbed deps double. `pollResult` drives step-0 status,
 * `proofResult` drives SPV availability, `submitImpl` drives the continuation
 * submit leg. The SigningError class is injected so the orchestrator's
 * `instanceof` check is exercised against the same constructor.
 */
function makeDeps(opts: {
  pollResult?: {
    status: 'pending' | 'success' | 'failure' | 'not-found';
    continuation?: { pactId: string; step: number; stepHasRollback: boolean };
    result?: unknown;
    error?: string;
  };
  proofResult?: { proof: string | null; error?: string };
  submitImpl?: () => Promise<{ requestKey?: string }>;
} = {}) {
  const pollResult =
    opts.pollResult ??
    ({
      status: 'success',
      continuation: { pactId: PACT_ID, step: 0, stepHasRollback: false },
    } as const);

  const pollTransactionStatus = vi.fn(async () => pollResult);
  const fetchSpvProof = vi.fn(async () => opts.proofResult ?? { proof: PROOF });
  const buildContinuationTransaction = vi.fn(
    (pactId: string, proof: string, targetChain: string) => ({
      cmd: 'CONT',
      pactId,
      proof,
      targetChain,
    }),
  );
  const submitContinuation = vi.fn(
    opts.submitImpl ?? (async () => ({ requestKey: CONT_KEY })),
  );

  const deps: ResumeDeps = {
    pollTransactionStatus,
    fetchSpvProof,
    buildContinuationTransaction,
    submitContinuation,
    SigningError: FakeSigningError as unknown as ResumeDeps['SigningError'],
  };

  return {
    deps,
    spies: {
      pollTransactionStatus,
      fetchSpvProof,
      buildContinuationTransaction,
      submitContinuation,
    },
  };
}

describe('resumeCrossChain — RESUME never RESTART recovery', () => {
  it('resumes a finalized burn: success + step-0 continuation + proof → submits and returns the continuation key', async () => {
    const { deps, spies } = makeDeps();

    const result = await resumeCrossChain(baseParams(), deps);

    expect(result).toEqual({ ok: true, continuationKey: CONT_KEY });
    // It must build the continuation from the burn's pactId + the fetched proof,
    // targeting the destination chain — NOT rebuild a fresh transfer.
    expect(spies.buildContinuationTransaction).toHaveBeenCalledWith(
      PACT_ID,
      PROOF,
      '0',
    );
    // The unsigned continuation tx (build output) is what gets submitted.
    expect(spies.submitContinuation).toHaveBeenCalledWith(
      { cmd: 'CONT', pactId: PACT_ID, proof: PROOF, targetChain: '0' },
      '0',
    );
  });

  it('pending burn → step0-pending and NEVER touches proof/build/submit (no restart, no premature resume)', async () => {
    const { deps, spies } = makeDeps({ pollResult: { status: 'pending' } });

    const result = await resumeCrossChain(baseParams(), deps);

    expect(result).toEqual({ ok: false, reason: 'step0-pending' });
    expect(spies.fetchSpvProof).not.toHaveBeenCalled();
    expect(spies.buildContinuationTransaction).not.toHaveBeenCalled();
    expect(spies.submitContinuation).not.toHaveBeenCalled();
  });

  it('burn succeeded but carries NO continuation → no-continuation (cannot fabricate one)', async () => {
    const { deps, spies } = makeDeps({ pollResult: { status: 'success' } });

    const result = await resumeCrossChain(baseParams(), deps);

    expect(result).toEqual({ ok: false, reason: 'no-continuation' });
    expect(spies.submitContinuation).not.toHaveBeenCalled();
  });

  it('burn failed → step0-failed with the scrubbed on-chain detail, never resubmits step 0', async () => {
    const { deps, spies } = makeDeps({
      pollResult: { status: 'failure', error: 'coin.TRANSFER insufficient funds' },
    });

    const result = await resumeCrossChain(baseParams(), deps);

    expect(result).toEqual({
      ok: false,
      reason: 'step0-failed',
      requestKey: REQUEST_KEY,
      detail: 'coin.TRANSFER insufficient funds',
    });
    expect(spies.submitContinuation).not.toHaveBeenCalled();
  });

  it('refuses a same-source-target resume before any network read (mirrors buildStep0)', async () => {
    const { deps, spies } = makeDeps();

    const result = await resumeCrossChain(
      baseParams({ sourceChain: '2', targetChain: '2' }),
      deps,
    );

    // An equal pair could never have produced a real cross-chain burn — refuse up
    // front, NEVER poll/build/submit.
    expect(result).toEqual({ ok: false, reason: 'same-source-target' });
    expect(spies.pollTransactionStatus).not.toHaveBeenCalled();
    expect(spies.submitContinuation).not.toHaveBeenCalled();
  });

  it('request key unknown to the source chain → step0-not-found', async () => {
    const { deps } = makeDeps({ pollResult: { status: 'not-found' } });

    const result = await resumeCrossChain(baseParams(), deps);

    expect(result).toEqual({ ok: false, reason: 'step0-not-found' });
  });

  it('SPV proof not yet available (null proof, pre-finality) → spv-unavailable PENDING, no submit', async () => {
    const { deps, spies } = makeDeps({
      proofResult: { proof: null, error: '400 not available' },
    });

    const result = await resumeCrossChain(baseParams(), deps);

    // Null proof is a RETRYABLE pending state, NOT a failure — the burn is safe.
    expect(result).toEqual({ ok: false, reason: 'spv-unavailable' });
    expect(spies.buildContinuationTransaction).not.toHaveBeenCalled();
    expect(spies.submitContinuation).not.toHaveBeenCalled();
  });

  it('continuation submit REJECTED with an "already completed" signature → already-completed (NOT continuation-failed)', async () => {
    // The continuation/mint lands on the TARGET chain under a separate key, so the
    // SOURCE poll never advances past step 0. The ONLY honest already-completed
    // signal is the submit rejection: a resubmit of a completed defpact is refused
    // by the node with a "pact already completed" / "step already executed" message.
    const { deps, spies } = makeDeps({
      submitImpl: async () => {
        throw new Error('Failure: pact completed: defpact already executed');
      },
    });

    const result = await resumeCrossChain(baseParams(), deps);

    // A landed transfer — map to already-completed (success-without-resubmit),
    // never a misleading hard failure.
    expect(result).toEqual({
      ok: false,
      reason: 'already-completed',
      requestKey: REQUEST_KEY,
    });
    // The submit WAS attempted once (that is how the signal surfaces) but is never
    // retried after the already-completed signature.
    expect(spies.submitContinuation).toHaveBeenCalledTimes(1);
  });

  it('continuation submit TIMES OUT (SigningError code TIMEOUT) → continuation-pending, do NOT auto-retry', async () => {
    const { deps, spies } = makeDeps({
      submitImpl: async () => {
        throw new FakeSigningError('submit deadline exceeded', 'TIMEOUT');
      },
    });

    const result = await resumeCrossChain(baseParams(), deps);

    // A timeout means the continuation may already be confirming — pending, not failed.
    expect(result).toEqual({
      ok: false,
      reason: 'continuation-pending',
      requestKey: REQUEST_KEY,
      detail: 'submit deadline exceeded',
    });
    expect(spies.submitContinuation).toHaveBeenCalledTimes(1);
  });

  it('continuation submit fails with a plain Error → continuation-failed (hard failure), no auto-retry', async () => {
    const { deps, spies } = makeDeps({
      submitImpl: async () => {
        throw new Error('node rejected continuation');
      },
    });

    const result = await resumeCrossChain(baseParams(), deps);

    expect(result).toEqual({
      ok: false,
      reason: 'continuation-failed',
      requestKey: REQUEST_KEY,
      detail: 'node rejected continuation',
    });
    expect(spies.submitContinuation).toHaveBeenCalledTimes(1);
  });

  it('a non-TIMEOUT SigningError is still a hard continuation-failed, not pending', async () => {
    const { deps } = makeDeps({
      submitImpl: async () => {
        throw new FakeSigningError('bad signature envelope', 'INVALID');
      },
    });

    const result = await resumeCrossChain(baseParams(), deps);

    expect(result).toEqual({
      ok: false,
      reason: 'continuation-failed',
      requestKey: REQUEST_KEY,
      detail: 'bad signature envelope',
    });
  });
});
