import { describe, expect, it } from 'vitest';

import { formatUrStoaAmount, unwrapDecimal, URSTOA_DECIMALS } from '../amount';

describe('formatUrStoaAmount', () => {
  it('renders an integer as a Pact decimal literal that always carries a decimal point', () => {
    // Pact lexes "5" as integer and rejects it where a decimal is expected;
    // the executor amount must lex as decimal, so it must contain a dot.
    expect(formatUrStoaAmount('5')).toBe('5.0');
  });

  it('never strips an integer trailing zero — "10" stays "10.0", NOT the "10"->"1" fund-corruption bug', () => {
    // The mandated SDK formatter preserves magnitude: it appends ".0" to make
    // an integer lex as decimal and does NOT run the forbidden
    // `.replace(/0+$/,...)` that turned "10" into "1". A fractional trailing
    // zero ("1.50") is likewise preserved verbatim — still a valid, injection-
    // safe Pact decimal literal, semantically identical on-chain to "1.5".
    expect(formatUrStoaAmount('10')).toBe('10.0');
    expect(formatUrStoaAmount('1.50')).toBe('1.50');
  });

  it('preserves a 3-decimal value verbatim (UrStoa is a 3-decimal token)', () => {
    expect(formatUrStoaAmount('1.234')).toBe('1.234');
  });

  it('truncates beyond 3 fractional digits rather than rounding (the 4th digit is dropped)', () => {
    expect(URSTOA_DECIMALS).toBe(3);
    // 4+ fractional digits -> truncated to 3; the trailing "9" is discarded, NOT
    // rounded up (truncation, never rounding — no silent magnitude change).
    expect(formatUrStoaAmount('1.2349')).toBe('1.234');
    expect(formatUrStoaAmount('0.999999')).toBe('0.999');
  });

  it('rejects malicious Pact-code injection instead of interpolating it raw', () => {
    // A field that smuggles Pact code must throw, never be embedded verbatim.
    expect(() => formatUrStoaAmount('1.0) (coin.C_UR|Transfer "a" "b" 999.0')).toThrow();
    expect(() => formatUrStoaAmount('5; rm -rf')).toThrow();
  });
});

describe('unwrapDecimal', () => {
  it('unwraps a Pact { decimal: "1.5" } envelope to its string value (never "[object Object]")', () => {
    const result = unwrapDecimal({ decimal: '1.5' });
    expect(result).toBe('1.5');
    expect(result).not.toBe('[object Object]');
  });

  it('unwraps { decimal: "0" } to "0" rather than stringifying the whole object', () => {
    expect(unwrapDecimal({ decimal: '0' })).toBe('0');
  });

  it('passes a plain number 0 through UNCHANGED — not stringified to "0" by String(obj)', () => {
    // RR#7: mayComeWithDeimal returns the value unchanged; a numeric 0 must
    // stay the number 0, proving we did not route it through String().
    const result = unwrapDecimal(0);
    expect(result).toBe(0);
    expect(typeof result).toBe('number');
  });

  it('passes a plain string through unchanged', () => {
    expect(unwrapDecimal('62.5')).toBe('62.5');
  });

  it('unwraps the urstoa-vault-earning { decimal } figure to a display value, never "[object Object]"', () => {
    const earning = { decimal: '123.456' };
    expect(unwrapDecimal(earning)).toBe('123.456');
    expect(String(unwrapDecimal(earning))).not.toBe('[object Object]');
  });
});
