import { describe, expect, it } from 'vitest';

import { signerSetForSameChain } from '../gasPayerSigner';

/**
 * For a k:->k' same-chain send THIS phase, the sender's own wallet key is the
 * single signer for BOTH the gas-payer cap and the coin.TRANSFER cap. This test
 * pins that the signing SET is exactly the sender's keypair — one signer, not a
 * multi-guard selection (selectCapsSigningKey is Phase-6-deferred).
 */

describe('signerSetForSameChain', () => {
  it('returns exactly the sender keypair as the signing set for a same-chain send', () => {
    const senderKeypair = { publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(64) };

    const set = signerSetForSameChain(senderKeypair);

    // The XP-2 signingKeypairs[] set for k:->k' is [senderKeypair] — one
    // signer, no codex/gas-payer second key this phase.
    expect(set).toEqual([senderKeypair]);
    expect(set).toHaveLength(1);
    expect(set[0]).toBe(senderKeypair);
  });
});
