import { STOA_CHAINS } from '@stoachain/stoa-core/constants';

/**
 * Per-chain verdict for the gasless eligibility probe.
 *
 * - `pass` — a SIGNED `/local` evaluation cleared the on-chain
 *   `ouronet-ns.DALOS` gas-payer eligibility gate for the fresh account.
 * - `fail` — the node ran the gate and REJECTED the transaction (e.g. the
 *   account is not eligible / rate-limited). A real failure, recorded
 *   distinctly so Phase 4 does not advertise unconditional gasless.
 * - `simulate-only / not submit-verified` — only a shape-level simulate was
 *   feasible on this chain; the parse succeeded but submit-time eligibility was
 *   NOT exercised, so the result is not trustworthy as an unconditional pass.
 * - `unreachable` — the node could not be reached (network down / timeout).
 */
export type ProbeOutcome =
  | 'pass'
  | 'fail'
  | 'simulate-only / not submit-verified'
  | 'unreachable';

export interface ChainProbeResult {
  readonly chainId: string;
  readonly outcome: ProbeOutcome;
}

/** A per-chain probe: given a chainId, returns that chain's gasless verdict. */
export type GaslessProbe = (chainId: string) => Promise<ChainProbeResult>;

export interface GaslessReport {
  /** One verdict per StoaChain chain — length always equals STOA_CHAIN_COUNT. */
  readonly results: readonly ChainProbeResult[];
  /**
   * True ONLY when every chain returned `pass`. Any fail / simulate-only /
   * unreachable verdict flips this to false so Phase 4 gates messaging instead
   * of advertising unconditional gasless.
   */
  readonly eligibleEverywhere: boolean;
  /**
   * Chains whose verdict is NOT an unconditional pass. Surfaced distinctly so a
   * rejection is never averaged away into an overall pass.
   */
  readonly gatedChains: readonly string[];
}

/** Only an unconditional `pass` permits unconditional "gasless" messaging. */
function isUnconditionalPass(outcome: ProbeOutcome): boolean {
  return outcome === 'pass';
}

/**
 * Verify gasless eligibility across all 10 StoaChain chains.
 *
 * Iterates `STOA_CHAINS` (count from `STOA_CHAIN_COUNT`, never a hardcoded
 * literal), invokes the injected per-chain `probe` once per chain, and
 * aggregates the verdicts into a report Phase 4 reads to decide unconditional
 * "gasless" vs gated messaging. A non-pass verdict on ANY chain is recorded as
 * a distinct gated outcome — never silently folded into an overall pass.
 *
 * This function is pure aggregation/gating logic: the live-network call lives
 * inside the injected `probe`, keeping this unit-testable with a stub.
 */
export async function verifyGaslessAllChains(
  probe: GaslessProbe,
): Promise<GaslessReport> {
  const results = await Promise.all(STOA_CHAINS.map((chainId) => probe(chainId)));

  const gatedChains = results
    .filter((r) => !isUnconditionalPass(r.outcome))
    .map((r) => r.chainId);

  return {
    results,
    eligibleEverywhere: gatedChains.length === 0,
    gatedChains,
  };
}
