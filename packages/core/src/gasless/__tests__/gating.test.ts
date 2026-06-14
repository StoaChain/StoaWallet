import { describe, expect, it } from 'vitest';

import { STOA_CHAINS } from '@stoachain/stoa-core/constants';

import { getGaslessGating, type GaslessResultArtifact } from '../gating';

/** Build an artifact whose per-chain outcomes come from a caller-supplied map. */
function artifactFrom(
  byChain: Record<string, GaslessResultArtifact['results'][number]['outcome']>,
): GaslessResultArtifact {
  return {
    results: Object.entries(byChain).map(([chainId, outcome]) => ({
      chainId,
      outcome,
    })),
  };
}

describe('getGaslessGating', () => {
  it('reports "verified" for a chain the artifact tagged pass — the only state that earns unconditional gasless messaging', () => {
    const gate = getGaslessGating(
      artifactFrom(Object.fromEntries(STOA_CHAINS.map((c) => [c, 'pass' as const]))),
    );

    // A submit-verified pass is the sole precondition for advertising
    // unconditional gasless on that chain.
    expect(gate(STOA_CHAINS[0])).toBe('verified');
  });

  it('hedges to "simulate-only" for fail / simulate-only / unreachable tags — Phase 1 did not confirm a submit-verified pass', () => {
    const gate = getGaslessGating(
      artifactFrom({
        [STOA_CHAINS[1]]: 'fail',
        [STOA_CHAINS[2]]: 'simulate-only / not submit-verified',
        [STOA_CHAINS[3]]: 'unreachable',
      }),
    );

    // None of these tags is a submit-verified pass, so none may advertise
    // unconditional gasless — each degrades to the hedged framing.
    expect(gate(STOA_CHAINS[1])).toBe('simulate-only');
    expect(gate(STOA_CHAINS[2])).toBe('simulate-only');
    expect(gate(STOA_CHAINS[3])).toBe('simulate-only');
  });

  it('degrades EVERY chain to "simulate-only" when the artifact is absent (undefined) — never advertises gasless Phase 1 could not produce', () => {
    const gate = getGaslessGating(undefined);

    // Conservative default: with no artifact, no chain is ever "verified".
    for (const chainId of STOA_CHAINS) {
      expect(gate(chainId)).toBe('simulate-only');
    }
  });

  it('degrades a chain missing from the artifact to "simulate-only" while present pass chains stay "verified"', () => {
    const missingChain = STOA_CHAINS[5];
    const present = Object.fromEntries(
      STOA_CHAINS.filter((c) => c !== missingChain).map((c) => [c, 'pass' as const]),
    );
    const gate = getGaslessGating(artifactFrom(present));

    // A chain with no entry was not confirmed by Phase 1 → hedged.
    expect(gate(missingChain)).toBe('simulate-only');
    // Chains that ARE present and passed keep their verified verdict.
    expect(gate(STOA_CHAINS[0])).toBe('verified');
    expect(gate(STOA_CHAINS[9])).toBe('verified');
  });
});
