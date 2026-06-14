/**
 * Per-chain gasless gating for Phase 4 messaging.
 *
 * Reads the Phase 1 `gasless-result.json` artifact (the persisted per-chain
 * verdicts from the live signed `/local` eligibility run) and decides, per
 * chain, whether the UI may advertise UNCONDITIONAL gasless (`"verified"`) or
 * must use the hedged framing (`"simulate-only"`).
 *
 * The decision is CONSERVATIVE by construction: only a submit-verified `pass`
 * earns `"verified"`. A missing artifact, an unreadable artifact, a missing
 * per-chain entry, or any non-`pass` tag (`fail` / `simulate-only` /
 * `unreachable`) all degrade to `"simulate-only"` — the wallet never advertises
 * unconditional gasless for a chain Phase 1 did not confirm.
 *
 * `getGaslessGating` is a PURE function over the parsed artifact (or
 * `undefined`); it does not touch the filesystem, so its gating logic is
 * deterministically testable AND this module stays browser-bundleable (no
 * `node:fs`/`node:path` imports leak into the `@stoawallet/core` browser
 * barrel). The thin, side-effecting filesystem loader lives in the Node-only
 * `gating.node.ts` (kept OUT of this barrel, like `liveRun.ts`).
 */
import type { ChainProbeResult } from './verify';

/** Phase 4 gating verdict: unconditional gasless vs the hedged framing. */
export type GaslessGating = 'verified' | 'simulate-only';

/**
 * The parsed `gasless-result.json` artifact shape this reader depends on. Only
 * `results` (the per-chain verdicts) is consumed; the artifact carries more
 * metadata (generatedAt, network, note, eligibleEverywhere, gatedChains) that
 * this gating decision does not need.
 */
export interface GaslessResultArtifact {
  readonly results: readonly ChainProbeResult[];
}

/**
 * Build a per-chain gating lookup from a parsed artifact (or `undefined`).
 *
 * Returns `"verified"` for a chain ONLY when the artifact carries a
 * submit-verified `pass` entry for it. Every other case — undefined artifact,
 * missing entry, or any non-`pass` outcome — yields `"simulate-only"`.
 */
export function getGaslessGating(
  result?: GaslessResultArtifact,
): (chainId: string) => GaslessGating {
  const byChain = new Map(
    (result?.results ?? []).map((entry) => [entry.chainId, entry.outcome]),
  );

  return (chainId: string): GaslessGating =>
    byChain.get(chainId) === 'pass' ? 'verified' : 'simulate-only';
}
