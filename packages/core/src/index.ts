/**
 * Root barrel for `@stoawallet/core`.
 *
 * Wires the package's public surface: the barebone API (derive/sign/balances/
 * send — thin wrappers over `@stoachain/*`), the node boot path
 * (`configureNode`), and the platform-agnostic storage contracts. Every chain
 * count flows from `STOA_CHAIN_COUNT`, never a hardcoded literal.
 */
import { STOA_CHAIN_COUNT } from '@stoachain/stoa-core/constants';

export interface CoreInfo {
  readonly name: string;
  readonly chainCount: number;
}

export const coreInfo: CoreInfo = {
  name: '@stoawallet/core',
  chainCount: STOA_CHAIN_COUNT,
};

// The canonical braided chain-id array ("0".."9"), re-exported from
// `@stoachain/stoa-core/constants` as core's single source for chain selectors
// (Phase 5/11). Browser-safe — a plain string array, no node-only deps.
export { STOA_CHAINS } from '@stoachain/stoa-core/constants';

// Barebone API surface (thin wrappers over the SDK).
export {
  deriveAccount,
  signTx,
  getBalances,
  sendSameChain,
  sendCrossChain,
  sendCrossChainStep0,
  type DerivedAccount,
  type SignableKeypair,
  type Balances,
  type ChainBalance,
  type GetBalancesDeps,
  type SameChainSendParams,
  type SameChainSendResult,
  type SameChainDeps,
  type CrossChainParams,
  type SendSigner,
  type SendDeps,
  type SendCrossChainStep0Input,
  type SendCrossChainStep0Result,
  type SendCrossChainStep0Deps,
  type SendCrossChainStep0Reason,
  type ListenResult,
} from './api';

// Cross-chain orchestrators and pure building blocks: the validated step-0
// build, the FULL step-0 sign/submit/confirm orchestration, the SPV
// poll-and-continue (step 1), and the recovery resume flow. Browser-safe — the
// node-only SDK transport stays behind each module's lazily-imported `.live.ts`.
export {
  buildCrossChainStep0,
  pollProofAndContinue,
  resumeCrossChain,
  type BuildStep0Input,
  type BuildStep0Deps,
  type BuildStep0Result,
  type BuildStep0Reason,
  type ReceiverGuard,
  type UnsignedTx,
  type GasMode,
  type PollProofAndContinueParams,
  type PollProofAndContinueOptions,
  type PollProofAndContinueResult,
  type PollAndContinueDeps,
  type ContinuationTx,
  type ResumeParams,
  type ResumeCrossChainResult,
  type ResumeDeps,
} from './crosschain';

// Same-chain send building blocks: the pure transfer-code builder, gas-payer
// signer resolution, and the full gasless orchestration helper. Browser-safe.
export {
  buildTransferCode,
  formatStoaAmount,
  signerSetForSameChain,
  awaitSendConfirmation,
  type BuildTransferCodeInput,
  type BuildTransferCodeResult,
  type BuiltTx,
  type SimulateResult,
  type BuildTxSpec,
  type ConfirmSendDeps,
  type ConfirmSendResult,
  type ListenOutcome,
} from './send';

// The recipient address book — named k: addresses, plain config over storage.
export {
  listAddressBook,
  isInAddressBook,
  saveAddressBookEntry,
  removeAddressBookEntry,
  type AddressBookEntry,
} from './addressbook';

// The auto-lock window preference (minutes) — plain config over storage.
export {
  getAutoLockMinutes,
  setAutoLockMinutes,
  clampAutoLockMinutes,
  AUTO_LOCK_OPTIONS,
  MIN_AUTO_LOCK_MINUTES,
  MAX_AUTO_LOCK_MINUTES,
  DEFAULT_AUTO_LOCK_MINUTES,
} from './autolock';

// Codex import — map an Ouronet Codex export into the vault (pure, injected crypto).
export {
  importCodex,
  type CodexExport,
  type ImportCodexDeps,
  type ImportCodexResult,
  type ImportCodexOutcome,
  type ImportCodexFailure,
} from './codex';

// Node boot path + the persisted node-failover preference layer (default /
// node2 / custom RPC), read/written over the shared StorageAdapter, plus the
// custom-node-URL trust boundary (pure shape/scheme check + the live
// reachability/network-identity probe — both discriminated, never logging the URL).
export {
  configureNode,
  getNodePreference,
  setNodePreference,
  getCurrentNodeStatus,
  getNodeConfig,
  validateCustomNodeUrl,
  probeCustomNode,
  validateAndProbe,
  PROBE_TIMEOUT_MS,
  applySelector,
  applyNodePreference,
  applyAndPersistNodePreference,
  revertToDefault,
  type NodePreference,
  type NodeConfig,
  type NodeStatus,
  type ValidateUrlResult,
  type ProbeResult,
  type ValidateAndProbeResult,
  type NodeInfo,
  type NodeInfoReadDeps,
  type ProbeOptions,
  type ApplySelectorDeps,
  type ApplyResult,
  type ApplyFailureReason,
  type ApplyOptions,
} from './network';

