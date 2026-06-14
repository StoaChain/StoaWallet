/**
 * Pure balance-presentation domain model for StoaChain's 10 braided chains.
 *
 * Phase-1 reads return `{ balance, exists, error? }` per chain (see
 * ouronet-core `getBalanceOnChain`): `exists:false` means the account row is
 * absent on that chain, an `error` means the read itself failed. This module is
 * the single source of truth for turning that raw shape into a presentation
 * status and for the cross-chain aggregate total. No React, no I/O.
 */
import type { ChainBalance } from '@stoawallet/core';

/**
 * Raw per-chain read result as produced by the Phase-1 RPC layer. Aliased to
 * core's canonical `ChainBalance` so this module never drifts from the wire
 * shape — there is one source of truth, not two redeclarations.
 */
export type ChainBalanceReadResult = ChainBalance;

/** Number of fractional digits StoaChain balances are tracked at. */
const DECIMALS = 12;
const SCALE = 10n ** BigInt(DECIMALS);

/**
 * Discriminated presentation status for a single chain's balance.
 *
 * - `errored`: the read failed; never shown as absent or zero.
 * - `absent`: account row does not exist on this chain (no error).
 * - `zero`: account exists with a balance of exactly 0.
 * - `funded`: account exists with a positive balance.
 */
export type ChainBalanceStatus =
  | { kind: 'errored'; chainId: number; error: string }
  | { kind: 'absent'; chainId: number }
  | { kind: 'zero'; chainId: number; balance: string }
  | { kind: 'funded'; chainId: number; balance: string };

/**
 * Parse a decimal balance string into an integer scaled to 10^DECIMALS.
 * Fractional digits beyond DECIMALS are truncated (clamped), shorter ones are
 * padded. Throws on NaN-shaped input so callers never silently sum garbage.
 */
function scaleToBigInt(balance: string): bigint {
  const trimmed = balance.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid balance string: ${balance}`);
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPartRaw = ''] = unsigned.split('.');

  const fracPart = fracPartRaw.slice(0, DECIMALS).padEnd(DECIMALS, '0');
  const scaled = BigInt(intPart) * SCALE + BigInt(fracPart);

  return negative ? -scaled : scaled;
}

/** Format a 10^DECIMALS-scaled BigInt back into a fixed 12-decimal string. */
function formatScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const intPart = abs / SCALE;
  const fracPart = (abs % SCALE).toString().padStart(DECIMALS, '0');
  return `${negative ? '-' : ''}${intPart.toString()}.${fracPart}`;
}

/**
 * Classify a single chain's read result. `error` takes precedence over
 * `exists`, so an errored read is never presented as absent or zero.
 */
export function classifyChainBalance(
  chainId: number,
  result: ChainBalanceReadResult,
): ChainBalanceStatus {
  if (result.error !== undefined) {
    return { kind: 'errored', chainId, error: result.error };
  }
  if (!result.exists) {
    return { kind: 'absent', chainId };
  }
  if (scaleToBigInt(result.balance) === 0n) {
    return { kind: 'zero', chainId, balance: result.balance };
  }
  return { kind: 'funded', chainId, balance: result.balance };
}

export interface AggregateTotal {
  total: string;
  includedChains: number;
  erroredChains: number;
}

/**
 * Aggregate the cross-chain total. Only `exists:true` chains contribute; each
 * is scaled to 10^DECIMALS and summed as BigInt, then formatted back to a
 * 12-decimal string — this avoids the float drift a `Number` sum +
 * `toFixed(12)` would introduce across many addends. Absent chains contribute
 * 0 and are not counted as errored; errored chains are excluded from the sum
 * and surfaced via `erroredChains`.
 */
export function aggregateTotal(
  results: ChainBalanceReadResult[],
): AggregateTotal {
  let sum = 0n;
  let includedChains = 0;
  let erroredChains = 0;

  for (const result of results) {
    if (result.error !== undefined) {
      erroredChains += 1;
      continue;
    }
    if (!result.exists) {
      continue;
    }
    sum += scaleToBigInt(result.balance);
    includedChains += 1;
  }

  return {
    total: formatScaled(sum),
    includedChains,
    erroredChains,
  };
}
