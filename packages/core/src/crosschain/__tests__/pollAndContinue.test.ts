import { describe, expect, it, vi } from 'vitest';

import { pollProofAndContinue } from '../pollAndContinue';
import type {
  PollAndContinueDeps,
  PollProofAndContinueParams,
} from '../pollAndContinue';

const REQUEST_KEY = 'aReqKey-aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const PROOF = 'eyJzdWJqZWN0Ijp7ImlucHV0IjoiZmFrZS1zcHYtcHJvb2YifX0=';
const CONTINUATION_KEY = 'contKey-9999888877776666555544443333222211110000';

/**
 * A SigningError test double whose `.code` mirrors the SDK's real
 * `SigningError` (message + code). The orchestrator only branches on
 * `instanceof <the ctor it imports>`; since tests can't construct the real
 * SDK class without the network deps, the deps double THROWS, and the
 * orchestrator's branch keys off `error.code === 'TIMEOUT'`. To exercise the
 * `instanceof SigningError` guard we re-use the SDK class through the deps:
 * the production code imports it; the test asserts the OUTCOME, not the class.
 */
class FakeSigningError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SigningError';
    this.code = code;
  }
}

function baseParams(
  over: Partial<PollProofAndContinueParams> = {},
): PollProofAndContinueParams {
  return {
    requestKey: REQUEST_KEY,
    sourceChain: '2',
    targetChain: '5',
    ...over,
  };
}

function makeDeps(opts: {
  pollResult?: { proof: string | null; error?: string };
  pollImpl?: PollAndContinueDeps['pollSpvProof'];
  submitImpl?: () => Promise<{ requestKey: string }>;
  isSigningTimeout?: (err: unknown) => boolean;
} = {}): {
  deps: PollAndContinueDeps;
  spies: {
    pollSpvProof: ReturnType<typeof vi.fn>;
    buildContinuationTransaction: ReturnType<typeof vi.fn>;
    submitContinuation: ReturnType<typeof vi.fn>;
  };
} {
  const pollSpvProof = vi.fn(
    opts.pollImpl ??
      (async () => opts.pollResult ?? { proof: PROOF }),
  );
  const buildContinuationTransaction = vi.fn(() => ({ cmd: 'CONT_TX' }));
  const submitContinuation = vi.fn(
    opts.submitImpl ?? (async () => ({ requestKey: CONTINUATION_KEY })),
  );
  const isSigningTimeout =
    opts.isSigningTimeout ??
    ((err: unknown) => err instanceof FakeSigningError && err.code === 'TIMEOUT');

  return {
    deps: {
      pollSpvProof: pollSpvProof as unknown as PollAndContinueDeps['pollSpvProof'],
      buildContinuationTransaction,
      submitContinuation:
        submitContinuation as unknown as PollAndContinueDeps['submitContinuation'],
      isSigningTimeout,
    },
    spies: { pollSpvProof, buildContinuationTransaction, submitContinuation },
  };
}

describe('pollProofAndContinue', () => {
  it('returns ok with the continuation request key when a proof arrives and submit succeeds', async () => {
    const { deps, spies } = makeDeps();

    const result = await pollProofAndContinue(baseParams(), deps);

    expect(result).toEqual({ ok: true, continuationKey: CONTINUATION_KEY });
    // The proof must flow into buildContinuationTransaction with NO gas-payer
    // arg (public gas-station path), then the built tx into submitContinuation.
    expect(spies.buildContinuationTransaction).toHaveBeenCalledWith(
      REQUEST_KEY,
      PROOF,
      '5',
    );
    expect(spies.submitContinuation).toHaveBeenCalledWith({ cmd: 'CONT_TX' }, '5');
  });

  it('treats a null proof as spv-timeout pending and NEVER submits a continuation', async () => {
    const { deps, spies } = makeDeps({ pollResult: { proof: null } });

    const result = await pollProofAndContinue(baseParams(), deps);

    // Null proof = bound reached / still unavailable = PENDING carrying the
    // requestKey. Re-submitting Step 0 here would double-spend gas.
    expect(result).toEqual({
      ok: false,
      reason: 'spv-timeout',
      requestKey: REQUEST_KEY,
    });
    expect(spies.submitContinuation).not.toHaveBeenCalled();
    expect(spies.buildContinuationTransaction).not.toHaveBeenCalled();
  });

  it('treats a SigningError TIMEOUT from the poll as spv-timeout pending, not a failure', async () => {
    const { deps, spies } = makeDeps({
      pollImpl: async () => {
        throw new FakeSigningError('spv proof poll timed out', 'TIMEOUT');
      },
    });

    const result = await pollProofAndContinue(baseParams(), deps);

    expect(result).toEqual({
      ok: false,
      reason: 'spv-timeout',
      requestKey: REQUEST_KEY,
    });
    expect(spies.submitContinuation).not.toHaveBeenCalled();
  });

  it('calls pollSpvProof with the bounded SPV constants and forwards onProgress', async () => {
    const onProgress = vi.fn();
    const { deps, spies } = makeDeps();

    await pollProofAndContinue(baseParams(), deps, { onProgress });

    // (requestKey, sourceChain, targetChain, SPV_MAX_ATTEMPTS=30, SPV_DELAY_MS=5000, onProgress)
    expect(spies.pollSpvProof).toHaveBeenCalledWith(
      REQUEST_KEY,
      '2',
      '5',
      30,
      5000,
      onProgress,
    );
  });

  it('maps a SigningError TIMEOUT from submitContinuation to continuation-pending (re-check, do NOT resubmit)', async () => {
    const { deps } = makeDeps({
      submitImpl: async () => {
        throw new FakeSigningError('submit timed out', 'TIMEOUT');
      },
    });

    const result = await pollProofAndContinue(baseParams(), deps);

    // A submit TIMEOUT may have committed on chain — the outcome must be
    // PENDING (re-check) and carry the requestKey, NEVER continuation-failed.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('continuation-pending');
    expect(result.requestKey).toBe(REQUEST_KEY);
  });

  it('maps a plain Error from submitContinuation to continuation-failed with the requestKey', async () => {
    const { deps } = makeDeps({
      submitImpl: async () => {
        throw new Error('node rejected continuation');
      },
    });

    const result = await pollProofAndContinue(baseParams(), deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('continuation-failed');
    expect(result.requestKey).toBe(REQUEST_KEY);
  });

  it('stops further poll attempts when the abort signal is already aborted and never submits', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, spies } = makeDeps();

    const result = await pollProofAndContinue(baseParams(), deps, {
      signal: controller.signal,
    });

    // Abort mid/pre-poll is a cancelled, non-resubmit outcome — reads are
    // idempotent so cancelling is safe, but we must NOT submit a continuation.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('spv-timeout');
    expect(spies.submitContinuation).not.toHaveBeenCalled();
  });
});
