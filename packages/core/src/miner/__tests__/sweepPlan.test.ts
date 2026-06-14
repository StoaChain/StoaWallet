import { describe, expect, it } from 'vitest';

import { STOA_CHAINS } from '@stoachain/stoa-core/constants';

import { buildSweepPlan } from '../sweepPlan';
import type { SweepBalances } from '../sweepPlan';

/**
 * `buildSweepPlan` is the PURE source-selection domain for the miner sweep: it
 * classifies the pre-scanned 10-chain balances into funded sources (EXCLUDING
 * the target), skipped chains (zero / absent / errored / the target itself),
 * and validates the self-transfer precondition (sender === receiver === the
 * active k: account). It performs NO network reads — the balances are already
 * fetched by the caller — so every assertion below drives a pure computation.
 */

const ACCOUNT_PUB = 'a'.repeat(64);
const ACCOUNT = `k:${ACCOUNT_PUB}`;

/** A fully-skipped per-chain balance set (all absent) for the active account. */
function allAbsent(): SweepBalances {
  const balances: SweepBalances = {};
  for (const chainId of STOA_CHAINS) {
    balances[chainId] = { balance: '0.0', exists: false };
  }
  return balances;
}

describe('buildSweepPlan', () => {
  it('selects only funded non-target chains as sources, skipping zero/absent/errored and the target', () => {
    // The miner picks chain 0 as the target while chain 0 is itself funded:
    // the target must be EXCLUDED from sources (never swept into itself), only
    // chain 1 (funded) sweeps, and chains 2/3/4 each carry their own skip reason.
    const balances = allAbsent();
    balances['0'] = { balance: '2.0', exists: true }; // funded but IS the target
    balances['1'] = { balance: '5.0', exists: true }; // funded source
    balances['2'] = { balance: '0.0', exists: true }; // exists, zero balance
    balances['3'] = { balance: '0.0', exists: false }; // absent
    balances['4'] = { balance: '0.0', exists: false, error: 'read failed' }; // errored

    const plan = buildSweepPlan({ balances, targetChain: '0', account: ACCOUNT });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // Only the funded non-target chain 1 is a source, swept at its FULL balance.
    expect(plan.sources).toEqual([{ chainId: '1', amount: '5.000000000000' }]);

    // Each excluded chain is surfaced with its distinct reason.
    expect(plan.skipped).toContainEqual({ chainId: '0', reason: 'is-target' });
    expect(plan.skipped).toContainEqual({ chainId: '2', reason: 'zero' });
    expect(plan.skipped).toContainEqual({ chainId: '3', reason: 'absent' });
    expect(plan.skipped).toContainEqual({ chainId: '4', reason: 'errored' });
  });

  it('classifies an errored chain as "errored" even when its balance string looks positive', () => {
    // A pre-scan error means the balance is UNKNOWN — a stale positive string must
    // NOT make it a source. Error is checked BEFORE balance (Phase-3 branch order).
    const balances = allAbsent();
    balances['7'] = { balance: '9.0', exists: true, error: 'rpc timeout' };

    const plan = buildSweepPlan({ balances, targetChain: '0', account: ACCOUNT });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.sources).toEqual([]);
    expect(plan.skipped).toContainEqual({ chainId: '7', reason: 'errored' });
  });

  it('normalizes the sweep amount to exactly 12 fixed decimals without trailing-zero magnitude corruption', () => {
    // The reference `.replace(/0+$/,"")` regex turns "10" into "1" (a 10x fund
    // corruption). The plan must emit a fixed 12-decimal string that preserves
    // integer magnitude: 5 -> "5.000000000000", 10 -> "10.000000000000".
    const balances = allAbsent();
    balances['1'] = { balance: '5', exists: true };
    balances['2'] = { balance: '10', exists: true };

    const plan = buildSweepPlan({ balances, targetChain: '0', account: ACCOUNT });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.sources).toContainEqual({ chainId: '1', amount: '5.000000000000' });
    expect(plan.sources).toContainEqual({ chainId: '2', amount: '10.000000000000' });
  });

  it('preserves fractional precision in the sweep amount up to 12 decimals', () => {
    // A fractional balance keeps its digits and is right-padded to 12 places —
    // never re-parsed through a float (which would drift the exact value).
    const balances = allAbsent();
    balances['3'] = { balance: '1.234567', exists: true };

    const plan = buildSweepPlan({ balances, targetChain: '0', account: ACCOUNT });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.sources).toContainEqual({
      chainId: '3',
      amount: '1.234567000000',
    });
  });

  it('returns a valid EMPTY plan (not an error) when every non-target chain is zero/absent/errored', () => {
    // "Nothing to aggregate" is a legitimate result the UI surfaces — never an
    // {ok:false}. The target is still recorded as skipped.
    const balances = allAbsent();
    balances['5'] = { balance: '0.0', exists: true }; // zero
    balances['6'] = { balance: '0.0', exists: false, error: 'boom' }; // errored

    const plan = buildSweepPlan({ balances, targetChain: '0', account: ACCOUNT });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.sources).toEqual([]);
    expect(plan.skipped).toContainEqual({ chainId: '0', reason: 'is-target' });
  });

  it('rejects a non-k: active account with invalid-account', () => {
    // The self-transfer sender/receiver IS the active account; a non-k: address
    // cannot be the sweep account.
    const plan = buildSweepPlan({
      balances: allAbsent(),
      targetChain: '0',
      account: `w:${ACCOUNT_PUB}:keys-all`,
    });

    expect(plan).toEqual({ ok: false, reason: 'invalid-account' });
  });

  it('rejects a k: account whose post-prefix pubkey is not 64 hex chars with invalid-account', () => {
    // classifyPaymentKey accepts ANY "k:" body length, so the 64-hex ED25519
    // pubkey shape is validated explicitly — never a blind slice(2).
    const plan = buildSweepPlan({
      balances: allAbsent(),
      targetChain: '0',
      account: 'k:abcdef',
    });

    expect(plan).toEqual({ ok: false, reason: 'invalid-account' });
  });

  it('rejects an empty active account with invalid-account', () => {
    const plan = buildSweepPlan({
      balances: allAbsent(),
      targetChain: '0',
      account: '',
    });

    expect(plan).toEqual({ ok: false, reason: 'invalid-account' });
  });

  it('rejects a target chain outside the 10 STOA_CHAINS with invalid-target', () => {
    // Chain membership comes from STOA_CHAINS (never a hardcoded range); a
    // /chain/19 selection is out of range on StoaChain.
    const plan = buildSweepPlan({
      balances: allAbsent(),
      targetChain: '19',
      account: ACCOUNT,
    });

    expect(plan).toEqual({ ok: false, reason: 'invalid-target' });
  });

  it('never lists the target chain as a source even when the target is funded', () => {
    // The target excludes itself from sources regardless of balance — sweeping a
    // chain into itself is a no-op self-transfer the plan must prevent.
    const balances = allAbsent();
    balances['2'] = { balance: '100.0', exists: true }; // target, heavily funded

    const plan = buildSweepPlan({ balances, targetChain: '2', account: ACCOUNT });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.sources.some((s) => s.chainId === '2')).toBe(false);
    expect(plan.skipped).toContainEqual({ chainId: '2', reason: 'is-target' });
  });
});
