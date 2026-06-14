import type { SignableKeypair } from '../api/sign';
import type { StorageAdapter } from '../storage/StorageAdapter';
import { MINER_AGGREGATION_KEY } from '../storage/storageKeys';
import {
  sendCrossChainStep0,
  type SendCrossChainStep0Deps,
  type SendCrossChainStep0Input,
  type SendCrossChainStep0Result,
} from '../crosschain/sendCrossChainStep0';
import type { UnsignedTx } from '../crosschain/buildStep0';
import {
  pollProofAndContinue,
  type PollProofAndContinueOptions,
  type PollProofAndContinueParams,
  type PollProofAndContinueResult,
} from '../crosschain/pollAndContinue';
import type { SweepSource } from './sweepPlan';

/**
 * The per-chain progress stages a sweep advances through, surfaced to the caller
 * via `onChainProgress`. The terminal stages mirror the per-chain result
 * `outcome` so a hook can drive its state machine off a single channel.
 */
export type MinerChainStage =
  | 'submitting'
  | 'confirming'
  | 'waiting-spv'
  | 'completing'
  | 'done'
  | 'error'
  | 'network-lost'
  | 'spv-timeout'
  | 'continuation-pending'
  | 'guard-unavailable';

/** A single per-chain progress update forwarded to `onChainProgress`. */
export interface MinerChainProgress {
  readonly stage: MinerChainStage;
  /** Present from `confirming` onward (the Step-0 request key for recovery). */
  readonly requestKey?: string;
  /** Forwarded from the reused `pollProofAndContinue` SPV poll cadence. */
  readonly spvAttempt?: number;
  readonly spvMaxAttempts?: number;
  /** Present on `done` (the target-chain continuation request key). */
  readonly continuationKey?: string;
  /** Scrubbed failure/pending message for the terminal stages. */
  readonly detail?: string;
}

/**
 * The terminal outcome for one source chain. A discriminated value — never a
 * thrown secret-bearing Error. PENDING outcomes (`network-lost`, `spv-timeout`,
 * `continuation-pending`, `guard-unavailable`) all carry the data needed to route
 * the chain to recovery WITHOUT ever auto-resubmitting:
 *
 * - `done` — Step-0 burn confirmed AND the target continuation landed.
 * - `error` — a HARD failure (`submit-failed`/`step0-failed`/`continuation-failed`
 *   or an invalid build) — nothing to recover; the funds did not move.
 * - `network-lost` — Step-0 confirm was lost to the network (the burn MAY have
 *   committed). PENDING: carries the requestKey; resume via the Continue tab.
 * - `spv-timeout` — the SPV proof never arrived within the bound. PENDING: the
 *   burn committed; re-poll later with the requestKey.
 * - `continuation-pending` — the continuation submit TIMED OUT (it MAY have
 *   committed). PENDING: re-check with the requestKey, NEVER resubmit (RR#1).
 * - `guard-unavailable` — the target keyset read failed for an EXISTING account;
 *   retryable PENDING (RR#6) — never fabricated keys-all on a present account.
 */
export type MinerChainOutcome =
  | 'done'
  | 'error'
  | 'network-lost'
  | 'spv-timeout'
  | 'continuation-pending'
  | 'guard-unavailable';

export interface MinerChainResult {
  readonly chainId: string;
  readonly outcome: MinerChainOutcome;
  /** The Step-0 request key — present for `done` and every PENDING outcome. */
  readonly requestKey?: string;
  /** The target-chain continuation key — present for `done`. */
  readonly continuationKey?: string;
  /** Scrubbed detail for a failure/pending outcome. */
  readonly detail?: string;
}

/**
 * Injectable seam over the two Phase-5 orchestrators this fan-out REUSES (it
 * never re-calls the SDK trio directly). Tests inject stubs to stay off-network
 * and pin the isolation + TIMEOUT-as-pending branching; the production default
 * wires the real `sendCrossChainStep0` / `pollProofAndContinue`.
 */
/**
 * A remote-mode signing override (XP-12): given the unsigned step-0 tx, returns
 * the signed tx WITHOUT the secret ever entering this orchestrator. In remote
 * (extension) mode the caller passes the active account's PUBLIC-only keypair set
 * (for the signer-cap construction) plus this override, which routes the actual
 * signature through the background service worker. Absent in local mode (the
 * keypair set carries live key material and core's default signer runs).
 */
export type RemoteSignTransaction = (tx: UnsignedTx) => Promise<UnsignedTx>;

