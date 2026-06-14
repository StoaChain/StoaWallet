import { describe, expect, it, vi } from 'vitest';

import { sendCrossChain } from '../send';

/**
 * `sendCrossChain` is THIN step-1 orchestration this phase: it wires the SDK's
 * cross-chain build/sign/submit helpers and does NOT reimplement continuation
 * logic. The FULL same-chain gasless flow (validate → existence → simulate →
 * auto-gas → sign(SET) → submit, with a discriminated result) is exercised in
 * `send/__tests__/sendSameChain.test.ts`, not here.
 */

describe('sendCrossChain', () => {
  it('runs step 1 (build/sign/submit) and returns the source-chain descriptor', async () => {
    const built = { cmd: 'XCHAIN_BUILT' };
    const signed = { cmd: 'XCHAIN_SIGNED' };
    const descriptor = { requestKey: 'rk-x', chainId: '0' };

    const buildTransfer = vi.fn((_params: Record<string, unknown>) => built);
    const sign = vi.fn(async () => signed);
    const submit = vi.fn(async () => descriptor);

    const result = await sendCrossChain(
      {
        sender: 'k:sender',
        receiver: 'k:receiver',
        receiverGuard: { keys: ['receiver'], pred: 'keys-all' },
        amount: '2.25',
        sourceChain: '0',
        targetChain: '3',
        senderPublicKey: 'sender',
      },
      { keypair: { publicKey: 'sender', privateKey: 'a'.repeat(64) } },
      { buildTransfer, sign, submit },
    );

    expect(buildTransfer).toHaveBeenCalledOnce();
    expect(sign).toHaveBeenCalledWith(built, expect.anything());
    // Step-1 submit goes to the SOURCE chain — the continuation (step 2) on the
    // target chain is a later-phase flow, deliberately not wired here.
    expect(submit).toHaveBeenCalledWith(signed, '0');
    expect(result).toBe(descriptor);

    // The amount is normalized through the string-preserving `formatStoaAmount`
    // (NOT the banned Number().toFixed float path), so "2.25" stays "2.25" —
    // no float drift and no fake trailing zeros padded to 12 places.
    expect(buildTransfer.mock.calls[0][0]).toMatchObject({
      amount: '2.25',
      sourceChain: '0',
      targetChain: '3',
    });
  });
});
