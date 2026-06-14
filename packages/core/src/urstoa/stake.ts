import {
  executeStakeUrStoa as sdkExecuteStakeUrStoa,
  executeUnstakeUrStoa as sdkExecuteUnstakeUrStoa,
} from '@stoachain/ouronet-core/interactions/urStoaFunctions';
import type { IKadenaKeypair } from '@stoachain/stoa-core/signing';

/**
 * On-chain error signature attributable to the gas-payer module specifically:
 * the `DALOS` module/namespace token or the `GAS_PAYER` capability token. A
 * true sponsor refusal is distinguished from a generic submit failure so a
 * later phase can offer a self-paid retry. A bare mention of "gas" must NOT
 * over-match here.
 */
const GAS_PAYER_REJECTION_RE = /\bDALOS\b|gas[\s-]?payer|GAS_PAYER/i;

/**
 * Inputs for the chain-0 gasless STAKE/UNSTAKE wrappers.
 *
 * `paymentKeyAddress` is the active `k:` account ADDRESS (a string), which the
 * SDK interpolates into the pact code `(coin.C_URV|Stake "<pk>" <dec>)` and the
 * `coin.URV|STAKE` cap params.
 *
 * `amount` is the PRE-FORMATTED decimal string the caller produced via the SDK
 * `formatDecimalForPact` (scale 24). This wrapper passes it through verbatim —
 * it never reformats and never re-implements the pact build.
 *
 * `gasStationKey` is the active account's KEYPAIR (re-derived by the caller from
 * the unlocked payload). For this k:-only wallet it IS the user's own
 * cap-signing key — it signs BOTH the `DALOS.GAS_PAYER` cap AND the op cap. The
 * SDK param name is `gasStationKey`, but it is NOT a separate service key here.
 */
export interface UrStoaStakeParams {
  readonly paymentKeyAddress: string;
  readonly amount: string;
  readonly gasStationKey: IKadenaKeypair;
}

/** Shape the SDK executors return on a successful submit. */
interface ExecutorResult {
  readonly requestKey?: string;
  readonly status?: string;
}

/**
 * Injectable SDK-executor seam. Tests inject doubles to stay fully off-network;
 * the production default is the real `@stoachain/ouronet-core` executor pair.
 * The wrapper COMPOSES these executors (which own the pact build + caps) — it
 * does not re-implement the pact code.
 */
export interface StakeDeps {
  executeStakeUrStoa: (p: UrStoaStakeParams) => Promise<ExecutorResult>;
  executeUnstakeUrStoa: (p: UrStoaStakeParams) => Promise<ExecutorResult>;
}

export type UrStoaStakeResult =
  | { readonly ok: true; readonly requestKey: string; readonly status?: string }
  | {
      readonly ok: false;
      readonly reason: 'gas-payer-rejected';
      readonly detail: string;
    }
  | { readonly ok: false; readonly reason: 'submit-failed'; readonly detail: string };

const DEFAULT_DEPS: StakeDeps = {
  executeStakeUrStoa: sdkExecuteStakeUrStoa,
  executeUnstakeUrStoa: sdkExecuteUnstakeUrStoa,
};

/** Pull a usable message out of an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

/**
 * Scrub any signing secret (private key, password, encrypted key) out of an
 * outbound detail string. A pathological executor error could embed the key
 * material; the discriminated `detail` must never carry it back to the caller.
 */
function scrub(detail: string, key: IKadenaKeypair): string {
  let out = detail;
  const secrets: string[] = [key.privateKey];
  if (key.password) secrets.push(key.password);
  if (key.encryptedSecretKey) secrets.push(String(key.encryptedSecretKey));
  for (const secret of secrets) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

/** Map a thrown executor error to a discriminated, secret-scrubbed result. */
function toFailure(err: unknown, key: IKadenaKeypair): UrStoaStakeResult {
  const detail = scrub(errorMessage(err), key);
  if (GAS_PAYER_REJECTION_RE.test(detail)) {
    return { ok: false, reason: 'gas-payer-rejected', detail };
  }
  return { ok: false, reason: 'submit-failed', detail };
}

/**
 * Chain-0 gasless STAKE wrapper. Thin composition over the SDK
 * `executeStakeUrStoa` — which builds `(coin.C_URV|Stake "<pk>" <dec>)` and
 * signs the `DALOS.GAS_PAYER` + `coin.URV|STAKE` caps, BOTH on the payment key.
 *
 * The CAP-string casing INTENTIONALLY differs from the CALL casing
 * (cap `coin.URV|STAKE` vs call `coin.C_URV|Stake`) — this is DELIBERATE on
 * the contract side; do NOT "normalize" it.
 *
 * The last-staker vault floor is NOT enforced here — the executor doesn't know
 * the vault total, so this wrapper faithfully submits whatever amount it's
 * given. Floor gating is the T12.7 hook's responsibility.
 */
export async function stakeUrStoa(
  params: UrStoaStakeParams,
  deps: StakeDeps = DEFAULT_DEPS,
): Promise<UrStoaStakeResult> {
  const { paymentKeyAddress, amount, gasStationKey } = params;
  try {
    const res = await deps.executeStakeUrStoa({
      paymentKeyAddress,
      amount,
      gasStationKey,
    });
    return { ok: true, requestKey: res.requestKey ?? '', status: res.status };
  } catch (err) {
    return toFailure(err, gasStationKey);
  }
}

/**
 * Chain-0 gasless UNSTAKE wrapper. Symmetric to {@link stakeUrStoa}, composing
 * the SDK `executeUnstakeUrStoa` — which builds `(coin.C_URV|Unstake "<pk>"
 * <dec>)` and signs `DALOS.GAS_PAYER` + `coin.URV|UNSTAKE` (NOT `STAKE`), both
 * on the payment key. Same cap-vs-call casing note as Stake.
 */
export async function unstakeUrStoa(
  params: UrStoaStakeParams,
  deps: StakeDeps = DEFAULT_DEPS,
): Promise<UrStoaStakeResult> {
  const { paymentKeyAddress, amount, gasStationKey } = params;
  try {
    const res = await deps.executeUnstakeUrStoa({
      paymentKeyAddress,
      amount,
      gasStationKey,
    });
    return { ok: true, requestKey: res.requestKey ?? '', status: res.status };
  } catch (err) {
    return toFailure(err, gasStationKey);
  }
}
