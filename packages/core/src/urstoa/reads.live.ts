/**
 * Live (node-backed) read seam for {@link getUrStoaHoldings} / {@link getVaultTotal}.
 *
 * This file is the ONLY place the UrStoa reads touch the real chain, mirroring
 * `advanced/fetchAccountGuard.live.ts`. It is kept OUT of the package barrel on
 * purpose so the barrel-reachable wrapper never statically imports the SDK
 * transport. Every read resolves its endpoint through the active-node config
 * itself, so a custom node (Phase 10) is honored without this seam hardcoding
 * any node. Imports no `node:` modules — browser-safe even out of the barrel.
 *
 * The three holdings figures are read with their authoritative `coin.*`
 * functions as PRECISION-PRESERVING strings (the values are never round-tripped
 * through a JS `number`, so a 12-decimal STOA reward never drifts):
 *   - `(try 0.0 (coin.UR_UR|Balance "<account>"))`        — wallet UrStoa.
 *   - `(try 0.0 (coin.UR_URV|UserSupply "<account>"))`     — staked UrStoa.
 *   - `(try 0.0 (coin.URC_URV|ClaimableRewards "<account>"))` — claimable STOA.
 *
 * Each is wrapped in `(try 0.0 …)` so a non-existent position reads as a real
 * `0`, while a genuine node/RPC failure (non-`success` status or a throw)
 * collapses to `null` — the distinct unknown the UI shows as a dash, never `0`.
 */
import { pactRead } from '@stoachain/stoa-core/reads';
import { getUrStoaBalance } from '@stoachain/ouronet-core/interactions/urStoaFunctions';

import type { UrStoaReadDeps } from './reads';

/**
 * Coerce a Pact read's `result.data` to a canonical decimal STRING, or `null`
 * when it is not a finite numeric value. Handles a Pact `{ decimal }` envelope
 * (kept as a string — never `String(obj)` → `"[object Object]"`), a bare number,
 * and a numeric string; anything else (a status string, a bool from a failed
 * `try`) is `null`.
 */
function asDecimalString(data: unknown): string | null {
  if (data === null || data === undefined) return null;
  if (typeof data === 'number') return Number.isFinite(data) ? String(data) : null;
  if (typeof data === 'object' && 'decimal' in (data as Record<string, unknown>)) {
    const s = String((data as { decimal: unknown }).decimal);
    return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
  }
  const s = String(data);
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

/**
 * One gasless dirty-read returning the figure as a precision-preserving string,
 * or `null` on any non-`success` status or a thrown transport error.
 */
async function readDecimalString(pactCode: string): Promise<string | null> {
  try {
    const response = await pactRead(pactCode, { tier: 'T5' });
    if (response?.result?.status === 'success') {
      return asDecimalString((response.result as { data?: unknown }).data);
    }
    return null;
  } catch {
    return null;
  }
}

/** Build the production read seam over the live, active-node UrStoa reads. */
export function makeLiveUrStoaReadDeps(): UrStoaReadDeps {
  return {
    getWalletBalance: (account) =>
      readDecimalString(`(try 0.0 (coin.UR_UR|Balance "${account}"))`),
    getVaultUserSupply: (account) =>
      readDecimalString(`(try 0.0 (coin.UR_URV|UserSupply "${account}"))`),
    getClaimableRewards: (account) =>
      readDecimalString(`(try 0.0 (coin.URC_URV|ClaimableRewards "${account}"))`),
    getUrStoaBalance: (account) => getUrStoaBalance(account),
  };
}