export interface AggregateDeps {
  /**
   * Phase-5 FULL Step-0: build → sign(SET) → submit → bounded confirm. When a
   * `signTransaction` override is supplied (remote mode) it is forwarded so the
   * step-0 SIGN leg routes through the background instead of the local signer.
   */
  sendCrossChain: (
    input: SendCrossChainStep0Input,
    signingKeypairs: readonly SignableKeypair[],
    signTransaction?: RemoteSignTransaction,
  ) => Promise<SendCrossChainStep0Result>;
  /** Phase-5 Step-1: SPV poll → build → submit continuation. */
  pollProofAndContinue: (
    params: PollProofAndContinueParams,
    deps?: undefined,
    options?: PollProofAndContinueOptions,
  ) => Promise<PollProofAndContinueResult>;
}

export interface AggregateAcrossChainsParams {
  /** The funded source chains to sweep (from T11.1 `buildSweepPlan`). */
  readonly sources: readonly SweepSource[];
  /** The single target chain every source mints into. */
  readonly targetChain: string;
  /** The active `k:` account — sender === receiver for every source (self-transfer). */
  readonly account: string;
  /**
   * The resolved signing keypair SET (XP-2). Resolved ONCE by the caller and
   * threaded into each reused `sendCrossChain`. A k:-only active account passes
   * `[senderKeypair]`; an advanced (multi-key) account passes its full set.
   */
  readonly signingKeypairs: readonly SignableKeypair[];
  /** The chain-0 gas-station co-signer keypair — required iff a source is chain "0". */
  readonly gasStationKeypair?: SignableKeypair;
  /**
   * OPTIONAL remote-mode signing override (XP-12). When present, the public-only
   * `signingKeypairs` are still threaded for the signer-cap construction, but the
   * actual step-0 signature is produced by this override (routing through the
   * background service worker) — so a popup never holds key material. Omitted in
   * local mode, where `signingKeypairs` carry live secrets and the default signer runs.
   */
  readonly signTransaction?: RemoteSignTransaction;
  /** Platform storage for the XP-5 per-source-chain in-flight persistence. */
  readonly storage: StorageAdapter;
  /** Per-chain progress channel (submitting → … → terminal). */
  readonly onChainProgress?: (chainId: string, update: MinerChainProgress) => void;
  /** Aborts the (idempotent) SPV poll loops on teardown; never aborts a submit. */
  readonly signal?: AbortSignal;
}

export interface AggregateAcrossChainsResult {
  readonly results: readonly MinerChainResult[];
}

/**
 * The per-source-chain XP-5 in-flight key. Namespaced under the shared
 * `MINER_AGGREGATION_KEY` registry constant and suffixed with the source chain,
 * so a 9-chain sweep persists up to 9 records WITHOUT colliding with the vault
 * key, the Phase-5 single-transfer `CROSSCHAIN_INFLIGHT_KEY`, or each other.
 */
export function minerInflightKey(sourceChain: string): string {
  return `${MINER_AGGREGATION_KEY}:${sourceChain}`;
}

/** The durable per-chain in-flight record persisted the instant Step-0 lands. */
interface MinerInflightRecord {
  readonly requestKey: string;
  readonly sourceChain: string;
  readonly targetChain: string;
  readonly amount: string;
  readonly step: 'step-0' | 'step-1';
  readonly reason: MinerChainOutcome;
}

/**
 * Lazily build the real step-0 deps with ONLY the `signTransaction` leg overridden
 * (remote mode). The live factory is imported behind the same dynamic boundary the
 * orchestrator itself uses, so this barrel-reachable module never statically pulls
 * the SDK transport. Every other leg (build/submit/listen) stays the production default.
 */
async function liveDepsWithRemoteSign(
  signTransaction: RemoteSignTransaction,
): Promise<SendCrossChainStep0Deps> {
  const { makeLiveSendCrossChainStep0Deps } = await import(
    '../crosschain/sendCrossChainStep0.live'
  );
  return { ...makeLiveSendCrossChainStep0Deps(), signTransaction };
}

const defaultDeps: AggregateDeps = {
  sendCrossChain: async (input, signingKeypairs, signTransaction) =>
    sendCrossChainStep0(
      input,
      signingKeypairs,
      signTransaction !== undefined
        ? await liveDepsWithRemoteSign(signTransaction)
        : undefined,
    ),
  pollProofAndContinue: (params, _deps, options) =>
    pollProofAndContinue(params, undefined, options),
};

