import { describe, expect, it } from 'vitest';

import { parseCapabilityLine } from '../sendSameChain.live';

/**
 * `parseCapabilityLine` turns a Pact-code capability line into the structured
 * `{ name, args }` the @kadena/client `withCapability(name, ...args)` builder
 * needs. The same-chain submit failure was caused by NOT doing this — the whole
 * Pact-code string was passed as the cap name with no args, so the real
 * coin.TRANSFER / DALOS.GAS_PAYER caps were never granted (simulation ignores
 * caps, so only submit failed). These tests pin the exact parse the working
 * OuronetUI reference performs.
 */
describe('parseCapabilityLine', () => {
  it('parses the GAS_PAYER cap: empty-string + integer 0 + decimal 0.0', () => {
    const parsed = parseCapabilityLine('(ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)');
    expect(parsed).toEqual({
      name: 'ouronet-ns.DALOS.GAS_PAYER',
      args: ['', { int: 0 }, { decimal: '0.0' }],
    });
  });

  it('parses coin.TRANSFER: two k: accounts as strings + the amount as a Pact decimal', () => {
    const sender = 'k:aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
    const recipient = 'k:bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
    const parsed = parseCapabilityLine(
      `(coin.TRANSFER "${sender}" "${recipient}" 0.25)`,
    );
    expect(parsed).toEqual({
      name: 'coin.TRANSFER',
      args: [sender, recipient, { decimal: '0.25' }],
    });
  });

  it('keeps a whole-integer-amount decimal (e.g. 10.0) typed as a Pact decimal, not an int', () => {
    // formatStoaAmount always emits a dot ("10" -> "10.0"); the cap arg must stay
    // a decimal so a 10-STOA transfer cap is never mis-typed as integer 10.
    const parsed = parseCapabilityLine('(coin.TRANSFER "k:a" "k:b" 10.0)');
    expect(parsed?.args[2]).toEqual({ decimal: '10.0' });
  });

  it('parses a bare qualified capability name with no args', () => {
    expect(parseCapabilityLine('coin.GAS')).toEqual({ name: 'coin.GAS', args: [] });
    expect(parseCapabilityLine('(coin.GAS)')).toEqual({ name: 'coin.GAS', args: [] });
  });

  it('returns null for an empty or unparseable line', () => {
    expect(parseCapabilityLine('')).toBeNull();
    expect(parseCapabilityLine('   ')).toBeNull();
    expect(parseCapabilityLine('not-a-cap')).toBeNull();
  });
});
