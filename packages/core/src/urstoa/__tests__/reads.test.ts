import { describe, expect, it, vi } from 'vitest';

import { getUrStoaHoldings, getVaultTotal, VAULT_ADDRESS } from '../reads';
import type { UrStoaReadDeps } from '../reads';

const ACCOUNT =
  'k:aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';

/**
 * A deps double whose four reads are vi.fns the test can assert against. The
 * three holdings reads return precision-preserving decimal strings (or null);
 * `getUrStoaBalance` (vault total) returns a number (or null).
 */
function makeDeps(opts: {
  wallet?: string | null;
  vault?: string | null;
  claimable?: string | null;
  vaultTotal?: number | null;
  walletImpl?: (account: string) => Promise<string | null>;
  vaultImpl?: (account: string) => Promise<string | null>;
  claimableImpl?: (account: string) => Promise<string | null>;
  vaultTotalImpl?: (account: string) => Promise<number | null>;
}): {
  deps: UrStoaReadDeps;
  getWalletBalance: ReturnType<typeof vi.fn>;
  getVaultUserSupply: ReturnType<typeof vi.fn>;
  getClaimableRewards: ReturnType<typeof vi.fn>;
  getUrStoaBalance: ReturnType<typeof vi.fn>;
} {
  const getWalletBalance = vi.fn(
    opts.walletImpl ?? (async () => opts.wallet ?? null),
  );
  const getVaultUserSupply = vi.fn(
    opts.vaultImpl ?? (async () => opts.vault ?? null),
  );
  const getClaimableRewards = vi.fn(
    opts.claimableImpl ?? (async () => opts.claimable ?? null),
  );
  const getUrStoaBalance = vi.fn(
    opts.vaultTotalImpl ?? (async () => opts.vaultTotal ?? null),
  );
  return {
    deps: {
      getWalletBalance,
      getVaultUserSupply,
      getClaimableRewards,
      getUrStoaBalance,
    },
    getWalletBalance,
    getVaultUserSupply,
    getClaimableRewards,
    getUrStoaBalance,
  };
}

describe('getUrStoaHoldings', () => {
  it('composes the three authoritative coin.* reads into wallet/vault/earnings, each through its OWN seam', async () => {
    const { deps, getWalletBalance, getVaultUserSupply, getClaimableRewards } =
      makeDeps({ wallet: '100.5', vault: '40.0', claimable: '12.5' });

    const result = await getUrStoaHoldings(ACCOUNT, deps);

    // wallet ← UR_UR|Balance, vault ← UR_URV|UserSupply, claimable ← URC_URV|ClaimableRewards.
    expect(getWalletBalance).toHaveBeenCalledWith(ACCOUNT);
    expect(getVaultUserSupply).toHaveBeenCalledWith(ACCOUNT);
    expect(getClaimableRewards).toHaveBeenCalledWith(ACCOUNT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.holdings.walletBalance).toBe('100.5');
    expect(result.holdings.vaultBalance).toBe('40.0');
    expect(result.holdings.vaultEarnings).toBe('12.5');
  });

  it('preserves full-precision decimal strings (no Number round-trip drift) — a 12-decimal STOA reward stays exact', async () => {
    const { deps } = makeDeps({
      wallet: '0.001',
      vault: '1234.567',
      claimable: '9876.543210987654',
    });

    const result = await getUrStoaHoldings(ACCOUNT, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The exact string is carried through — never parsed through `Number`.
    expect(result.holdings.vaultEarnings).toBe('9876.543210987654');
    expect(result.holdings.walletBalance).toBe('0.001');
    expect(result.holdings.vaultBalance).toBe('1234.567');
  });

  it('surfaces a single failed read as null for THAT figure only (null ≠ "0"), the others standing', async () => {
    // The vault read resolved null (RPC/non-existence) while wallet + claimable
    // succeeded — the vault figure is the distinct unknown, never coerced to "0".
    const { deps } = makeDeps({ wallet: '5.0', vault: null, claimable: '0.0' });

    const result = await getUrStoaHoldings(ACCOUNT, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.holdings.walletBalance).toBe('5.0');
    expect(result.holdings.vaultBalance).toBeNull();
    expect(result.holdings.vaultEarnings).toBe('0.0');
  });

  it('returns a DISCRIMINATED read-failed result (never throws) when a read rejects', async () => {
    const { deps } = makeDeps({
      walletImpl: async () => {
        throw new Error('secret-bearing-network-failure');
      },
    });

    const result = await getUrStoaHoldings(ACCOUNT, deps);

    expect(result).toEqual({ ok: false, reason: 'read-failed' });
  });

  it('does not hardcode a node — every figure resolves through the injected (active-node) seam', async () => {
    // XP-18(a): a custom node (Phase 10 setNodeConfig) is honored because the
    // wrapper composes the injected reads, which resolve the active node
    // themselves. Asserting the wrapper calls THROUGH the seams is the testable
    // form of "custom node applies to a UrStoa read".
    const { deps, getWalletBalance, getVaultUserSupply, getClaimableRewards } =
      makeDeps({ wallet: '1.0', vault: '2.0', claimable: '3.0' });

    await getUrStoaHoldings(ACCOUNT, deps);

    expect(getWalletBalance).toHaveBeenCalledTimes(1);
    expect(getVaultUserSupply).toHaveBeenCalledTimes(1);
    expect(getClaimableRewards).toHaveBeenCalledTimes(1);
  });
});

describe('getVaultTotal', () => {
  it('reads getUrStoaBalance(VAULT_ADDRESS) and returns the total staked figure as a string', async () => {
    const { deps, getUrStoaBalance } = makeDeps({ vaultTotal: 5000 });

    const result = await getVaultTotal(deps);

    expect(getUrStoaBalance).toHaveBeenCalledWith(VAULT_ADDRESS);
    expect(VAULT_ADDRESS).toBe('c:GjYbBFM0vxMs5FcmnFUW-LFoycd3Ef8wuP28vR6FG3k');
    expect(result).toEqual({ ok: true, vaultTotal: '5000' });
  });

  it('maps a getUrStoaBalance null to a DISTINCT unknown state — NOT a coerced "0"', async () => {
    // bug-F-001 fail-closed: null = "doesn't exist OR RPC error". Coercing to 0
    // would let T12.7 lift the last-staker floor and allow a full-drain unstake.
    const { deps } = makeDeps({ vaultTotal: null });

    const result = await getVaultTotal(deps);

    expect(result).toEqual({ ok: false, reason: 'unknown' });
    if (result.ok) return;
    expect((result as { vaultTotal?: unknown }).vaultTotal).toBeUndefined();
  });

  it('returns read-failed (never throws) when getUrStoaBalance rejects', async () => {
    const { deps } = makeDeps({
      vaultTotalImpl: async () => {
        throw new Error('secret-bearing-network-failure');
      },
    });

    const result = await getVaultTotal(deps);

    expect(result).toEqual({ ok: false, reason: 'read-failed' });
  });
});
