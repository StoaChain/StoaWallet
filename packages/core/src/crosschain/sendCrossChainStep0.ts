import type { SignableKeypair } from '../api/sign';
import { isRecoverableSubmitError } from './timeout';
import type {
  BuildStep0Deps,
  BuildStep0Input,
  BuildStep0Reason,
  BuildStep0Result,
  UnsignedTx,
} from './buildStep0';

/**
 * Bounded confirm-retry budget: a transient network blip on `listen` is
 * absorbed by re-listening, but we never retry forever — after this many
 * consecutive confirm failures the burn is reported as a recoverable PENDING
 * (use the Continue tab with the request key). Named so the bound is auditable.
 */
const CONFIRM_MAX_ATTEMPTS = 3;

/** Backoff between confirm attempts, in milliseconds. */
const CONFIRM_DELAY_MS = 2000;

/** The Step-0 request a single cross-chain burn is identified by. */
export interface SendCrossChainStep0Input {
  /** Sender `k:` account on the source chain. */
  readonly sender: string;
  /** Recipient `k:` account (validated inside the build). */
  readonly receiver: string;
  /** Amount as a decimal STRING (never a float). */
  readonly amount: string;
  /** Source chain id (0..9) the burn commits on. */
  readonly sourceChain: string;
  /** Target chain id (0..9) the later continuation mints on. */
  readonly targetChain: string;
  /** Sender's Ed25519 public key (the primary signer). */
  readonly senderPublicKey: string;
  /** Required on chain 0 (the Ouronet Gas Station co-signer); ignored otherwise. */
  readonly gasStationPublicKey?: string;
}

/** The chainweb command-result envelope `listen` resolves to. */
export interface ListenResult {
  readonly result?: {
    readonly status?: string;
    readonly error?: { readonly message?: string };
  };
  readonly [k: string]: unknown;
}

/**
 * Injectable build/sign/submit/confirm seam. Tests inject doubles to stay fully
 * off-network and pin composition order + money-safety branching; the production
 * default lazily wires the SDK (see `sendCrossChainStep0.live.ts`) so this
 * barrel-reachable orchestrator never statically imports node-only transport.
 */
export interface SendCrossChainStep0Deps {
  /** The pure step-0 build (validate → resolve guard → build unsigned tx). */
  buildStep0: (
    input: BuildStep0Input,
    deps?: BuildStep0Deps,
  ) => Promise<BuildStep0Result>;
  /** Sign the unsigned tx with the keypair SET via the universal signer. */
  signTransaction: (
    tx: UnsignedTx,
    keypairs: readonly SignableKeypair[],
  ) => Promise<UnsignedTx>;
  /** Submit on the source chain; THROWS on hard failure (code:"TIMEOUT" on deadline). */
  submit: (
    signedTx: UnsignedTx,
    sourceChain: string,
  ) => Promise<{ requestKey?: string }>;
  /** Failover-aware completion listen; THROWS code:"TIMEOUT" on the per-tier deadline. */
  listen: (requestKey: string, chainId: string) => Promise<ListenResult>;
  /** True iff the thrown value carries `code === "TIMEOUT"` (the SDK contract). */
  isTimeout: (err: unknown) => boolean;
  /** Backoff between confirm retries; defaults to {@link CONFIRM_DELAY_MS}. */
  sleep?: (ms: number) => Promise<void>;
}

export type SendCrossChainStep0Reason =
  | BuildStep0Reason
  | 'submit-failed'
  | 'step0-failed'
  | 'network-lost-pending';

export type SendCrossChainStep0Result =
  | {
      readonly ok: true;
      readonly requestKey: string;
      readonly sourceChain: string;
      readonly targetChain: string;
    }
  | {
      readonly ok: false;
      readonly reason: SendCrossChainStep0Reason;
      readonly requestKey?: string;
      readonly detail?: string;
    };

/** Pull a usable message out of an unknown thrown value (never the secret). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}

/**
 * Scrub any signing secret (private/secret key, password, encrypted key) out of
 * an outbound detail string. A pathological error message could embed key
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

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Default timeout detector: any thrown value carrying `code === "TIMEOUT"`. */
function defaultIsTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'TIMEOUT';
}

/**
 * Resolve the live SDK-backed deps lazily so the barrel-reachable orchestrator
 * never statically imports the SDK's node-only cross-chain transport.
 */
async function defaultDeps(): Promise<SendCrossChainStep0Deps> {
  const { makeLiveSendCrossChainStep0Deps } = await import(
    './sendCrossChainStep0.live'
  );
  return makeLiveSendCrossChainStep0Deps();
}

