import { describe, expect, it, vi } from 'vitest';

import { fetchAccountGuard } from '../fetchAccountGuard';
import type { GuardReadDeps, DirtyReadResult } from '../fetchAccountGuard';

const ADDRESS =
  'k:aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
const KEY_A = 'aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
const KEY_B = '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777888899990000';

/** A `coin.details` success whose `data` is the supplied account row. */
function detailsOk(data: unknown): DirtyReadResult {
  return { result: { status: 'success', data } };
}

/**
 * Build a read-seam double routing on the Pact code: the `coin.details` probe
 * returns `detailsResult`, a `describe-keyset` probe returns `describeResult`.
 * Records every (pactCode, chainId) call so tests can assert the keyset-ref
 * follow-up was issued.
 */
function makeReadDeps(opts: {
  detailsResult: DirtyReadResult;
  describeResult?: DirtyReadResult;
}): { deps: GuardReadDeps; dirtyRead: ReturnType<typeof vi.fn> } {
  const dirtyRead = vi.fn(
    async (pactCode: string): Promise<DirtyReadResult> => {
      if (pactCode.includes('describe-keyset')) {
        return (
          opts.describeResult ?? { result: { status: 'failure' } }
        );
      }
      return opts.detailsResult;
    },
  );
  return { deps: { dirtyRead }, dirtyRead };
}

describe('fetchAccountGuard', () => {
  it('returns the inline keyset keys and pred when the guard is a direct keyset', async () => {
    const { deps } = makeReadDeps({
      detailsResult: detailsOk({
        balance: 12.5,
        guard: { pred: 'keys-2', keys: [KEY_A, KEY_B] },
      }),
    });

    const result = await fetchAccountGuard(ADDRESS, '0', deps);

    expect(result.exists).toBe(true);
    expect(result.isKeyset).toBe(true);
    expect(result.keys).toEqual([KEY_A, KEY_B]);
    expect(result.pred).toBe('keys-2');
    expect(result.balance).toBe(12.5);
  });

  it('defaults the predicate to keys-all when an inline keyset omits pred', async () => {
    // The chain emits inline keysets as {pred, keys}; a w:/direct guard that
    // lacks pred must still be usable, defaulting to the keys-all semantics.
    const { deps } = makeReadDeps({
      detailsResult: detailsOk({
        balance: 1,
        guard: { keys: [KEY_A] },
      }),
    });

    const result = await fetchAccountGuard(ADDRESS, '0', deps);

    expect(result.isKeyset).toBe(true);
    expect(result.keys).toEqual([KEY_A]);
    expect(result.pred).toBe('keys-all');
  });

  it('resolves a keyset-ref guard via a describe-keyset follow-up read and surfaces the resolved keys', async () => {
    const REF = 'ouronet-ns.dh_sc_dpdc-keyset';
    const { deps, dirtyRead } = makeReadDeps({
      detailsResult: detailsOk({
        balance: 3,
        guard: { keysetref: REF },
      }),
      describeResult: detailsOk({ keys: [KEY_B], pred: 'keys-any' }),
    });

    const result = await fetchAccountGuard(ADDRESS, '0', deps);

    // The keyset-ref path MUST trigger a second read for (describe-keyset <ref>)
    // and return the RESOLVED keys, not the bare ref.
    const describeCall = dirtyRead.mock.calls.find((call) =>
      String(call[0]).includes('describe-keyset'),
    );
    expect(describeCall).toBeDefined();
    expect(String(describeCall?.[0])).toContain(REF);

    expect(result.exists).toBe(true);
    expect(result.isKeyset).toBe(true);
    expect(result.keys).toEqual([KEY_B]);
    expect(result.pred).toBe('keys-any');
  });

  it('resolves a keyset-ref carried in the ks-name field variant', async () => {
    const REF = 'free.my-keyset';
    const { deps, dirtyRead } = makeReadDeps({
      detailsResult: detailsOk({
        balance: 0,
        guard: { 'ks-name': REF },
      }),
      describeResult: detailsOk({ keys: [KEY_A] }),
    });

    const result = await fetchAccountGuard(ADDRESS, '0', deps);

    expect(
      dirtyRead.mock.calls.some((call) => String(call[0]).includes(REF)),
    ).toBe(true);
    expect(result.isKeyset).toBe(true);
    expect(result.keys).toEqual([KEY_A]);
    expect(result.pred).toBe('keys-all');
  });

  it('flags a non-keyset guard (capability) as exists-but-not-keyset with no keys', async () => {
    const { deps } = makeReadDeps({
      detailsResult: detailsOk({
        balance: 7,
        guard: { cgName: 'coin.GAS', cgArgs: [], cgPactId: null },
      }),
    });

    const result = await fetchAccountGuard(ADDRESS, '0', deps);

    // The WARN signal: the account exists but its guard cannot be reduced to a
    // signable keyset.
    expect(result.exists).toBe(true);
    expect(result.isKeyset).toBe(false);
    expect(result.keys).toEqual([]);
    expect(result.balance).toBe(7);
  });

  it('returns an empty exists:false result when the account is absent (try returned false)', async () => {
    const { deps } = makeReadDeps({
      detailsResult: detailsOk(false),
    });

    const result = await fetchAccountGuard(ADDRESS, '0', deps);

    expect(result).toEqual({
      exists: false,
      isKeyset: false,
      keys: [],
      pred: '',
      balance: 0,
    });
  });

  it('returns an empty exists:false result when the read does not succeed', async () => {
    const { deps } = makeReadDeps({
      detailsResult: { result: { status: 'failure' } },
    });

    const result = await fetchAccountGuard(ADDRESS, '0', deps);

    expect(result.exists).toBe(false);
    expect(result.isKeyset).toBe(false);
  });

  it('parses a decimal-object balance shape ({ decimal })', async () => {
    const { deps } = makeReadDeps({
      detailsResult: detailsOk({
        balance: { decimal: '42.7' },
        guard: { pred: 'keys-all', keys: [KEY_A] },
      }),
    });

    const result = await fetchAccountGuard(ADDRESS, '0', deps);

    expect(result.balance).toBe(42.7);
  });

  it('never throws and returns the empty result when the read seam rejects', async () => {
    const deps: GuardReadDeps = {
      dirtyRead: vi.fn(async () => {
        throw new Error('secret-bearing-network-failure');
      }),
    };

    const result = await fetchAccountGuard(ADDRESS, '0', deps);

    expect(result.exists).toBe(false);
    expect(result.keys).toEqual([]);
  });

  it('does not issue a describe-keyset follow-up for an inline keyset', async () => {
    const { deps, dirtyRead } = makeReadDeps({
      detailsResult: detailsOk({
        balance: 1,
        guard: { pred: 'keys-all', keys: [KEY_A] },
      }),
    });

    await fetchAccountGuard(ADDRESS, '0', deps);

    expect(
      dirtyRead.mock.calls.some((call) =>
        String(call[0]).includes('describe-keyset'),
      ),
    ).toBe(false);
  });
});