/**
 * Map a non-ok Phase-5 `sendCrossChain` result to a per-chain terminal. The
 * TIMEOUT-as-pending vs hard-throw asymmetry is inherited intact:
 *   - `network-lost-pending` → `network-lost` (PENDING, carries the requestKey).
 *   - `guard-unavailable` → `guard-unavailable` (RR#6 retryable pending).
 *   - every other reason (`submit-failed`/`step0-failed`/invalid build) → `error`.
 */
function mapSendFailure(
  chainId: string,
  res: Extract<SendCrossChainStep0Result, { ok: false }>,
): MinerChainResult {
  if (res.reason === 'network-lost-pending') {
    return { chainId, outcome: 'network-lost', requestKey: res.requestKey, detail: res.detail };
  }
  if (res.reason === 'guard-unavailable') {
    return { chainId, outcome: 'guard-unavailable', detail: res.detail };
  }
  return { chainId, outcome: 'error', requestKey: res.requestKey, detail: res.detail };
}

/**
 * Map a non-ok Phase-5 `pollProofAndContinue` result to a per-chain terminal.
 * The RR#1 distinction is load-bearing: a continuation submit TIMEOUT is PENDING
 * (`continuation-pending`, never resubmit) while a definitive continuation
 * failure is a HARD `error`.
 */
function mapPollFailure(
  chainId: string,
  res: Extract<PollProofAndContinueResult, { ok: false }>,
): MinerChainResult {
  if (res.reason === 'spv-timeout') {
    return { chainId, outcome: 'spv-timeout', requestKey: res.requestKey };
  }
  if (res.reason === 'continuation-pending') {
    return { chainId, outcome: 'continuation-pending', requestKey: res.requestKey, detail: res.detail };
  }
  // continuation-failed — a definitive on-chain failure (the OPPOSITE of pending).
  return { chainId, outcome: 'error', requestKey: res.requestKey, detail: res.detail };
}

/**
 * Run the PARALLEL miner-aggregation sweep. For each funded source it REUSES the
 * Phase-5 `sendCrossChain` (Step-0 build → sign(SET) → submit → confirm) then,
 * on a confirmed burn, `pollProofAndContinue` (SPV proof → continuation) — it
 * never re-implements the SDK trio. All keypairs are INPUTS (resolved once by the
 * caller, never inside the loop, dodging the password-modal race).
 *
 * Money-safety contract:
 *   - `Promise.allSettled` ISOLATES sources — one chain's failure or pending
 *     never throws out of this function nor cancels the siblings.
 *   - TIMEOUT == PENDING, NEVER auto-resubmit: a `network-lost-pending`/
 *     `spv-timeout`/`continuation-pending` chain carries its requestKey to a
 *     terminal and is NEVER re-submitted.
 *   - XP-5: the instant a Step-0 requestKey exists (confirming), the chain's
 *     in-flight record is persisted under a per-source miner namespace; on `done`
 *     it is cleared; on a pending outcome it is KEPT for recovery.
 *   - `signal` aborts the idempotent SPV poll loops only — the signed Step-0
 *     submit is never aborted (anti-double-spend) and its requestKey is persisted
 *     before any teardown is honored.
 */
