import { anuToStoa, GAS_PRICE_MIN_ANU } from '@stoachain/stoa-core/gas';
import { STOA_AUTONOMIC_OURONETGASSTATION } from '@stoachain/ouronet-core/constants';

import type { SignableKeypair } from '../api/sign';
import { buildTransferCode } from './buildTransferCode';
import { signerSetForSameChain } from './gasPayerSigner';

/** The autonomic gas-station account that sponsors every gasless transfer. */
const STOA_GAS_STATION = STOA_AUTONOMIC_OURONETGASSTATION;

/** Minimum gas price in Stoa units (ANU minimum converted once). */
const GAS_PRICE_STOA = anuToStoa(GAS_PRICE_MIN_ANU);

/**
 * A `k:` account is the literal prefix `k:` followed by a 64-char hex Ed25519
 * public key. We NEVER `slice(2)` a recipient without first confirming this
 * exact shape — a malformed prefix would otherwise corrupt the new-account
 * keyset and hand the funds to the wrong guard.
 */
const K_ACCOUNT_RE = /^k:[0-9a-fA-F]{64}$/;

/**
 * On-chain error signature attributable to the gas-payer module specifically:
 * the `DALOS` module/namespace token or the `GAS_PAYER` capability token. We
 * require one of those MODULE signatures — NOT a bare mention of "gas",
 * "eligibility", or "rate-limit", which over-matched generic failures like
 * "gas limit exceeded". Matching this distinguishes a true gas-payer refusal
 * (recoverable via a self-paid retry in a later phase) from a generic simulate/
 * submit failure. We do NOT special-case CORS here — only the DALOS/gas-payer
 * module signature.
 */
const GAS_PAYER_REJECTION_RE = /\bDALOS\b|gas[\s-]?payer|GAS_PAYER/i;

/** Initial gas limit used to simulate before the auto-gas calibration. */
const SIMULATE_GAS_LIMIT = 500_000;

export interface SameChainSendParams {
  /** The sender's `k:` account on the selected chain. */
  readonly sender: string;
  /** The recipient's `k:` account (validated before any build). */
  readonly recipient: string;
  /** Amount as a decimal STRING (never a float) — see buildTransferCode. */
  readonly amount: string;
  /** The SELECTED chain id (0..9). Same-chain: source === target === this. */
  readonly chainId: string;
}

/** A built (unsigned) transaction as the SDK Pact builder emits it. */
export interface BuiltTx {
  readonly cmd: string;
  readonly hash?: string;
  readonly sigs?: unknown;
  readonly [k: string]: unknown;
}

/** The subset of a `dirtyRead` simulate result this flow consumes. */
export interface SimulateResult {
  readonly result?: {
    readonly status?: string;
    readonly error?: { readonly message?: string };
  };
  readonly gas?: number;
}

/** A fully-resolved spec the deps boundary turns into an unsigned transaction. */
export interface BuildTxSpec {
  readonly pactCode: string;
  readonly payloadJson: string;
  readonly caps: readonly [string, string];
  readonly senderAccount: string;
  readonly signerPublicKey: string;
  readonly chainId: string;
  readonly gasLimit: number;
  readonly gasPriceStoa: number;
}

/**
 * Injectable read/build/sign/submit seam. Tests inject doubles to stay fully
 * off-network; the production default lazily wires the node-active SDK client
 * (see `sendSameChain.live.ts`). Keeping the live Pact/client construction
 * behind this seam keeps the orchestrator transport-agnostic and unit-testable.
 */
export interface SameChainDeps {
  /** Per-chain recipient existence read (recipient absent → new account). */
  readAccountExists: (account: string, chainId: string) => Promise<boolean>;
  /** Build an unsigned tx from a fully-resolved spec. */
  buildTx: (spec: BuildTxSpec) => BuiltTx;
  /** Simulate the unsigned tx (dirtyRead) on the selected chain. */
  dirtyRead: (tx: BuiltTx, chainId: string) => Promise<SimulateResult>;
  /** Sign the unsigned tx with the keypair SET. */
  sign: (tx: BuiltTx, keypairs: readonly SignableKeypair[]) => Promise<BuiltTx>;
  /** Submit the signed tx; resolves to a request descriptor. */
  submit: (
    signedTx: BuiltTx,
    chainId: string,
  ) => Promise<{ requestKey?: string; status?: string }>;
  /** Calibrate a final gas limit from the simulate's reported gas. */
  calculateAutoGasLimit: (simGas: number) => number;
}

export type SameChainSendResult =
  | { readonly ok: true; readonly requestKey: string; readonly status?: string }
  | { readonly ok: false; readonly reason: 'invalid-recipient' }
  | { readonly ok: false; readonly reason: 'invalid-amount'; readonly detail?: string }
  | { readonly ok: false; readonly reason: 'precheck-failed'; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: 'gas-payer-rejected';
      readonly detail: string;
      readonly selfPaidFallbackPossible: boolean;
    }
  | { readonly ok: false; readonly reason: 'simulation-failed'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'submit-failed'; readonly detail: string };

function isGasPayerRejection(message: string): boolean {
  return GAS_PAYER_REJECTION_RE.test(message);
}

/** Pull a usable message out of an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

/**
 * Validate a recipient `k:` account: non-empty, exact `k:`+64-hex shape, and
 * not a self-send. Core is the security boundary — the UI does not get to pass
 * a trusted recipient.
 */
