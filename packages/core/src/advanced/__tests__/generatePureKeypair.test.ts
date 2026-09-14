import { describe, expect, it } from 'vitest';

import { generatePureKeypair, validatePastedKey } from '../index';

describe('generatePureKeypair — the pact -g equivalent', () => {
  it('returns a 64-hex Ed25519 public key and private key', () => {
    const kp = generatePureKeypair();

    expect(kp.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.privateKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a private key that derives back to its own public key', () => {
    const kp = generatePureKeypair();

    // Saving a generated key goes through the SAME validation as a pasted one,
    // so a generator whose halves did not match would be refused on save.
    expect(validatePastedKey(kp.privateKey, [kp.publicKey])).toEqual({
      ok: true,
      publicKey: kp.publicKey,
    });
  });

  it('never returns the same keypair twice', () => {
    const a = generatePureKeypair();
    const b = generatePureKeypair();

    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});
