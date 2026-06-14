/**
 * Barebone core API surface for `@stoawallet/core`.
 *
 * Every function here is a THIN wrapper over `@stoachain/*` — derivation,
 * signing, encryption, and cross-chain logic live in the SDK and are NOT
 * reimplemented. Chain iteration always comes from `STOA_CHAINS`/
 * `STOA_CHAIN_COUNT`, never a hardcoded count.
 */
export { deriveAccount, type DerivedAccount } from './derive';
export { signTx, type SignableKeypair } from './sign';
export {
  getBalances,
  type Balances,
  type ChainBalance,
  type GetBalancesDeps,
} from './balances';
export {
  sendSameChain,
  sendCrossChain,
  sendCrossChainStep0,
  type SameChainSendParams,
  type SameChainSendResult,
  type SameChainDeps,
  type BuiltTx,
  type SimulateResult,
  type BuildTxSpec,
  type CrossChainParams,
  type SendSigner,
  type SendDeps,
  type SendCrossChainStep0Input,
  type SendCrossChainStep0Result,
  type SendCrossChainStep0Deps,
  type SendCrossChainStep0Reason,
  type ListenResult,
} from './send';
