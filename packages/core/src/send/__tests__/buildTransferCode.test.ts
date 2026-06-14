import { describe, expect, it } from 'vitest';

import { KADENA_NAMESPACE } from '@stoachain/ouronet-core/constants';

import { buildTransferCode, formatStoaAmount } from '../buildTransferCode';

const SENDER = 'k:aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
const RECIPIENT = 'k:1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777888899990000';
const RECIPIENT_PUBKEY = '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777888899990000';

describe('formatStoaAmount', () => {
  it('appends ".0" to a bare integer so "5" becomes a valid Pact decimal literal', () => {
    // A Pact decimal MUST contain a decimal point; "5" alone is parsed as an
    // integer and the coin contract rejects it.
    expect(formatStoaAmount('5')).toBe('5.0');
  });

  it('keeps the magnitude of trailing-zero integers — "10" must stay "10.0", never "1.0"', () => {
    // The reference regex .replace(/0+$/,"") strips the trailing zero of "10"
    // turning it into "1" — a 10x fund-corruption bug. Guard against any port
    // of that logic.
    expect(formatStoaAmount('10')).toBe('10.0');
    expect(formatStoaAmount('100')).toBe('100.0');
    expect(formatStoaAmount('1000')).toBe('1000.0');
  });

  it('trims redundant fractional trailing zeros but keeps at least one fraction digit', () => {
    expect(formatStoaAmount('1.10')).toBe('1.1');
    expect(formatStoaAmount('1.100000')).toBe('1.1');
    expect(formatStoaAmount('5.00')).toBe('5.0');
  });

  it('preserves full 12-digit fractional precision without float drift', () => {
    // Number(...).toFixed(12) round-trips through a float and loses the exact
    // value; string normalization must keep every digit.
    expect(formatStoaAmount('0.000000000001')).toBe('0.000000000001');
    expect(formatStoaAmount('99999.000000000001')).toBe('99999.000000000001');
  });

  it('rejects more than 12 fractional digits rather than silently truncating', () => {
    expect(() => formatStoaAmount('0.0000000000001')).toThrow();
  });

  it('rejects NaN, empty, and negative amounts', () => {
    expect(() => formatStoaAmount('')).toThrow();
    expect(() => formatStoaAmount('abc')).toThrow();
    expect(() => formatStoaAmount('-5')).toThrow();
  });
});

describe('buildTransferCode — existing recipient', () => {
  const result = buildTransferCode({
    sender: SENDER,
    recipient: RECIPIENT,
    amount: '5',
    isNewAccount: false,
  });

  it('emits the customized coin.C_Transfer verb with the normalized amount', () => {
    expect(result.pactCode).toBe(`(coin.C_Transfer "${SENDER}" "${RECIPIENT}" 5.0)`);
  });

  it('uses an empty payload for an existing account (no keyset to read)', () => {
    expect(result.payloadJson).toBe('{}');
  });

  it('emits exactly two caps: the GAS_PAYER cap then the coin.TRANSFER cap', () => {
    expect(result.caps).toHaveLength(2);
    expect(result.caps[0]).toBe(`(${KADENA_NAMESPACE}.DALOS.GAS_PAYER "" 0 0.0)`);
    expect(result.caps[1]).toBe(`(coin.TRANSFER "${SENDER}" "${RECIPIENT}" 5.0)`);
  });

  it('uses the SAME normalized amount string in the cap and the pact code', () => {
    const r = buildTransferCode({ sender: SENDER, recipient: RECIPIENT, amount: '10', isNewAccount: false });
    expect(r.pactCode).toContain(' 10.0)');
    expect(r.caps[1]).toContain(' 10.0)');
  });

  it('never emits the vanilla coin.transfer / coin.transfer-create verbs', () => {
    expect(result.pactCode).not.toMatch(/coin\.transfer\b/);
    expect(result.pactCode).not.toMatch(/coin\.transfer-create\b/);
  });
});

describe('buildTransferCode — new recipient', () => {
  const result = buildTransferCode({
    sender: SENDER,
    recipient: RECIPIENT,
    amount: '0.000000000001',
    isNewAccount: true,
  });

  it('emits coin.C_TransferAnew with a (read-keyset "ks") guard argument', () => {
    expect(result.pactCode).toBe(
      `(coin.C_TransferAnew "${SENDER}" "${RECIPIENT}" (read-keyset "ks") 0.000000000001)`,
    );
  });

  it('builds the keyset payload from the RECIPIENT pubkey with pred keys-all', () => {
    // The receiver keyset must guard the receiver, not the sender; using the
    // sender pubkey would create an account the recipient cannot control.
    expect(JSON.parse(result.payloadJson)).toEqual({
      ks: { keys: [RECIPIENT_PUBKEY], pred: 'keys-all' },
    });
  });

  it('reads the GAS_PAYER namespace from the ouronet-ns constant, not a hardcode', () => {
    expect(KADENA_NAMESPACE).toBe('ouronet-ns');
    expect(result.caps[0]).toBe('(ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)');
  });
});

describe('buildTransferCode — malformed input', () => {
  it('rejects a recipient without the k: prefix instead of slicing a real char off', () => {
    // Slicing the first two chars of a non-k: address would corrupt the
    // keyset pubkey; reject loudly so the caller fixes the address.
    expect(() =>
      buildTransferCode({
        sender: SENDER,
        recipient: '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777888899990000',
        amount: '1.0',
        isNewAccount: true,
      }),
    ).toThrow();
  });
});
