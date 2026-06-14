import type { IKadenaKeypair } from '@stoachain/stoa-core/signing';

/**
 * UrStoa COLLECT (chain 0, gasless) core wrapper.
 *
 * Claims the vault's accrued STOA earnings to the active `k:` payment-key coin
 * account. This module is a THIN composition over two SDK primitives:
 *
 *   1. `checkCoinAccountExists(account)` — resolves whether the payment-key coin
 *      account already exists on chain (nullable boolean: `null` collapses
 *      doesn't-exist AND RPC-error into a single uncertainty signal).
 *   2. `executeCollectUrStoa({ paymentKeyAddress, gasStationKey, accountExists })`
 *      — builds + signs + submits the Collect. When `accountExists` is `false`
 *      the executor emits the 2-call create-account-then-collect composite
 *      (`(coin.C_CreateAccount …)(coin.C_URV|Collect …)`); otherwise the plain
 *      `(coin.C_URV|Collect …)`.
 *
 * The wrapper does NOT rebuild pact code, does NOT run its own existence probe,
 * and does NOT decide whether earnings are non-zero (that gating belongs to the
 * collect hook / UI). It faithfully submits a Collect when invoked, and returns
 * a DISCRIMINATED result — never a thrown, secret-bearing Error.
 */

/** A keypair shape carrying signing secrets that must never escape this module. */
interface SecretBearing {
  readonly privateKey?: string;
  readonly password?: string;
  readonly encryptedSecretKey?: unknown;
}

export interface CollectUrStoaParams {
  /** The active `k:` account ADDRESS that the Collect credits. */
  readonly paymentKeyAddress: string;
  /**
   * The active account's KEYPAIR — re-derived by the caller from the unlocked
   * payload — signing BOTH `DALOS.GAS_PAYER` and `coin.URV|COLLECT`. Never
   * derived under an empty mnemonic.
   */
  readonly gasStationKey: IKadenaKeypair;
}

/**
 * Injectable SDK seam. Tests pass doubles to stay fully off-network; the
 * production default lazily wires the node-active `@stoachain/ouronet-core`
 * functions, keeping the live transport out of the browser barrel.
 */
export interface CollectUrStoaDeps {
  /** Resolve payment-key coin-account existence (`true` | `false` | `null`). */
  checkCoinAccountExists: (account: string) => Promise<boolean | null>;
  /** Build + sign + submit the Collect (variant chosen by `accountExists`). */
  executeCollectUrStoa: (params: {
    paymentKeyAddress: string;
    gasStationKey: IKadenaKeypair;
    accountExists: boolean;
  }) => Promise<{ requestKey?: string } & Record<string, unknown>>;
}

export type CollectUrStoaResult =
  | { readonly ok: true; readonly requestKey: string }
  | { readonly ok: false; readonly reason: 'collect-failed'; readonly detail: string };

/** Pull a usable message out of an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

/**
 * Scrub any signing secret (private key, password, encrypted-key blob) out of an
 * outbound detail string. A pathological error message could embed the key
 * material; the discriminated `detail` must never carry it back to the caller.
 */
function scrub(detail: string, key: SecretBearing): string {
  let out = detail;
  const secrets = [key.privateKey, key.password];
  if (key.encryptedSecretKey !== undefined) {
    secrets.push(String(key.encryptedSecretKey));
  }
  for (const secret of secrets) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

/**
 * Resolve the live (node-backed) SDK deps lazily so the barrel-reachable wrapper
 * never statically imports the node-only `@stoachain/ouronet-core` transport.
 */
async function defaultDeps(): Promise<CollectUrStoaDeps> {
  const { checkCoinAccountExists, executeCollectUrStoa } = await import(
    '@stoachain/ouronet-core/interactions/urStoaFunctions'
  );
  return { checkCoinAccountExists, executeCollectUrStoa };
}

/**
 * Submit an UrStoa Collect for the active payment key.
 *
 * Flow: probe coin-account existence → forward the resolved boolean as
 * `accountExists` → submit via the executor. A `null` probe (RPC error or
 * uncertainty) is treated CONSERVATIVELY as `false`, so the executor uses the
 * create-account-then-collect variant rather than assuming the account exists.
 */
export async function collectUrStoa(
  params: CollectUrStoaParams,
  deps?: CollectUrStoaDeps,
): Promise<CollectUrStoaResult> {
  const { paymentKeyAddress, gasStationKey } = params;
  const d = deps ?? (await defaultDeps());

  // `null` collapses doesn't-exist AND RPC-error into "do not assume exists" →
  // the executor builds the safe create-account-then-collect composite.
  let accountExists: boolean;
  try {
    accountExists = (await d.checkCoinAccountExists(paymentKeyAddress)) === true;
  } catch (err) {
    return {
      ok: false,
      reason: 'collect-failed',
      detail: scrub(errorMessage(err), gasStationKey),
    };
  }

  try {
    const submitted = await d.executeCollectUrStoa({
      paymentKeyAddress,
      gasStationKey,
      accountExists,
    });
    return { ok: true, requestKey: submitted.requestKey ?? '' };
  } catch (err) {
    return {
      ok: false,
      reason: 'collect-failed',
      detail: scrub(errorMessage(err), gasStationKey),
    };
  }
}
