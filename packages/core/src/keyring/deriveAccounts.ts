import { deriveAccount } from '../api/derive';

/**
 * A discovered StoaChain account at a single HD index. Carries only public
 * material — `publicKey` (64-char Ed25519 hex), the on-chain `k:` `account`
 * for a single-key guard, the absolute HD `index`, and the `derivationPath`
 * the caller persists to re-derive on unlock. The password-bound encrypted
 * secret is intentionally NOT part of this surface: account discovery deals in
 * addresses, not signing material.
 */
export interface AccountRecord {
  readonly index: number;
  readonly publicKey: string;
  readonly account: string;
  readonly derivationPath: string;
}

/** StoaChain SLIP-10 path for a koala (24-word) account at the given index. */
function derivationPathFor(index: number): string {
  return `m'/44'/626'/${index}'`;
}

/**
 * Derive `count` consecutive `k:` accounts from a 24-word koala mnemonic,
 * starting at HD index `startIndex`.
 *
 * Delegates each index to the Phase-1 single-account `deriveAccount` rather
 * than calling the SDK builder a second time — this keeps a single derivation
 * site, so the empty-password guard and `k:` address shape are defined in
 * exactly one place. The returned records expose only public material; the
 * SDK's password-bound encrypted secret is dropped here on purpose.
 *
 * Deterministic: the same (mnemonic, password, index) triple always yields the
 * same public key / account.
 *
 * @throws {Error} if `password` is empty — propagated from `deriveAccount`,
 *   which refuses to derive under a default/empty password.
 */
export async function deriveAccounts(
  mnemonic: string,
  password: string,
  startIndex: number,
  count: number,
): Promise<AccountRecord[]> {
  const records: AccountRecord[] = [];

  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset;
    const { publicKey, account } = await deriveAccount(
      mnemonic,
      password,
      index,
    );

    records.push({
      index,
      publicKey,
      account,
      derivationPath: derivationPathFor(index),
    });
  }

  return records;
}