function isValidRecipient(recipient: string, sender: string): boolean {
  if (!recipient || !K_ACCOUNT_RE.test(recipient)) return false;
  if (recipient === sender) return false;
  return true;
}

/**
 * Scrub any signing secret (private/secret key, password, encrypted key) out of
 * an outbound detail string. A pathological error message could embed the key
 * material; the discriminated `detail` must never carry it back to the caller.
 */
function scrub(detail: string, keypairs: readonly SignableKeypair[]): string {
  let out = detail;
  for (const kp of keypairs) {
    const secrets = [kp.privateKey, kp.secretKey, kp.password];
    if (kp.encryptedSecretKey) secrets.push(String(kp.encryptedSecretKey));
    for (const secret of secrets) {
      if (secret && out.includes(secret)) {
        out = out.split(secret).join('[redacted]');
      }
    }
  }
  return out;
}

/**
 * Resolve the live (node-backed) deps lazily so the barrel-reachable
 * orchestrator never statically imports the SDK Pact builder / client.
 */
async function defaultDeps(): Promise<SameChainDeps> {
  const { makeLiveSameChainDeps } = await import('./sendSameChain.live');
  return makeLiveSameChainDeps();
}

/**
 * FULL same-chain gasless transfer orchestration, living in core and returning
 * a discriminated result (never a thrown secret-bearing Error). Flow:
 *   validate recipient → resolve per-chain existence → build code/caps/payload
 *   → build tx (gas-station sender, BOTH caps on the sender key) → simulate
 *   → calibrate gas → re-build → sign the keypair SET → submit.
 *
 * The keypair SET (`signingKeypairs`) is `[senderKeypair]` for a k:→k' send —
 * the sender's own key signs both caps; the multi-guard case is a later phase.
 */
export async function sendSameChain(
  params: SameChainSendParams,
  signingKeypairs: readonly SignableKeypair[],
  deps?: SameChainDeps,
): Promise<SameChainSendResult> {
  const { sender, recipient, amount, chainId } = params;

  if (!isValidRecipient(recipient, sender)) {
    return { ok: false, reason: 'invalid-recipient' };
  }

  const d = deps ?? (await defaultDeps());

  // Per-chain existence read decides the verb: absent → C_TransferAnew. A
  // transient read failure here is BEFORE any build/sign/submit — surface it as
  // a discriminated precheck-failed, never an uncaught throw across the boundary
  // (the caller must not misread a pre-submit failure as an ambiguous pending).
  let exists: boolean;
  try {
    exists = await d.readAccountExists(recipient, chainId);
  } catch (err) {
    return {
      ok: false,
      reason: 'precheck-failed',
      detail: scrub(errorMessage(err), signingKeypairs),
    };
  }
  const isNewAccount = !exists;

  // A malformed amount throws inside buildTransferCode/formatStoaAmount; that is
  // a pure validation failure (no tx built) → invalid-amount, never a throw.
  let built: { pactCode: string; payloadJson: string; caps: readonly [string, string] };
  try {
    built = buildTransferCode({ sender, recipient, amount, isNewAccount });
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid-amount',
      detail: scrub(errorMessage(err), signingKeypairs),
    };
  }
  const { pactCode, payloadJson, caps } = built;

  // The sender's own key signs both caps for a same-chain send.
  const signerPublicKey =
    signerSetForSameChain(signingKeypairs[0])[0]?.publicKey ?? '';

  const buildAt = (gasLimit: number): BuiltTx =>
    d.buildTx({
      pactCode,
      payloadJson,
      caps,
      senderAccount: STOA_GAS_STATION,
      signerPublicKey,
      chainId,
      gasLimit,
      gasPriceStoa: GAS_PRICE_STOA,
    });

  // Simulate with a generous limit, then calibrate the real gas from the result.
  const simTx = buildAt(SIMULATE_GAS_LIMIT);

  let simResult: SimulateResult;
  try {
    simResult = await d.dirtyRead(simTx, chainId);
  } catch (err) {
    return {
      ok: false,
      reason: 'simulation-failed',
      detail: scrub(errorMessage(err), signingKeypairs),
    };
  }

  if (simResult.result?.status === 'failure') {
    const detail = scrub(
      simResult.result.error?.message ?? 'Simulation failed',
      signingKeypairs,
    );
    if (isGasPayerRejection(detail)) {
      return {
        ok: false,
        reason: 'gas-payer-rejected',
        detail,
        selfPaidFallbackPossible: true,
      };
    }
    return { ok: false, reason: 'simulation-failed', detail };
  }

  const gasLimit = d.calculateAutoGasLimit(simResult.gas ?? SIMULATE_GAS_LIMIT);
  const finalTx = buildAt(gasLimit);

  const signed = await d.sign(finalTx, signingKeypairs);

  let submitted: { requestKey?: string; status?: string };
  try {
    submitted = await d.submit(signed, chainId);
  } catch (err) {
    const detail = scrub(errorMessage(err), signingKeypairs);
    if (isGasPayerRejection(detail)) {
      return {
        ok: false,
        reason: 'gas-payer-rejected',
        detail,
        selfPaidFallbackPossible: true,
      };
    }
    return { ok: false, reason: 'submit-failed', detail };
  }

  return {
    ok: true,
    requestKey: submitted.requestKey ?? '',
    status: submitted.status,
  };
}
