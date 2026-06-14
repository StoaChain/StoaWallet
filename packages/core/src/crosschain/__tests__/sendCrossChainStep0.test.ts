import { describe, expect, it, vi } from 'vitest';

import { sendCrossChainStep0 } from '../sendCrossChainStep0';
import type { SendCrossChainStep0Deps } from '../sendCrossChainStep0';
import type { BuildStep0Result } from '../buildStep0';

/**
 * `sendCrossChainStep0` is the FULL step-0 orchestrator: it composes the pure
 * `buildCrossChainStep0` build with sign → submit → confirm, and returns a
 * discriminated result (never a thrown secret-bearing Error). The build, the
 * signer, the submit, and the failover-aware `listenForCompletion` are all
 * injected here so the tests stay fully offline and pin the exact composition
 * order and the money-safety branching.
 */

const SENDER_PUB = 'a'.repeat(64);
const RECEIVER_PUB = 'b'.repeat(64);
const GAS_PUB = 'f'.repeat(64);
const SENDER = `k:${SENDER_PUB}`;
const RECEIVER = `k:${RECEIVER_PUB}`;
const REQUEST_KEY = 'reqKey-from-signed-hash';

const senderKeypair = { publicKey: SENDER_PUB, privateKey: 'c'.repeat(64) };
const gasKeypair = { publicKey: GAS_PUB, privateKey: 'd'.repeat(64) };

/** A TIMEOUT-coded error: the SDK throws this from submit/listen on deadline. */
function timeoutError(): Error & { code: string } {
  const e = new Error('deadline exceeded') as Error & { code: string };
  e.code = 'TIMEOUT';
  return e;
}

/** A built (unsigned) tx whose hash the orchestrator recovers the reqKey from. */
const unsignedTx = { cmd: '{}', hash: REQUEST_KEY, sigs: [] };

function buildOk(gasMode: 'gas-station' | 'xchain-gas', signerPubs: string[]): BuildStep0Result {
  return {
    ok: true,
    tx: unsignedTx,
    receiverGuard: { keys: [RECEIVER_PUB], pred: 'keys-all' },
    gasMode,
    signerPubs,
  };
}

function makeDeps(over: Partial<SendCrossChainStep0Deps> = {}): SendCrossChainStep0Deps {
  return {
    buildStep0: vi.fn(async () => buildOk('xchain-gas', [SENDER_PUB])),
    signTransaction: vi.fn(async () => ({ ...unsignedTx, sigs: [{ sig: 'signed' }] })),
    submit: vi.fn(async () => ({ requestKey: REQUEST_KEY })),
    listen: vi.fn(async () => ({ result: { status: 'success' } })),
    isTimeout: (err: unknown) => (err as { code?: string })?.code === 'TIMEOUT',
    // No real backoff in tests — assert branching, not wall-clock waiting.
    sleep: async () => {},
    ...over,
  };
}

function chain0Input(over: Record<string, unknown> = {}) {
  return {
    sender: SENDER,
    receiver: RECEIVER,
    amount: '5.0',
    sourceChain: '0',
    targetChain: '5',
    senderPublicKey: SENDER_PUB,
    gasStationPublicKey: GAS_PUB,
    ...over,
  };
}

function chain5Input(over: Record<string, unknown> = {}) {
  return {
    sender: SENDER,
    receiver: RECEIVER,
    amount: '5.0',
    sourceChain: '5',
    targetChain: '7',
    senderPublicKey: SENDER_PUB,
    ...over,
  };
}

