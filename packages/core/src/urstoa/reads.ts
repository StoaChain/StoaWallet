import { mayComeWithDeimal } from '@stoachain/stoa-core/pact';

/**
 * The on-chain vault account that holds the total staked UrStoa. `getVaultTotal`
 * reads this account's UrStoa balance; T12.7's last-staker floor compares a
 * user's staked amount against it. Sourced from the grounded UrStoa facts and
 * the OuronetUI `UnstakeUrStoaModal` reference.
 */
export const VAULT_ADDRESS = 'c:GjYbBFM0vxMs5FcmnFUW-LFoycd3Ef8wuP28vR6FG3k';

/**
 * The injectable read seam over the two `@stoachain/ouronet-core` UrStoa reads,
 * so tests run fully off-network and the wrapper never re-implements the chain
 * call. The live default (see `reads.live.ts`) lazily wires the real SDK reads,
 * which resolve their endpoint through the active-node config — so a custom node
 * (Phase 10 `configureNode`/`setNodeConfig`) is honored without this wrapper
 * hardcoding any node.
 */
export interface UrStoaReadDeps {
  /** URC_0002_Primordials selector read for the account (chain 0). */
  getPrimordials: (account: string) => Promise<unknown>;
  /**
   * Native UrStoa balance for any account. Resolves `null` on non-existence OR
   * RPC error — an uncertainty signal the caller must NOT collapse to `0`.
   */
  getUrStoaBalance: (account: string) => Promise<number | null>;
}

/**
 * The UrStoa holdings extracted from a Primordials row — ONLY the UrStoa-relevant
 * figures. `wrapped-balance`/`wrapped-id` are deliberately never surfaced.
 * Earnings are denominated in STOA and already `{decimal}`-unwrapped to a string.
 */
export interface UrStoaHoldings {
  /** From `payment-key-balance` — the spendable wallet UrStoa balance. */
  readonly walletBalance: string;
  /** From `urstoa-vault-balance` — the user's staked UrStoa in the vault. */
  readonly vaultBalance: string;
  /** From `urstoa-vault-earnings` (`{decimal}`-unwrapped) — pending earnings in STOA. */
  readonly vaultEarnings: string;
  /** Optional `urstoa-vault-stoa-supply` when the row carries it. */
  readonly vaultStoaSupply?: string;
}

/** Discriminated holdings result — success carries the typed shape, failure a reason. */
export type UrStoaHoldingsResult =
  | { readonly ok: true; readonly holdings: UrStoaHoldings }
  | { readonly ok: false; readonly reason: 'read-failed' };

/**
 * Discriminated vault-total result. `unknown` is the DISTINCT null-vs-zero
 * state: the vault read resolved `null` (non-existence / RPC error), which must
 * never be coerced to `"0"` (that would let T12.7 lift the last-staker floor).
 * `read-failed` is a thrown read. Neither is `vaultTotal:"0"`.
 */
export type VaultTotalResult =
  | { readonly ok: true; readonly vaultTotal: string }
  | { readonly ok: false; readonly reason: 'unknown' | 'read-failed' };

/**
 * Resolve the live (node-backed) read seam lazily so the barrel-reachable
 * wrapper never statically imports the SDK reads (which carry node-active
 * transport). The `.live.ts` default is browser-safe (no `node:` deps).
 */
async function defaultDeps(): Promise<UrStoaReadDeps> {
  const { makeLiveUrStoaReadDeps } = await import('./reads.live');
  return makeLiveUrStoaReadDeps();
}

/** Unwrap a `{decimal}` envelope (or plain number/string) to a canonical string. */
function asString(raw: unknown): string {
  return String(mayComeWithDeimal(raw));
}

/**
 * Read an account's UrStoa holdings on chain 0 via `getPrimordials`, extracting
 * ONLY the UrStoa-relevant fields. All decimal figures are unwrapped via the SDK
 * `mayComeWithDeimal` helper (never `String()` of the raw `{decimal}` envelope,
 * which would yield `"[object Object]"` and break the Collect gate). A thrown
 * read or a `null` Primordials response (the SDK's Pact/network-error contract)
 * collapses to a discriminated `{ ok:false, reason:'read-failed' }` — never a
 * thrown Error. Emits no logs (the `k:` account is public but kept logging-free).
 */
export async function getUrStoaHoldings(
  account: string,
  deps?: UrStoaReadDeps,
): Promise<UrStoaHoldingsResult> {
  const d = deps ?? (await defaultDeps());

  try {
    const prims = await d.getPrimordials(account);
    if (!prims || typeof prims !== 'object') {
      return { ok: false, reason: 'read-failed' };
    }

    const row = prims as Record<string, unknown>;
    const holdings: UrStoaHoldings = {
      walletBalance: asString(row['payment-key-balance'] ?? '0'),
      vaultBalance: asString(row['urstoa-vault-balance'] ?? '0'),
      vaultEarnings: asString(row['urstoa-vault-earnings'] ?? '0'),
      ...('urstoa-vault-stoa-supply' in row
        ? { vaultStoaSupply: asString(row['urstoa-vault-stoa-supply']) }
        : {}),
    };

    return { ok: true, holdings };
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
}

/**
 * Read the vault's total staked UrStoa via `getUrStoaBalance(VAULT_ADDRESS)` and
 * return it as a string. A `null` balance (non-existence / RPC error) is the
 * DISTINCT `unknown` state — never a coerced `"0"` (fail-closed for T12.7's
 * last-staker floor, bug-F-001). A thrown read collapses to `read-failed`.
 */
export async function getVaultTotal(deps?: UrStoaReadDeps): Promise<VaultTotalResult> {
  const d = deps ?? (await defaultDeps());

  try {
    const total = await d.getUrStoaBalance(VAULT_ADDRESS);
    if (total === null || total === undefined || !Number.isFinite(total)) {
      return { ok: false, reason: 'unknown' };
    }
    return { ok: true, vaultTotal: String(total) };
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
}
