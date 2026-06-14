import { describe, expect, it, vi } from 'vitest';

import { STOA_CHAINS } from '@stoachain/stoa-core/constants';

import { getBalances } from '../balances';

const ACCOUNT = 'k:abc123';

describe('getBalances', () => {
  it('iterates exactly the 10 StoaChain chains, never a hardcoded count', async () => {
    // The chain set is the single source of truth — assert it is 10 here so a
    // future chain-count change is caught by this test, not silently wrong.
    expect(STOA_CHAINS).toHaveLength(10);

    const read = vi.fn(async (_account: string, _chainId: string) => ({
      balance: '0.0',
      exists: false as const,
    }));

    const result = await getBalances(ACCOUNT, { getBalanceOnChain: read });

    expect(read).toHaveBeenCalledTimes(STOA_CHAINS.length);
    // Each configured chain was queried exactly once, with the right account.
    for (const chainId of STOA_CHAINS) {
      expect(read).toHaveBeenCalledWith(ACCOUNT, chainId);
    }
    expect(Object.keys(result)).toHaveLength(STOA_CHAINS.length);
  });

  it('preserves the absent-vs-zero discriminator per chain', async () => {
    // Chain 0 exists with a real balance; chain 1 exists but is zero; chain 2
    // does not exist at all. All three are distinct states the UI must show.
    const read = vi.fn(async (_account: string, chainId: string) => {
      if (chainId === '0') return { balance: '12.500000000000', exists: true };
      if (chainId === '1') return { balance: '0.0', exists: true };
      return { balance: '0.0', exists: false };
    });

    const result = await getBalances(ACCOUNT, { getBalanceOnChain: read });

    expect(result['0']).toMatchObject({ balance: '12.500000000000', exists: true });
    expect(result['1']).toMatchObject({ balance: '0.0', exists: true });
    expect(result['2']).toMatchObject({ exists: false });
  });

  it('isolates a single failing chain: the other nine still return', async () => {
    // Chain 5 throws (simulated network failure). With per-chain isolation via
    // Promise.allSettled, the other nine chains must still resolve — one bad
    // node cannot blank the whole balances view.
    const read = vi.fn(async (_account: string, chainId: string) => {
      if (chainId === '5') throw new Error('node unreachable on chain 5');
      return { balance: '1.0', exists: true };
    });

    const result = await getBalances(ACCOUNT, { getBalanceOnChain: read });

    // All ten keys present despite the failure.
    expect(Object.keys(result)).toHaveLength(STOA_CHAINS.length);
    // The failed chain surfaces its error, not a thrown rejection.
    expect(result['5'].error).toMatch(/unreachable/i);
    // The other nine are intact.
    for (const chainId of STOA_CHAINS) {
      if (chainId === '5') continue;
      expect(result[chainId]).toMatchObject({ balance: '1.0', exists: true });
      expect(result[chainId].error).toBeUndefined();
    }
  });
});