describe('sendCrossChainStep0 — gas-mode signing (RR#3)', () => {
  it('chain 0 (gas-station) signs with BOTH keypairs then submits and confirms', async () => {
    const deps = makeDeps({
      buildStep0: vi.fn(async () => buildOk('gas-station', [SENDER_PUB, GAS_PUB])),
    });
    const res = await sendCrossChainStep0(chain0Input(), [senderKeypair, gasKeypair], deps);

    expect(res).toEqual({ ok: true, requestKey: REQUEST_KEY, sourceChain: '0', targetChain: '5' });
    // gas-station mode routes gas through the Ouronet Gas Station cap, so BOTH
    // the sender and gas keypairs must reach the universal signer — a single
    // signer would leave the DALOS.GAS_PAYER cap unsigned and unsubmittable.
    expect(deps.signTransaction).toHaveBeenCalledTimes(1);
    const signedKeypairs = (deps.signTransaction as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(signedKeypairs).toHaveLength(2);
    expect(deps.submit).toHaveBeenCalledWith(expect.anything(), '0');
    expect(deps.listen).toHaveBeenCalledWith(REQUEST_KEY, '0');
  });

  it('chain 5 (xchain-gas) signs with ONLY the sender keypair', async () => {
    const deps = makeDeps();
    const res = await sendCrossChainStep0(chain5Input(), [senderKeypair], deps);

    expect(res).toEqual({ ok: true, requestKey: REQUEST_KEY, sourceChain: '5', targetChain: '7' });
    // Non-zero source chains pay gas via the unsigned kadena-xchain-gas account,
    // so the sender is the ONLY signer — passing a second keypair would over-sign.
    const signedKeypairs = (deps.signTransaction as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(signedKeypairs).toHaveLength(1);
    expect(deps.submit).toHaveBeenCalledWith(expect.anything(), '5');
  });
});

describe('sendCrossChainStep0 — build refusal propagation', () => {
  it('propagates a build refusal verbatim and signs/submits NOTHING', async () => {
    const deps = makeDeps({
      buildStep0: vi.fn(async () => ({ ok: false as const, reason: 'invalid-recipient' as const })),
    });
    const res = await sendCrossChainStep0(chain5Input(), [senderKeypair], deps);

    // A refused build means nothing was committed — the refuse reason must reach
    // the caller verbatim, and no key material may be signed/submitted.
    expect(res).toEqual({ ok: false, reason: 'invalid-recipient' });
    expect(deps.signTransaction).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.listen).not.toHaveBeenCalled();
  });
});

describe('sendCrossChainStep0 — submit branching (RR#1)', () => {
  it('a non-TIMEOUT, non-network submit Error → submit-failed, listen NOT called', async () => {
    const deps = makeDeps({
      submit: vi.fn(async () => {
        throw new Error('coin.TRANSFER failure: insufficient funds');
      }),
    });
    const res = await sendCrossChainStep0(chain5Input(), [senderKeypair], deps);

    // A definitive submit error means the tx did NOT land — surface submit-failed
    // and never confirm a tx that was never accepted.
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('submit-failed');
    expect(deps.listen).not.toHaveBeenCalled();
  });

  it('a submit TIMEOUT flows INTO confirm (not an immediate submit-failed)', async () => {
    const deps = makeDeps({
      submit: vi.fn(async () => {
        throw timeoutError();
      }),
    });
    const res = await sendCrossChainStep0(chain5Input(), [senderKeypair], deps);

    // A TIMEOUT means the tx MAY have landed — recover the request key from the
    // signed hash and confirm; do NOT report submit-failed and do NOT resubmit.
    expect(res).toEqual({ ok: true, requestKey: REQUEST_KEY, sourceChain: '5', targetChain: '7' });
    expect(deps.listen).toHaveBeenCalledWith(REQUEST_KEY, '5');
    expect(deps.submit).toHaveBeenCalledTimes(1);
  });
});

describe('sendCrossChainStep0 — confirm branching (RR#1/RR#2)', () => {
  it('listen result status:"failure" → step0-failed', async () => {
    const deps = makeDeps({
      listen: vi.fn(async () => ({ result: { status: 'failure', error: { message: 'on-chain revert' } } })),
    });
    const res = await sendCrossChainStep0(chain5Input(), [senderKeypair], deps);

    // A genuine on-chain failure (the listen envelope reports failure) is final:
    // step0-failed, not a pending — the burn did not commit.
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('step0-failed');
  });

  it('confirmation lost to network errors across all retries → network-lost-pending, submit NOT re-called', async () => {
    const deps = makeDeps({
      listen: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    });
    const res = await sendCrossChainStep0(chain5Input(), [senderKeypair], deps);

    // The burn MAY have confirmed on chain — we lost only the confirmation. This
    // is PENDING (use the Continue tab with the request key), NEVER a resubmit.
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('network-lost-pending');
    expect(res.requestKey).toBe(REQUEST_KEY);
    // Submit must NOT be retried — a resubmit would double-commit the burn.
    expect(deps.submit).toHaveBeenCalledTimes(1);
  });

  it('a listen TIMEOUT across all retries → network-lost-pending (never failed)', async () => {
    const deps = makeDeps({
      listen: vi.fn(async () => {
        throw timeoutError();
      }),
    });
    const res = await sendCrossChainStep0(chain5Input(), [senderKeypair], deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('network-lost-pending');
    expect(res.requestKey).toBe(REQUEST_KEY);
  });

  it('a transient listen error that then succeeds confirms ok (bounded retry)', async () => {
    let calls = 0;
    const deps = makeDeps({
      listen: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient socket reset');
        return { result: { status: 'success' } };
      }),
    });
    const res = await sendCrossChainStep0(chain5Input(), [senderKeypair], deps);

    // A single transient network blip must be absorbed by the bounded retry and
    // still confirm — not every listen throw is terminal.
    expect(res).toEqual({ ok: true, requestKey: REQUEST_KEY, sourceChain: '5', targetChain: '7' });
    expect(calls).toBe(2);
  });
});

describe('sendCrossChainStep0 — secret scrubbing', () => {
  it('scrubs a leaked private key out of a submit-failed detail', async () => {
    const deps = makeDeps({
      submit: vi.fn(async () => {
        throw new Error(`build leaked ${senderKeypair.privateKey} into the message`);
      }),
    });
    const res = await sendCrossChainStep0(chain5Input(), [senderKeypair], deps);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('submit-failed');
    // The discriminated detail must NEVER carry key material back to the caller.
    expect(res.detail ?? '').not.toContain(senderKeypair.privateKey);
  });
});
