import { describe, expect, it } from 'vitest';

import {
  aggregateTotal,
  classifyChainBalance,
  type ChainBalanceStatus,
} from '../balanceModel';

describe('classifyChainBalance', () => {
  it('maps exists:false with no error to absent (account row missing, not a read failure)', () => {
    const status = classifyChainBalance(3, { balance: '0', exists: false });
    expect(status).toEqual<ChainBalanceStatus>({ kind: 'absent', chainId: 3 });
  });

  it('maps exists:false WITH an error to errored, proving error precedence over the absent branch', () => {
    const status = classifyChainBalance(7, {
      balance: '0',
      exists: false,
      error: 'timeout',
    });
    // An errored read must never be presented as an absent (or zero) account.
    expect(status).toEqual<ChainBalanceStatus>({
      kind: 'errored',
      chainId: 7,
      error: 'timeout',
    });
  });

  it('maps exists:true with a zero balance to zero, carrying the display balance', () => {
    const status = classifyChainBalance(0, { balance: '0', exists: true });
    expect(status).toEqual<ChainBalanceStatus>({
      kind: 'zero',
      chainId: 0,
      balance: '0',
    });
  });

  it('maps exists:true with a positive balance to funded, carrying the display balance', () => {
    const status = classifyChainBalance(5, { balance: '5.5', exists: true });
    expect(status).toEqual<ChainBalanceStatus>({
      kind: 'funded',
      chainId: 5,
      balance: '5.5',
    });
  });

  it('treats a present error as errored even when exists:true (error is checked first)', () => {
    const status = classifyChainBalance(2, {
      balance: '0',
      exists: true,
      error: 'node 500',
    });
    expect(status).toEqual<ChainBalanceStatus>({
      kind: 'errored',
      chainId: 2,
      error: 'node 500',
    });
  });
});

describe('aggregateTotal', () => {
  it('sums only exists:true chains, counts them, and surfaces errored chains separately', () => {
    const result = aggregateTotal([
      { balance: '1.5', exists: true }, // funded -> summed
      { balance: '0', exists: true }, // zero -> summed (contributes 0)
      { balance: '0', exists: false }, // absent -> excluded, not errored
      { balance: '0', exists: false, error: 'timeout' }, // errored -> excluded, surfaced
    ]);

    expect(result.total).toBe('1.500000000000');
    // Only the two exists:true rows are included in the sum.
    expect(result.includedChains).toBe(2);
    // The errored row is surfaced, never silently counted as zero.
    expect(result.erroredChains).toBe(1);
  });

  it('holds 12-decimal precision for the smallest representable unit', () => {
    const result = aggregateTotal([{ balance: '0.000000000001', exists: true }]);
    expect(result.total).toBe('0.000000000001');
    expect(result.includedChains).toBe(1);
    expect(result.erroredChains).toBe(0);
  });

  it('sums ten 12-decimal addends with no float drift in the low digits (BigInt scaling)', () => {
    // Ten of the smallest unit must sum to exactly 0.000000000010, which a
    // Number sum + toFixed(12) cannot guarantee because of binary float drift.
    const tiny = Array.from({ length: 10 }, () => ({
      balance: '0.000000000001',
      exists: true,
    }));
    const result = aggregateTotal(tiny);
    expect(result.total).toBe('0.000000000010');
    expect(result.includedChains).toBe(10);
  });

  it('sums a mix of large and fractional values across 10 chains preserving exact low digits', () => {
    const results = [
      { balance: '123456789.123456789123', exists: true },
      { balance: '0.000000000007', exists: true },
      { balance: '999999999.999999999999', exists: true },
      { balance: '0.1', exists: true },
      { balance: '5', exists: true },
      { balance: '0', exists: true },
      { balance: '0', exists: false }, // absent
      { balance: '0', exists: false, error: 'boom' }, // errored
      { balance: '42.000000000042', exists: true },
      { balance: '0.000000000001', exists: true },
    ];
    const result = aggregateTotal(results);

    // 123456789.123456789123
    // +         0.000000000007
    // + 999999999.999999999999
    // +         0.1
    // +         5
    // +         0
    // +        42.000000000042
    // +         0.000000000001
    // = 1123456836.223456789172
    expect(result.total).toBe('1123456836.223456789172');
    expect(result.includedChains).toBe(8);
    expect(result.erroredChains).toBe(1);
  });

  it('returns a zero total when every chain is absent or errored', () => {
    const result = aggregateTotal([
      { balance: '0', exists: false },
      { balance: '0', exists: false, error: 'x' },
    ]);
    expect(result.total).toBe('0.000000000000');
    expect(result.includedChains).toBe(0);
    expect(result.erroredChains).toBe(1);
  });

  it('clamps balances with more than 12 fractional digits by truncating to 12', () => {
    // Extra precision beyond 12 decimals is dropped, not rounded up.
    const result = aggregateTotal([
      { balance: '1.0000000000019', exists: true },
    ]);
    expect(result.total).toBe('1.000000000001');
  });
});
