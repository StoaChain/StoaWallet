/**
 * The on-chain vault account that holds the total staked UrStoa. `getVaultTotal`
 * reads this account's UrStoa balance; T12.7's last-staker floor compares a
 * user's staked amount against it. Sourced from the grounded UrStoa facts and
 * the OuronetUI `UnstakeUrStoaModal` reference.
 */
export const VAULT_ADDRESS = 'c:GjYbBFM0vxMs5FcmnFUW-LFoycd3Ef8wuP28vR6FG3k';

/**
 * The injectable read seam over the UrStoa on-chain reads, so tests run fully
 * off-network and the wrapper never re-implements the chain call. The live
 * default (see `reads.live.ts`) wires the real reads, which resolve their
 * endpoint through the active-node config — so a custom node (Phase 10
 * `configureNode`/`setNodeConfig`) is honored without this wrapper hardcoding
 * any node.
 *
 * The three holdings figures each have their OWN authoritative `coin.*` read,
 * each returning a precision-preserving decimal STRING (or `null` on an
 * RPC/non-success — an uncertainty signal the caller must NOT collapse to `0`):
 *   - wallet    → `(coin.UR_UR|Balance <account>)`        — spendable UrStoa.
 *   - vault     → `(coin.UR_URV|UserSupply <account>)`     — staked UrStoa.
 *   - claimable → `(coin.URC_URV|ClaimableRewards <account>)` — STOA the account
 *                 can collect from the vault.
 */
export interface UrStoaReadDeps {
  /** Spendable wallet UrStoa: `(coin.UR_UR|Balance <account>)`. String, `null` on error. */
  getWalletBalance: (account: string) => Promise<string | null>;
  /** Staked vault UrStoa for the account: `(coin.UR_URV|UserSupply <account>)`. String, `null` on error. */
  getVaultUserSupply: (account: string) => Promise<string | null>;
  /** Claimable STOA rewards: `(coin.URC_URV|ClaimableRewards <account>)`. String, `null` on error. */
  getClaimableRewards: (account: string) => Promise<string | null>;
  /**
   * The vault account's TOTAL staked UrStoa for the last-staker floor — reads
   * `getUrStoaBalance(VAULT_ADDRESS)`. `null` (non-existence / RPC error) is the
   * caller's uncertainty signal; it must NOT be coerced to `0`.
   */
  getUrStoaBalance: (account: string) => Promise<number | null>;
}

/**
 * The UrStoa holdings for an account — the three figures the UrStoa tab shows.
 * Each is a precision-preserving decimal STRING or `null` (the DISTINCT unknown
 * state — a failed read of THAT figure, never coerced to `"0"`). UrStoa figures
 * carry 3 decimals on-chain; the STOA-denominated `vaultEarnings` carries 12.
 */
export interface UrStoaHoldings {
  /** From `coin.UR_UR|Balance` — the spendable wallet UrStoa balance. */
  readonly walletBalance: string | null;
  /** From `coin.UR_URV|UserSupply` — the account's staked UrStoa in the vault. */
  readonly vaultBalance: string | null;
  /** From `coin.URC_URV|ClaimableRewards` — collectable STOA the vault generated. */
  readonly vaultEarnings: string | null;
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

/**
 * Read an account's UrStoa holdings on chain 0 from the three authoritative
 * `coin.*` reads concurrently: wallet (`UR_UR|Balance`), vault stake
 * (`UR_URV|UserSupply`), and claimable STOA (`URC_URV|ClaimableRewards`). Each
 * figure is independent — a single read that resolves `null` surfaces as `null`
 * for THAT figure (the distinct unknown, never coerced to `"0"`) while the
 * others stand. Only a thrown read collapses the whole call to a discriminated
 * `{ ok:false, reason:'read-failed' }` — never a thrown Error. Emits no logs
 * (the `k:` account is public but kept logging-free).
 */
export async function getUrStoaHoldings(
  account: string,
  deps?: UrStoaReadDeps,
): Promise<UrStoaHoldingsResult> {
  const d = deps ?? (await defaultDeps());

  try {
    const [walletBalance, vaultBalance, vaultEarnings] = await Promise.all([
      d.getWalletBalance(account),
      d.getVaultUserSupply(account),
      d.getClaimableRewards(account),
    ]);

    return { ok: true, holdings: { walletBalance, vaultBalance, vaultEarnings } };
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
