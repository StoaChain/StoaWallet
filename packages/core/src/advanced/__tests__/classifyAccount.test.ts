import { describe, expect, it } from 'vitest';

import { classifyAccount } from '../classifyAccount';

const HEX64 = 'a'.repeat(64);

describe('classifyAccount', () => {
  it('classifies a k:<64-hex> address as a k-account with the pubkey derived from the address (no fetch)', () => {
    // A k-account carries its pubkey inline: the 64-hex after "k:" IS the public key,
    // so signing-capability resolution needs no on-chain guard fetch.
    const result = classifyAccount(`k:${HEX64}`);

    expect(result).toEqual({ type: 'k-account', pubkey: HEX64 });
  });

  it('classifies a w: multi-key reference as a custom-account with null pubkey (guard fetch required)', () => {
    // w:/r:/c:/u:/named accounts do not expose a single derivable pubkey; the wrapper
    // must report null so callers know a guard fetch is needed before signing.
    const result = classifyAccount(`w:${HEX64}:keys-all`);

    expect(result).toEqual({ type: 'custom-account', pubkey: null });
  });

  it('classifies an r: role reference as a custom-account with null pubkey', () => {
    const result = classifyAccount('r:treasury-role');

    expect(result).toEqual({ type: 'custom-account', pubkey: null });
  });

  it('classifies c: and u: principal accounts as custom-account with null pubkey', () => {
    // c: (capability) and u: (user-guard) principals encode the pubkey indirectly,
    // so neither yields a directly-derivable pubkey.
    expect(classifyAccount(`c:${HEX64}`)).toEqual({
      type: 'custom-account',
      pubkey: null,
    });
    expect(classifyAccount(`u:${HEX64}`)).toEqual({
      type: 'custom-account',
      pubkey: null,
    });
  });

  it('maps null/empty input to a distinct invalid outcome instead of throwing', () => {
    // classifyPaymentKey returns null only for null/empty input; the wrapper must
    // surface that as a typed { ok:false } result so callers branch on it without try/catch.
    for (const bad of [null, '']) {
      const result = classifyAccount(bad);
      expect(result).toEqual({ ok: false, reason: 'invalid-address' });
    }
  });

  it('treats a bare named string as a valid custom-account, not an invalid outcome', () => {
    // The SDK reserves the invalid outcome for null/empty only; an arbitrary name
    // like "treasury" is a legitimate named account and must classify, not reject.
    const result = classifyAccount('treasury');

    expect(result).toEqual({ type: 'custom-account', pubkey: null });
  });
});
