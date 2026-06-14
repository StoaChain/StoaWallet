import { STOA_CHAINS } from '@stoachain/stoa-core/constants';
import { getBalanceOnChain as sdkGetBalanceOnChain } from '@stoachain/ouronet-core/interactions/crossChainFunctions';

/**
 * Per-chain balance result. `exists` is the absent-vs-zero discriminator: a
 * non-existent account row (`exists: false`) is distinct from an existing
 * account holding zero (`exists: true, balance: "0.0"`). `error` is present
 * when that single chain's read failed — the other chains are unaffected.
 */
export interface ChainBalance {
  readonly balance: string;
  readonly exists: boolean;
  readonly error?: string;
}

/** Balances keyed by chain id ("0".."9"). */
export type Balances = Record<string, ChainBalance>;

/** The network-read boundary, injectable so tests mock only that seam. */
export interface GetBalancesDeps {
  getBalanceOnChain: (
    account: string,
    chainId: string,
  ) => Promise<{ balance: string; exists: boolean; error?: string }>;
}

/**
 * Read an account's StoaChain balance across all chains.
 *
 * Chains come from `STOA_CHAINS` (the single source of truth — never a
 * hardcoded 10), and each chain is read in parallel with PER-CHAIN ISOLATION
 * via `Promise.allSettled`: one chain's network failure surfaces as that
 * chain's `error` and does NOT blank the other nine. The absent-vs-zero
 * `exists` flag from the SDK is preserved verbatim.
 */
export async function getBalances(
  account: string,
  deps: GetBalancesDeps = { getBalanceOnChain: sdkGetBalanceOnChain },
): Promise<Balances> {
  const settled = await Promise.allSettled(
    STOA_CHAINS.map((chainId) => deps.getBalanceOnChain(account, chainId)),
  );

  const result: Balances = {};
  STOA_CHAINS.forEach((chainId, i) => {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      result[chainId] = outcome.value;
    } else {
      const reason = outcome.reason;
      result[chainId] = {
        balance: '0.0',
        exists: false,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  });

  return result;
}
