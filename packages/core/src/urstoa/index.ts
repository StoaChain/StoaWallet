/**
 * UrStoa sub-barrel — native UrStoa on-chain interaction wrappers (chain 0,
 * gasless). Thin compositions over `@stoachain/ouronet-core` that return
 * discriminated results and never leak signing secrets. Browser-safe: each
 * module keeps its node-only SDK transport behind a lazily-imported default.
 */
export {
  collectUrStoa,
  type CollectUrStoaParams,
  type CollectUrStoaResult,
  type CollectUrStoaDeps,
} from './collect';

// Holdings/earnings reads (chain 0): a thin wrapper over `getPrimordials` +
// `getUrStoaBalance` surfacing ONLY the UrStoa-relevant fields (wallet/vault/
// earnings/total). Wrapped-* is out of scope; the live SDK reads stay behind a
// lazily-imported `.live.ts`.
export {
  getUrStoaHoldings,
  getVaultTotal,
  VAULT_ADDRESS,
  type UrStoaReadDeps,
  type UrStoaHoldings,
  type UrStoaHoldingsResult,
  type VaultTotalResult,
} from './reads';

// Chain-0 gasless STAKE/UNSTAKE wrappers: thin compositions over the SDK
// `executeStakeUrStoa`/`executeUnstakeUrStoa` (which own the pact build + caps).
// The payment key signs BOTH GAS_PAYER and the op cap; results are discriminated
// and never carry signing secrets. The vault floor is the hook's job, not here.
export {
  stakeUrStoa,
  unstakeUrStoa,
  type UrStoaStakeParams,
  type UrStoaStakeResult,
  type StakeDeps,
} from './stake';

// Chain-0 gasless native TRANSFER wrapper: a thin composition over the SDK
// `executeNativeUrStoaTransfer` that REUSES the Phase-4 recipient classifier,
// RESOLVES receiver existence (Transfer vs TransferAnew with a recipient-pubkey
// keyset), and returns a discriminated result that never carries signing secrets.
export {
  transferUrStoa,
  type TransferUrStoaParams,
  type TransferUrStoaResult,
  type TransferUrStoaDeps,
} from './transfer';
