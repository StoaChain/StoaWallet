import { describe, expect, it, vi } from 'vitest';

import {
  getUrStoaHoldings,
  getVaultTotal,
  VAULT_ADDRESS,
} from '../reads';
import type { UrStoaReadDeps } from '../reads';

const ACCOUNT =
  'k:aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';

/**
 * A realistic Primordials selector row that includes BOTH the UrStoa-relevant
 * fields AND the out-of-scope wrapped-* fields, so the wrapped exclusion is
 * provable. Mirrors the OuronetUI keying (`payment-key-balance`, etc.); the
 * earnings arrives as a Pact `{ decimal }` envelope (the Collect-disabled bug
 * vector if rendered with `String()`).
 */
function primordialsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'payment-key-balance': '100.5',
    'urstoa-vault-balance': '40.0',
    'urstoa-vault-earnings': { decimal: '12.5' },
    'urstoa-vault-stoa-supply': '9000.0',
    'wrapped-balance': '7.0',
    'wrapped-id': 'abc-wrapped-id',
    'urstoa-wrapped-balance': '7.0',
    ...overrides,
  };
}

/** A deps double whose two reads are vi.fns the test can assert against. */
function makeDeps(opts: {
  primordials?: unknown;
  vaultBalance?: number | null;
  primordialsImpl?: () => Promise<unknown>;
  vaultImpl?: (account: string) => Promise<number | null>;
}): { deps: UrStoaReadDeps; getPrimordials: ReturnType<typeof vi.fn>; getUrStoaBalance: ReturnType<typeof vi.fn> } {
  const getPrimordials = vi.fn(
    opts.primordialsImpl ?? (async () => opts.primordials),
  );
  const getUrStoaBalance = vi.fn(
    opts.vaultImpl ?? (async () => opts.vaultBalance ?? null),
  );
  return { deps: { getPrimordials, getUrStoaBalance }, getPrimordials, getUrStoaBalance };
}

describe('getUrStoaHoldings', () => {
  it('maps the Primordials row to walletBalance/vaultBalance/vaultEarnings and EXCLUDES every wrapped-* field', async () => {
    const { deps, getPrimordials } = makeDeps({ primordials: primordialsRow() });

    const result = await getUrStoaHoldings(ACCOUNT, deps);

    // The read composes getPrimordials with the active account.
    expect(getPrimordials).toHaveBeenCalledWith(ACCOUNT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.holdings.walletBalance).toBe('100.5');
    expect(result.holdings.vaultBalance).toBe('40.0');
    expect(result.holdings.vaultStoaSupply).toBe('9000.0');

    // The holdings shape NEVER surfaces wrapped-balance / wrapped-id (or the
    // urstoa-wrapped-balance variant) — those are out of scope.
    const surfaced = JSON.stringify(result.holdings);
    expect(surfaced).not.toContain('wrapped');
    expect(surfaced).not.toContain('abc-wrapped-id');
    expect('wrappedBalance' in result.holdings).toBe(false);
    expect('wrappedId' in result.holdings).toBe(false);
  });

  it('unwraps the {decimal} earnings envelope via the SDK helper to "12.5" — NOT "[object Object]"', async () => {
    const { deps } = makeDeps({
      primordials: primordialsRow({ 'urstoa-vault-earnings': { decimal: '12.5' } }),
    });

    const result = await getUrStoaHoldings(ACCOUNT, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The Collect-disabled bug: String({decimal:...}) yields "[object Object]"
    // and a non-zero earnings would read as zero/garbage. The SDK unwrap peels it.
    expect(result.holdings.vaultEarnings).toBe('12.5');
    expect(result.holdings.vaultEarnings).not.toBe('[object Object]');
  });

  it('passes a plain-string earnings through unchanged (no {decimal} envelope)', async () => {
    const { deps } = makeDeps({
      primordials: primordialsRow({ 'urstoa-vault-earnings': '3.0' }),
    });

    const result = await getUrStoaHoldings(ACCOUNT, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.holdings.vaultEarnings).toBe('3.0');
  });

  it('returns a DISCRIMINATED read-failed result (never throws) when getPrimordials rejects', async () => {
    const { deps } = makeDeps({
      primordialsImpl: async () => {
        throw new Error('secret-bearing-network-failure');
      },
    });

    const result = await getUrStoaHoldings(ACCOUNT, deps);

    expect(result).toEqual({ ok: false, reason: 'read-failed' });
  });

  it('returns read-failed when getPrimordials resolves null (Pact/network error contract)', async () => {
    const { deps } = makeDeps({ primordials: null });

    const result = await getUrStoaHoldings(ACCOUNT, deps);

    expect(result).toEqual({ ok: false, reason: 'read-failed' });
  });

  it('does not hardcode a node — the read resolves through the injected (active-node) seam', async () => {
    // XP-18(a): a custom node (Phase 10 setNodeConfig) is honored because the
    // wrapper composes the injected SDK reads, which resolve the active node
    // themselves. Asserting the wrapper calls THROUGH the seam (not a hardcoded
    // path) is the testable form of "custom node applies to a UrStoa read".
    const { deps, getPrimordials } = makeDeps({ primordials: primordialsRow() });

    await getUrStoaHoldings(ACCOUNT, deps);

    expect(getPrimordials).toHaveBeenCalledTimes(1);
    expect(getPrimordials).toHaveBeenCalledWith(ACCOUNT);
  });
});

describe('getVaultTotal', () => {
  it('reads getUrStoaBalance(VAULT_ADDRESS) and returns the total staked figure as a string', async () => {
    const { deps, getUrStoaBalance } = makeDeps({ vaultBalance: 5000 });

    const result = await getVaultTotal(deps);

    expect(getUrStoaBalance).toHaveBeenCalledWith(VAULT_ADDRESS);
    expect(VAULT_ADDRESS).toBe('c:GjYbBFM0vxMs5FcmnFUW-LFoycd3Ef8wuP28vR6FG3k');
    expect(result).toEqual({ ok: true, vaultTotal: '5000' });
  });

  it('maps a getUrStoaBalance null to a DISTINCT unknown state — NOT a coerced "0"', async () => {
    // bug-F-001 fail-closed: null = "doesn't exist OR RPC error". Coercing to 0
    // would let T12.7 lift the last-staker floor and allow a full-drain unstake.
    const { deps } = makeDeps({ vaultBalance: null });

    const result = await getVaultTotal(deps);

    expect(result).toEqual({ ok: false, reason: 'unknown' });
    if (result.ok) return;
    expect((result as { vaultTotal?: unknown }).vaultTotal).toBeUndefined();
  });

  it('returns read-failed (never throws) when getUrStoaBalance rejects', async () => {
    const { deps } = makeDeps({
      vaultImpl: async () => {
        throw new Error('secret-bearing-network-failure');
      },
    });

    const result = await getVaultTotal(deps);

    expect(result).toEqual({ ok: false, reason: 'read-failed' });
  });
});
