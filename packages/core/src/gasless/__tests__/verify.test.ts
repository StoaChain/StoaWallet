import { describe, expect, it, vi } from 'vitest';

import { STOA_CHAIN_COUNT, STOA_CHAINS } from '@stoachain/stoa-core/constants';

import {
  verifyGaslessAllChains,
  type ChainProbeResult,
  type GaslessProbe,
} from '../verify';

/**
 * Build a stubbed per-chain probe that returns a caller-supplied outcome for
 * each chainId. This keeps the live-network call OUT of these unit tests: the
 * aggregation + gating logic is exercised deterministically here, and the real
 * signed `/local` probe is verified by the separate live-run script.
 */
function stubProbe(
  byChain: Record<string, ChainProbeResult['outcome']>,
): GaslessProbe {
  return vi.fn(async (chainId: string): Promise<ChainProbeResult> => {
    const outcome = byChain[chainId] ?? 'unreachable';
    return { chainId, outcome };
  });
}

describe('verifyGaslessAllChains', () => {
  it('produces exactly one result entry per StoaChain chain (count from STOA_CHAIN_COUNT, not hardcoded)', async () => {
    const allPass = Object.fromEntries(
      STOA_CHAINS.map((c) => [c, 'pass' as const]),
    );
    const report = await verifyGaslessAllChains(stubProbe(allPass));

    expect(report.results).toHaveLength(STOA_CHAIN_COUNT);
    // Every StoaChain chain id is represented exactly once — no chain skipped,
    // no chain probed twice. Phase 4 reads one verdict per chain.
    expect(report.results.map((r) => r.chainId).sort()).toEqual(
      [...STOA_CHAINS].sort(),
    );
  });

  it('drives the loop bound from STOA_CHAIN_COUNT — probe is invoked once per chain', async () => {
    const allPass = Object.fromEntries(
      STOA_CHAINS.map((c) => [c, 'pass' as const]),
    );
    const probe = stubProbe(allPass);
    await verifyGaslessAllChains(probe);

    expect(probe).toHaveBeenCalledTimes(STOA_CHAIN_COUNT);
    for (const chainId of STOA_CHAINS) {
      expect(probe).toHaveBeenCalledWith(chainId);
    }
  });

  it('marks gasless ELIGIBLE everywhere only when every chain passes the signed /local gate', async () => {
    const allPass = Object.fromEntries(
      STOA_CHAINS.map((c) => [c, 'pass' as const]),
    );
    const report = await verifyGaslessAllChains(stubProbe(allPass));

    // Phase 4 gate: unconditional "gasless" messaging is allowed ONLY when no
    // chain failed and no chain was merely shape-simulated.
    expect(report.eligibleEverywhere).toBe(true);
    expect(report.gatedChains).toEqual([]);
  });

  it('records a chain rejection as a DISTINCT gated outcome — never a silent pass', async () => {
    const rejectedChain = STOA_CHAINS[3];
    const mostlyPass = Object.fromEntries(
      STOA_CHAINS.map((c) => [
        c,
        c === rejectedChain ? ('fail' as const) : ('pass' as const),
      ]),
    );
    const report = await verifyGaslessAllChains(stubProbe(mostlyPass));

    // A rejection must NOT be averaged away into an overall pass.
    expect(report.eligibleEverywhere).toBe(false);
    const entry = report.results.find((r) => r.chainId === rejectedChain);
    expect(entry?.outcome).toBe('fail');
    // The failing chain is surfaced distinctly so Phase 4 can gate messaging
    // for exactly that chain rather than advertising unconditional gasless.
    expect(report.gatedChains).toContain(rejectedChain);
  });

  it('treats a shape-only simulate as gated (not unconditional gasless)', async () => {
    const simChain = STOA_CHAINS[7];
    const map = Object.fromEntries(
      STOA_CHAINS.map((c) => [
        c,
        c === simChain
          ? ('simulate-only / not submit-verified' as const)
          : ('pass' as const),
      ]),
    );
    const report = await verifyGaslessAllChains(stubProbe(map));

    // Parse-only simulate can "pass" while a real submit later fails, so it is
    // NOT sufficient to advertise unconditional gasless.
    expect(report.eligibleEverywhere).toBe(false);
    expect(report.gatedChains).toContain(simChain);
    expect(
      report.results.find((r) => r.chainId === simChain)?.outcome,
    ).toBe('simulate-only / not submit-verified');
  });

  it('treats an unreachable chain as gated and records it distinctly', async () => {
    const downChain = STOA_CHAINS[0];
    const map = Object.fromEntries(
      STOA_CHAINS.map((c) => [
        c,
        c === downChain ? ('unreachable' as const) : ('pass' as const),
      ]),
    );
    const report = await verifyGaslessAllChains(stubProbe(map));

    expect(report.eligibleEverywhere).toBe(false);
    expect(report.gatedChains).toContain(downChain);
    expect(
      report.results.find((r) => r.chainId === downChain)?.outcome,
    ).toBe('unreachable');
  });
});
