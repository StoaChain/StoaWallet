/**
 * Gasless-on-all-10-chains verification.
 *
 * `verifyGaslessAllChains` is pure aggregation/gating logic over a per-chain
 * probe; `makeSignedLocalProbe` + `buildGaslessProbeTx` construct and run the
 * real SIGNED `/local` eligibility check against node1's on-chain
 * `ouronet-ns.DALOS` gas-payer module. The live 10-chain run + artifact
 * persistence lives in `liveRun.ts` (a script, not part of this barrel).
 */
export {
  verifyGaslessAllChains,
  type ChainProbeResult,
  type GaslessProbe,
  type GaslessReport,
  type ProbeOutcome,
} from './verify';

export {
  buildGaslessProbeTx,
  makeSignedLocalProbe,
  type GaslessProbeTxSpec,
  type SignedLocalProbeDeps,
} from './buildProbe';

// PURE, browser-safe gating only. The Node-only filesystem loader
// (`loadGaslessResult` in `gating.node.ts`) is intentionally NOT re-exported
// here — importing it would pull `node:fs`/`node:path` into the browser bundle.
export {
  getGaslessGating,
  type GaslessGating,
  type GaslessResultArtifact,
} from './gating';