/**
 * Confirm a submitted (or ambiguously-submitted) burn via the failover-aware
 * `listen`. A genuine on-chain `failure` is terminal (`step0-failed`). A
 * confirmation LOST to a network error or a `listen` TIMEOUT — after exhausting
 * the bounded retry — is PENDING (`network-lost-pending`) carrying the request
 * key: the burn MAY have confirmed on chain, so the caller resumes via the
 * Continue tab and NEVER resubmits (a resubmit would double-commit the burn).
 */
async function confirmStep0(
  requestKey: string,
  sourceChain: string,
  targetChain: string,
  deps: SendCrossChainStep0Deps,
  keypairs: readonly SignableKeypair[],
): Promise<SendCrossChainStep0Result> {
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  for (let attempt = 1; attempt <= CONFIRM_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await deps.listen(requestKey, sourceChain);
      if (res.result?.status === 'failure') {
        return {
          ok: false,
          reason: 'step0-failed',
          requestKey,
          detail: scrub(res.result.error?.message ?? 'Step 0 failed on-chain', keypairs),
        };
      }
      return { ok: true, requestKey, sourceChain, targetChain };
    } catch {
      // A TIMEOUT or any network-class error is NOT a definitive failure — the
      // burn may still confirm. Retry within the bound; only after exhausting it
      // do we surface a recoverable PENDING. Never resubmit here.
      if (attempt < CONFIRM_MAX_ATTEMPTS) {
        await sleep(CONFIRM_DELAY_MS);
        continue;
      }
      return { ok: false, reason: 'network-lost-pending', requestKey };
    }
  }
  return { ok: false, reason: 'network-lost-pending', requestKey };
}

/**
 * FULL step-0 cross-chain orchestration: build → sign → submit → confirm,
 * returning a discriminated result (never a thrown secret-bearing Error).
 *
 * Money-safety contract:
 *   - A build refusal propagates verbatim; nothing is signed or submitted.
 *   - gas-mode signing (RR#3): `gas-station` (source "0") signs with BOTH the
 *     sender and gas keypairs (the DALOS.GAS_PAYER co-signer); `xchain-gas`
 *     (source ≠ "0") signs with ONLY the sender. The `signingKeypairs` SET
 *     carries the right count; the orchestrator forwards the whole set.
 *   - A definitive (non-TIMEOUT, non-network) submit error → `submit-failed`;
 *     confirm is NOT attempted (the tx did not land).
 *   - A submit TIMEOUT or a network-class submit error → the tx MAY have landed;
 *     recover the request key from the signed hash and flow into confirm.
 *   - A confirm `failure` → `step0-failed`. A confirm LOST to network/TIMEOUT
 *     after bounded retry → `network-lost-pending` (resume via the Continue tab).
 *   - NEVER auto-resubmits.
 */
export async function sendCrossChainStep0(
  input: SendCrossChainStep0Input,
  signingKeypairs: readonly SignableKeypair[],
  deps?: SendCrossChainStep0Deps,
): Promise<SendCrossChainStep0Result> {
  const d = deps ?? (await defaultDeps());
  const { sourceChain, targetChain } = input;

  const built = await d.buildStep0({
    sender: input.sender,
    receiver: input.receiver,
    amount: input.amount,
    sourceChain,
    targetChain,
    senderPublicKey: input.senderPublicKey,
    gasStationPublicKey: input.gasStationPublicKey,
  });
  if (!built.ok) {
    // Propagate the build refusal verbatim — nothing signed, nothing submitted.
    return { ok: false, reason: built.reason };
  }

  const signed = await d.signTransaction(built.tx, signingKeypairs);

  // Recover the request key from the signed tx hash so a submit TIMEOUT (or a
  // network-class submit error where the tx MAY have landed) can still confirm.
  const recoveredKey = (signed.hash || built.tx.hash) ?? '';

  let requestKey: string;
  try {
    const submitted = await d.submit(signed, sourceChain);
    requestKey = submitted.requestKey ?? recoveredKey;
  } catch (err) {
    // A TIMEOUT means the tx may have landed — flow into confirm. A network-class
    // error (the tx MAY have landed) also flows into confirm. Both are covered by
    // the single-sourced `isRecoverableSubmitError` (PAT-003 / F-004), the BROADER
    // burn-leg policy that errs safe; the injected `d.isTimeout` seam is honored
    // first so tests can pin a custom timeout signal. Only a definitive,
    // non-timeout, non-network error means the tx did NOT land → submit-failed.
    if (d.isTimeout(err) || isRecoverableSubmitError(err)) {
      requestKey = recoveredKey;
    } else {
      return {
        ok: false,
        reason: 'submit-failed',
        detail: scrub(errorMessage(err), signingKeypairs),
      };
    }
  }

  return confirmStep0(requestKey, sourceChain, targetChain, d, signingKeypairs);
}

export {
  CONFIRM_MAX_ATTEMPTS,
  CONFIRM_DELAY_MS,
  defaultIsTimeout,
};