// Gasless-on-all-10-chains verification (signed /local eligibility probe +
// pure gating logic). Phase 4 reads the per-chain report to decide unconditional
// "gasless" vs gated messaging.
export {
  verifyGaslessAllChains,
  makeSignedLocalProbe,
  buildGaslessProbeTx,
  getGaslessGating,
  type ChainProbeResult,
  type GaslessProbe,
  type GaslessReport,
  type ProbeOutcome,
  type GaslessProbeTxSpec,
  type SignedLocalProbeDeps,
  type GaslessGating,
  type GaslessResultArtifact,
} from './gasless';

// Platform-agnostic storage contracts, the persisted-key registry, and the
// biometric-unlock contract. Single-sourced through the storage sub-barrel.
export * from './storage';

// Wallet keyring: vault model, encrypt-at-rest, mnemonic, derivation, and the
// KeyringManager orchestration over the storage contracts.
export * from './keyring';

// Advanced (non-seed) accounts: classify/fetch/analyze orchestration, foreign-key
// resolution + sign-time keypair assembly, the pub-set builder, and the advanced
// vault types. Browser-safe — node-only transport stays behind each `.live.ts`.
export * from './advanced';

// Miner-aggregation source-selection: the PURE sweep-plan domain (funded sources
// excluding the target, skipped zero/absent/errored/target chains, the self-transfer
// account precondition). No React, no I/O — consumed by the sweep orchestrator and hook.
export {
  buildSweepPlan,
  type BuildSweepPlanInput,
  type BuildSweepPlanResult,
  type BuildSweepPlanReason,
  type SweepBalances,
  type SweepChainBalance,
  type SweepSource,
  type SweepSkipped,
  type SweepSkipReason,
} from './miner';

// Miner-aggregation PARALLEL sweep orchestrator: resolve-keypairs-first →
// Promise.allSettled over funded sources → per-source REUSE of the Phase-5
// `sendCrossChainStep0` + `pollProofAndContinue` → per-chain progress + XP-5
// per-source-chain in-flight persistence + TIMEOUT-as-pending isolation.
export {
  aggregateAcrossChains,
  minerInflightKey,
  type AggregateAcrossChainsParams,
  type AggregateAcrossChainsResult,
  type AggregateDeps,
  type MinerChainResult,
  type MinerChainOutcome,
  type MinerChainStage,
  type MinerChainProgress,
  type RemoteSignTransaction,
} from './miner';

// UrStoa native interactions (chain 0, gasless): thin composition wrappers over
// `@stoachain/ouronet-core`. The COLLECT wrapper probes coin-account existence
// (null → conservative create-account variant) and submits via the executor,
// returning a discriminated result that never logs/returns signing secrets.
export {
  collectUrStoa,
  type CollectUrStoaParams,
  type CollectUrStoaResult,
  type CollectUrStoaDeps,
} from './urstoa';

// UrStoa holdings/earnings reads (chain 0): a thin wrapper over `getPrimordials`
// + `getUrStoaBalance` surfacing ONLY the UrStoa-relevant figures (wallet/vault/
// earnings, `{decimal}`-unwrapped) and the live vault total. Discriminated
// results; a `null` vault balance is a DISTINCT unknown, never a coerced `0`.
export {
  getUrStoaHoldings,
  getVaultTotal,
  VAULT_ADDRESS,
  type UrStoaReadDeps,
  type UrStoaHoldings,
  type UrStoaHoldingsResult,
  type VaultTotalResult,
} from './urstoa';

// UrStoa STAKE/UNSTAKE (chain 0, gasless): thin compositions over the SDK
// `executeStakeUrStoa`/`executeUnstakeUrStoa`. The active payment key signs BOTH
// the GAS_PAYER cap and the op cap; the amount is a pre-formatted decimal string
// passed through verbatim. Discriminated results, never returning/logging secrets.
export {
  stakeUrStoa,
  unstakeUrStoa,
  type UrStoaStakeParams,
  type UrStoaStakeResult,
  type StakeDeps,
} from './urstoa';

// UrStoa native TRANSFER (chain 0, gasless): a thin composition over the SDK
// `executeNativeUrStoaTransfer`. REUSES the Phase-4 recipient classifier (valid
// k:, 64-char ED25519 pubkey, reject self-send), RESOLVES receiver existence to
// pick Transfer vs TransferAnew (recipient-pubkey keyset), passes the pre-formatted
// amount verbatim, and returns a discriminated result that never carries secrets.
export {
  transferUrStoa,
  type TransferUrStoaParams,
  type TransferUrStoaResult,
  type TransferUrStoaDeps,
} from './urstoa';
