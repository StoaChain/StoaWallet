import { describe, expect, it } from 'vitest';

import { Pact } from '@stoachain/kadena-stoic-legacy/client';

import { signTx } from '../sign';

/**
 * Build a minimal unsigned koala-key transaction with a single signer. A
 * 64-char raw Ed25519 secret routes the SDK's universalSign through the nacl
 * path (no password / WASM needed), which keeps this test self-contained: no
 * network, no wallet decryption.
 */
function makeKoalaKeypair() {
  // Deterministic non-secret 64-char hex test private key (koala/nacl path).
  const privateKey = 'a'.repeat(64);
  return { privateKey, seedType: 'koala' as const };
}

function makeUnsignedTx(publicKey: string) {
  return Pact.builder
    .execution('(coin.details "k:abc")')
    .addSigner(publicKey)
    .setMeta({ chainId: '0', senderAccount: `k:${publicKey}` })
    .setNetworkId('testnet04')
    .createTransaction();
}

describe('signTx', () => {
  it('attaches a non-empty signature to the unsigned transaction', async () => {
    const kp = makeKoalaKeypair();
    // Derive the public key the SDK expects so the signer entry matches.
    const { publicKeyFromPrivateKey } = await import(
      '@stoachain/stoa-core/signing'
    );
    const publicKey = publicKeyFromPrivateKey(kp.privateKey);

    const unsigned = makeUnsignedTx(publicKey);
    expect(unsigned.sigs.every((s: { sig?: string } | undefined) => s == null || s.sig == null)).toBe(
      true,
    );

    const signed = await signTx(unsigned, { ...kp, publicKey });

    // The signature slot is now populated and is a 128-char hex Ed25519 sig.
    expect(signed.sigs).toHaveLength(1);
    expect(signed.sigs[0]?.sig).toMatch(/^[0-9a-f]{128}$/);
  });

  it('preserves the original command payload (signing does not mutate the tx body)', async () => {
    const kp = makeKoalaKeypair();
    const { publicKeyFromPrivateKey } = await import(
      '@stoachain/stoa-core/signing'
    );
    const publicKey = publicKeyFromPrivateKey(kp.privateKey);
    const unsigned = makeUnsignedTx(publicKey);

    const signed = await signTx(unsigned, { ...kp, publicKey });

    expect(signed.cmd).toBe(unsigned.cmd);
  });
});