export async function aggregateAcrossChains(
  params: AggregateAcrossChainsParams,
  deps: AggregateDeps = defaultDeps,
): Promise<AggregateAcrossChainsResult> {
  const {
    sources,
    targetChain,
    account,
    storage,
    gasStationKeypair,
    signTransaction,
    onChainProgress,
    signal,
  } = params;

  // Read the resolved keypair SET ONCE, up-front — NEVER inside the per-chain
  // loop below (a per-chain re-read is exactly the password-modal race XP-2 fixes).
  const signingKeypairs = params.signingKeypairs;
  const senderPublicKey = signingKeypairs[0]?.publicKey ?? '';

  const emit = (chainId: string, update: MinerChainProgress): void => {
    onChainProgress?.(chainId, update);
  };

  const sweepOne = async (src: SweepSource): Promise<MinerChainResult> => {
    const { chainId, amount } = src;

    // A chain-"0" source needs the DALOS gas-station co-signer. If the caller did
    // not pass one, isolate this source to `error` WITHOUT touching the others —
    // we never reach the reused Step-0 build for it.
    const isChainZero = chainId === '0';
    if (isChainZero && !gasStationKeypair) {
      emit(chainId, { stage: 'error', detail: 'Missing gas-station keypair for chain 0' });
      return { chainId, outcome: 'error', detail: 'Missing gas-station keypair for chain 0' };
    }

    // Chain 0 co-signs with BOTH the sender set AND the gas-station keypair;
    // chains 1-9 sign with the sender set ONLY (the Phase-5 RR#3 gas split).
    const keypairs: readonly SignableKeypair[] = isChainZero
      ? [...signingKeypairs, gasStationKeypair as SignableKeypair]
      : signingKeypairs;

    emit(chainId, { stage: 'submitting' });

    const input: SendCrossChainStep0Input = {
      sender: account,
      receiver: account,
      amount,
      sourceChain: chainId,
      targetChain,
      senderPublicKey,
      ...(isChainZero ? { gasStationPublicKey: gasStationKeypair?.publicKey } : {}),
    };

    const sent = await deps.sendCrossChain(input, keypairs, signTransaction);

    if (!sent.ok) {
      const mapped = mapSendFailure(chainId, sent);
      // A network-lost PENDING still carries a requestKey worth persisting for
      // recovery; persist BEFORE honoring any teardown (never drop the key).
      if (mapped.outcome === 'network-lost' && mapped.requestKey) {
        await persist(storage, {
          requestKey: mapped.requestKey,
          sourceChain: chainId,
          targetChain,
          amount,
          step: 'step-0',
          reason: 'network-lost',
        });
      }
      emit(chainId, { stage: mapped.outcome, requestKey: mapped.requestKey, detail: mapped.detail });
      return mapped;
    }

    const { requestKey } = sent;

    // Step-0 landed: persist the in-flight record the INSTANT the requestKey
    // exists (XP-5), before any further work — this is the crash-window guard.
    await persist(storage, {
      requestKey,
      sourceChain: chainId,
      targetChain,
      amount,
      step: 'step-0',
      reason: 'network-lost',
    });
    emit(chainId, { stage: 'confirming', requestKey });

    // Forward the reused poll's progress as `waiting-spv` updates so a UI can
    // render the 30/5000 cadence attempt counter.
    const pollOptions: PollProofAndContinueOptions = {
      signal,
      onProgress: (attempt, maxAttempts) => {
        emit(chainId, { stage: 'waiting-spv', requestKey, spvAttempt: attempt, spvMaxAttempts: maxAttempts });
      },
    };

    const polled = await deps.pollProofAndContinue(
      { requestKey, sourceChain: chainId, targetChain },
      undefined,
      pollOptions,
    );

    if (!polled.ok) {
      const mapped = mapPollFailure(chainId, polled);
      if (mapped.outcome === 'error') {
        // A hard continuation failure has nothing to recover — clear the record.
        await storage.remove(minerInflightKey(chainId));
      } else {
        // A PENDING poll outcome (spv-timeout / continuation-pending) KEEPS its
        // record — but re-persist it carrying the TRUE stage as the reason, not the
        // `network-lost` placeholder written on `confirming`. A popup-close rehydrate
        // then reflects the real pending stage instead of always reading network-lost.
        await persist(storage, {
          requestKey,
          sourceChain: chainId,
          targetChain,
          amount,
          step: 'step-1',
          reason: mapped.outcome,
        });
      }
      emit(chainId, { stage: mapped.outcome, requestKey: mapped.requestKey, detail: mapped.detail });
      return mapped;
    }

    emit(chainId, { stage: 'completing', requestKey });
    // Done: the funds moved — clear the in-flight record so it is never
    // re-presented as actionable pending.
    await storage.remove(minerInflightKey(chainId));
    emit(chainId, { stage: 'done', requestKey, continuationKey: polled.continuationKey });
    return { chainId, outcome: 'done', requestKey, continuationKey: polled.continuationKey };
  };

  // PARALLEL + ISOLATED: allSettled guarantees one chain's rejection never
  // aborts the batch. Each `sweepOne` already returns a discriminated result, so
  // a `rejected` settlement is only an UNEXPECTED throw — mapped to `error` here.
  const settled = await Promise.allSettled(sources.map((src) => sweepOne(src)));
  const results: MinerChainResult[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    return { chainId: sources[i].chainId, outcome: 'error', detail: 'Unexpected sweep failure' };
  });

  return { results };
}

/** Persist a per-chain in-flight record as a JSON blob under the miner namespace. */
async function persist(storage: StorageAdapter, record: MinerInflightRecord): Promise<void> {
  await storage.set(minerInflightKey(record.sourceChain), JSON.stringify(record));
}
