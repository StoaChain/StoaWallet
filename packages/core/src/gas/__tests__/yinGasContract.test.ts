import { describe, expect, it } from 'vitest';

import { anuToStoaNumber, minGasPriceAnu, stoaGasMeta } from '../index';

/**
 * CONTRACT test over the Yin Engine helpers this wallet re-exports from
 * `@stoachain/stoa-core/gas`.
 *
 * The implementation is the SDK's — deliberately, so the formula cannot drift
 * between consumers — but the wallet still depends on its exact behavior to
 * price every transaction it signs. These assertions are the tripwire for a bad
 * SDK bump or a wrong version resolving: they fail loudly here rather than as
 * rejected transactions in users' hands.
 */

const YIN_GENESIS_TIME_S = 1_771_869_600; // 2026-02-23T18:00:00Z — tick 0
const GENESIS_ANU = 10_000;
const MAX_ANU = 400_000;
const INTERVAL_S = 10_800; // 3h per tick

describe('Yin Engine gas floor (contract with @stoachain/stoa-core/gas)', () => {
  it('is the genesis floor at tick 0 and clamps rather than going below it', () => {
    expect(minGasPriceAnu(YIN_GENESIS_TIME_S)).toBe(GENESIS_ANU);
    // A backdated creationTime or a skewed client clock must never price under
    // the floor — that is a consensus rejection, not a cheap transaction.
    expect(minGasPriceAnu(YIN_GENESIS_TIME_S - 1)).toBe(GENESIS_ANU);
    expect(minGasPriceAnu(0)).toBe(GENESIS_ANU);
  });

  it('adds exactly 1 ANU per 3-hour tick, flooring partial ticks', () => {
    const at = (s: number): number => YIN_GENESIS_TIME_S + s;
    expect(minGasPriceAnu(at(INTERVAL_S - 1))).toBe(GENESIS_ANU);
    expect(minGasPriceAnu(at(INTERVAL_S))).toBe(GENESIS_ANU + 1);
    expect(minGasPriceAnu(at(INTERVAL_S * 1562))).toBe(GENESIS_ANU + 1562);
  });

  it('caps at the maximum however far in the future', () => {
    const capAt = YIN_GENESIS_TIME_S + (MAX_ANU - GENESIS_ANU) * INTERVAL_S;
    expect(minGasPriceAnu(capAt)).toBe(MAX_ANU);
    expect(minGasPriceAnu(capAt + INTERVAL_S * 10_000)).toBe(MAX_ANU);
  });

  it('converts ANU to STOA by decimal placement, not a 1e-6 slip', () => {
    expect(anuToStoaNumber(1)).toBe(0.000000000001);
    expect(anuToStoaNumber(GENESIS_ANU)).toBe(0.00000001);
    expect(anuToStoaNumber(MAX_ANU)).toBe(0.0000004);
    // gasPrice must be a NUMBER: a string serializes quoted and chainweb rejects it.
    expect(typeof anuToStoaNumber(11_566)).toBe('number');
  });

  it('round-trips sampled values across the whole 10k-400k ANU range', () => {
    // The floor sweeps this entire range over the chain's lifetime; a precision
    // artifact at any tick would misprice transactions on exactly one day.
    for (let anu = GENESIS_ANU; anu <= MAX_ANU; anu += 997) {
      expect(Math.round(anuToStoaNumber(anu) * 1e12)).toBe(anu);
    }
    expect(Math.round(anuToStoaNumber(MAX_ANU) * 1e12)).toBe(MAX_ANU);
  });

  it('derives gasPrice from the SAME creationTime it returns', () => {
    const meta = stoaGasMeta();

    // The race the handoff warns about: reading the clock twice can straddle a
    // tick boundary and silently underprice the transaction.
    expect(meta.gasPrice).toBe(anuToStoaNumber(minGasPriceAnu(meta.creationTime)));
    // Backdated, so a slightly fast client clock still validates.
    expect(meta.creationTime).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('prices ABOVE the stale 1e-8 default now that the floor has risen past it', () => {
    // @kadena/client's implicit default and the old static GAS_PRICE_MIN_ANU are
    // both 1e-8. Post-fork that is below the floor and gets rejected.
    expect(stoaGasMeta().gasPrice).toBeGreaterThan(0.00000001);
  });
});
