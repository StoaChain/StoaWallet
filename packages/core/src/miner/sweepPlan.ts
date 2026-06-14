import { STOA_CHAINS } from '@stoachain/stoa-core/constants';
import { classifyPaymentKey } from '@stoachain/stoa-core/guard';

import { formatStoaAmount } from '../send/buildTransferCode.js';

/** Fixed sweep-amount precision — every source amount is emitted at exactly
 *  this many fractional digits as a valid Pact decimal literal. */
const SWEEP_DECIMALS = 12;

/** k: account body = exactly 64 hex chars (an ED25519 pubkey). */
const K_PUBKEY = /^[0-9a-fA-F]{64}$/;

/**
 * Per-chain pre-scan result, the SAME `{ balance, exists, error? }` shape the
 * Phase-1/Phase-3 `getBalances` fan-out produces, keyed by chain id ("0".."9").
 * `exists` is the absent-vs-zero discriminator; `error` marks a chain whose
 * read failed (its true balance is unknown).
 */
export interface SweepChainBalance {
  readonly balance: string;
  readonly exists: boolean;
  readonly error?: string;
}

export type SweepBalances = Record<string, SweepChainBalance>;

export interface BuildSweepPlanInput {
  /** The active account's pre-scanned balances across all 10 STOA_CHAINS. */
  readonly balances: SweepBalances;
  /** The chain the miner consolidates INTO (one of STOA_CHAINS). */
  readonly targetChain: string;
  /** The active k: account — sender === receiver === this account (self-transfer). */
  readonly account: string;
}

/** A funded source chain and the full-balance amount it sweeps. */
export interface SweepSource {
  readonly chainId: string;
  /** Full balance as a 12-decimal Pact decimal string. */
  readonly amount: string;
}

export type SweepSkipReason = 'zero' | 'absent' | 'errored' | 'is-target';

export interface SweepSkipped {
  readonly chainId: string;
  readonly reason: SweepSkipReason;
}

export type BuildSweepPlanReason = 'invalid-account' | 'invalid-target';

export type BuildSweepPlanResult =
  | { ok: true; sources: SweepSource[]; skipped: SweepSkipped[] }
  | { ok: false; reason: BuildSweepPlanReason };

/**
 * Compute the miner SWEEP PLAN from a pre-scanned 10-chain balance set.
 *
 * Pure — performs NO network reads. The single source of truth for "which
 * chains sweep and how much": sources are the FUNDED chains EXCLUDING the
 * target; every other chain is recorded in `skipped` with a distinct reason.
 *
 * Validation refuses BEFORE any classification:
 *   1. account is a k: address whose body is a 64-char ED25519 pubkey
 *      (sender === receiver === account for the self-transfer)
 *   2. targetChain is one of the 10 STOA_CHAINS
 *
 * Per-chain branch order matches the Phase-3 classifier: target first, then
 * error, then existence, then balance > 0.
 */
export function buildSweepPlan(input: BuildSweepPlanInput): BuildSweepPlanResult {
  const { balances, targetChain, account } = input;

  const classified = classifyPaymentKey(account);
  if (
    classified === null ||
    classified.type !== 'k-account' ||
    classified.pubkey === null ||
    !K_PUBKEY.test(classified.pubkey)
  ) {
    return { ok: false, reason: 'invalid-account' };
  }

  if (!STOA_CHAINS.includes(targetChain)) {
    return { ok: false, reason: 'invalid-target' };
  }

  const sources: SweepSource[] = [];
  const skipped: SweepSkipped[] = [];

  for (const chainId of STOA_CHAINS) {
    if (chainId === targetChain) {
      skipped.push({ chainId, reason: 'is-target' });
      continue;
    }

    const entry = balances[chainId];

    if (entry === undefined || entry.error !== undefined) {
      skipped.push({ chainId, reason: 'errored' });
      continue;
    }

    if (!entry.exists) {
      skipped.push({ chainId, reason: 'absent' });
      continue;
    }

    if (!isPositiveBalance(entry.balance)) {
      skipped.push({ chainId, reason: 'zero' });
      continue;
    }

    sources.push({ chainId, amount: toFixedDecimals(entry.balance) });
  }

  return { ok: true, sources, skipped };
}

/**
 * Whether a pre-scanned balance string is strictly positive. Reuses the
 * canonical `formatStoaAmount` to reject malformed strings (which are treated
 * as non-positive / skip-zero, never a thrown error), then compares the
 * normalized value against zero.
 */
function isPositiveBalance(balance: string): boolean {
  let normalized: string;
  try {
    normalized = formatStoaAmount(balance);
  } catch {
    return false;
  }
  return Number(normalized) > 0;
}

/**
 * Render a validated decimal balance string at exactly SWEEP_DECIMALS
 * fractional digits via PURE string arithmetic — never `Number(x).toFixed(12)`,
 * which round-trips through a float and silently drifts the exact value, and
 * never the reference `.replace(/0+$/,"")` regex, which strips a trailing-zero
 * integer's magnitude ("10" -> "1"). Right-pads (or truncates) the fraction so
 * integer magnitude is preserved exactly.
 */
function toFixedDecimals(balance: string): string {
  // `formatStoaAmount` already guarantees a non-negative, ≤12-decimal decimal
  // with a single dot; isPositiveBalance has confirmed it parses.
  const normalized = formatStoaAmount(balance);
  const dotIndex = normalized.indexOf('.');
  const intPart = normalized.slice(0, dotIndex);
  const fraction = normalized.slice(dotIndex + 1);
  const padded = fraction.padEnd(SWEEP_DECIMALS, '0').slice(0, SWEEP_DECIMALS);
  return `${intPart}.${padded}`;
}
