/**
 * Advanced-account sub-barrel for `@stoawallet/core`.
 *
 * The single export surface for non-seed accounts: classifying a pasted address,
 * the guard read seam, the pure guard-satisfaction analysis, the pub-set builder,
 * and the two orchestrators the UI seam drives — `addAdvancedAccount` (classify ->
 * fetch -> analyze -> persist) and `resolveForeignKey` (validate -> encrypt ->
 * re-analyze -> maybe promote) plus the sign-time keypair assembler. The domain
 * model helpers (`transitionAdvancedAccount`, `findPureKeypairByPubkey`) and the
 * advanced vault types are re-exported here so consumers have one import surface.
 *
 * No node-only transport leaks here: each module keeps its live SDK calls behind
 * a lazily-imported `.live.ts`, so this barrel stays browser-safe.
 */

export {
  addAdvancedAccount,
  type AddAdvancedAccountInput,
  type AddAdvancedAccountDeps,
  type AddAdvancedAccountResult,
  type AddAdvancedAccountFailure,
  type AddAdvancedAccountFailureReason,
  type AddSendCapableResult,
  type AddWatchOnlyResult,
  type FetchGuardFn,
} from './addAdvancedAccount';

export {
  resolveForeignKey,
  resolveAdvancedSigningKeypairs,
  type ResolveForeignKeyInput,
  type ResolveForeignKeyDeps,
  type ResolveForeignKeyResult,
  type ResolveSigningKeypairsResult,
  type Keyset,
} from './resolveForeignKey';

export {
  analyzeWalletGuard,
  buildWalletPubSet,
  type GuardAnalysis,
  type PubKeyCarrier,
} from './analyzeWalletGuard';

export {
  fetchAccountGuard,
  type AccountGuardResult,
  type GuardReadDeps,
  type DirtyReadResult,
} from './fetchAccountGuard';

export { isPastedKeyFormat } from './pastedKey';

export {
  transitionAdvancedAccount,
  findPureKeypairByPubkey,
  type AdvancedAccount,
  type AdvancedAccountMode,
  type AdvancedAccountType,
  type GuardSummary,
  type IPureKeypair,
} from './model';
