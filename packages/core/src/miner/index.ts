/**
 * Barrel for the miner-aggregation domain.
 *
 * `sweepPlan` is the PURE source-selection module: it classifies the active
 * account's pre-scanned 10-chain balances into funded sources (excluding the
 * target) vs skipped chains, and validates the self-transfer precondition. No
 * React, no I/O — the single source of truth for "which chains sweep and how
 * much", consumed by the parallel sweep orchestrator and the React hook.
 */
export { buildSweepPlan } from './sweepPlan';
export type {
  BuildSweepPlanInput,
  BuildSweepPlanResult,
  BuildSweepPlanReason,
  SweepBalances,
  SweepChainBalance,
  SweepSource,
  SweepSkipped,
  SweepSkipReason,
} from './sweepPlan';

/**
 * The PARALLEL self-transfer sweep orchestrator. REUSES the Phase-5 cross-chain
 * orchestrators (`sendCrossChainStep0` + `pollProofAndContinue`) per funded
 * source — it does NOT build a second cross-chain path. `SweepSource` is owned by
 * `sweepPlan` (consumed here at runtime) and re-exported above — never redeclared.
 */
export { aggregateAcrossChains, minerInflightKey } from './aggregate';
export type {
  AggregateAcrossChainsParams,
  AggregateAcrossChainsResult,
  AggregateDeps,
  MinerChainResult,
  MinerChainOutcome,
  MinerChainStage,
  MinerChainProgress,
  RemoteSignTransaction,
} from './aggregate';
