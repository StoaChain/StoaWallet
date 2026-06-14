import {
  STOA_CHAINS,
  aggregateAcrossChains as coreAggregateAcrossChains,
  buildSweepPlan,
  getBalances as coreGetBalances,
  minerInflightKey,
  resumeCrossChain as coreResumeCrossChain,
  type AggregateAcrossChainsParams,
  type AggregateAcrossChainsResult,
  type Balances,
  type MinerChainProgress,
  type MinerChainStage,
  type RemoteSignTransaction,
  type ResumeCrossChainResult,
  type ResumeParams,
  type SignableKeypair,
  type StorageAdapter,
  type StoredBlob,
  type SweepBalances,
  type SweepSource,
} from '@stoawallet/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useWallet } from '../context/WalletContext';

/**
 * The recovery route a PENDING source chain offers — the exact prefill the
 * Phase-5 `ContinuationRecoveryView` / `CrossChainRecoveryRoute` consumes, so the
 * view can deep-link the user to "Continue X-Chain" with the burn identity filled
 * in (request key + chain pair) WITHOUT re-typing.
 */
export interface MinerRecoveryRoute {
  readonly requestKey: string;
  readonly sourceChain: string;
  readonly targetChain: string;
}

/**
 * One source chain's row in the sweep, combining the T11.1 plan (`chainId` +
 * full-balance default `amount`) with the per-chain state machine driven off
 * T11.2's `onChainProgress`. The terminal PENDING stages (`network-lost`,
 * `spv-timeout`, `continuation-pending`, `guard-unavailable`) carry a
 * `recoveryRoute` and NEVER a retry — the burn may have committed, so re-arming
 * the sweep for that chain would risk a double burn. A hard `error` carries
 * neither (nothing landed; the funds did not move).
 */
export interface ChainEntry {
  readonly chainId: string;
  /** Full-balance default from T11.1; the user may LOWER it via `setAmount`. */
  readonly amount: string;
  readonly progress: MinerChainStage | 'idle';
  readonly requestKey?: string;
  readonly spvAttempt?: number;
  readonly spvMaxAttempts?: number;
  readonly continuationKey?: string;
  readonly error?: string;
  /**
   * The "Continue X-Chain with this Request Key" deep-link target. Present ONLY
   * on a PENDING terminal (the burn may have committed); absent on idle / in-flight
   * / done / hard-error.
   */
  readonly recoveryRoute?: MinerRecoveryRoute;
}

/**
 * The up-front signer resolution outcome (XP-1 + XP-2). Resolved ONCE per
 * `aggregate()` BEFORE T11.2 is invoked, never inside the per-chain progression
 * (that per-chain re-resolve is exactly the password-modal race XP-1 fixes). A
 * locked wallet / no active account surfaces `{ ok:false, reason:'locked' }` and
 * core is NEVER called.
 */
export type ResolveSweepSignersResult =
  | {
      readonly ok: true;
      /** The sender keypair SET (XP-2) threaded into T11.2. */
      readonly signingKeypairs: readonly SignableKeypair[];
      /** The chain-0 gas-station co-signer — present when a chain-0 source is swept. */
      readonly gasStationKeypair?: SignableKeypair;
      /**
       * OPTIONAL remote-mode signing override (XP-12). Present in extension/remote
       * mode: the `signingKeypairs` are public-only and the actual signature is
       * produced by this override (routing through the background). Absent in local
       * mode, where the keypairs carry live secrets and core's default signer runs.
       */
      readonly signTransaction?: RemoteSignTransaction;
    }
  | { readonly ok: false; readonly reason: 'locked' };

/** The injectable orchestrator seam — defaults to core `aggregateAcrossChains`. */
export type AggregateAcrossChainsFn = (
  params: AggregateAcrossChainsParams,
) => Promise<AggregateAcrossChainsResult>;

/** The injectable reconciliation seam — defaults to core `resumeCrossChain` (RR#4). */
export type MinerResumeCrossChainFn = (
  params: ResumeParams,
) => Promise<ResumeCrossChainResult>;

export interface UseMinerAggregationOptions {
  /**
   * The active `k:` account whose 10 chains are pre-scanned and swept. When
   * omitted the hook resolves it from `useWallet().activeAccount`. `null` is the
   * explicit idle/locked signal.
   */
  readonly account?: string | null;
  /** Default target chain; falls back to the first STOA_CHAINS entry. */
  readonly targetChain?: string;
  /**
   * The Phase-1 pre-scan seam (raw `Balances`, the same shape T11.1 consumes).
   * Reuses the injection seam — does NOT re-loop chains nor call
   * `getBalanceOnChain` directly.
   */
  readonly getBalances?: (account: string) => Promise<Balances>;
  /**
   * Resolve the signer SET (+ gas keypair) through the WalletContext seam, ONCE
   * up-front (XP-1/XP-12). Defaults to a context-backed resolver. Tests inject a
   * stub.
   */
  readonly resolveSigningKeypairs?: (
    needsGasStation: boolean,
  ) => Promise<ResolveSweepSignersResult>;
  /** The parallel sweep orchestrator (T11.2). Defaults to core. */
  readonly aggregateAcrossChains?: AggregateAcrossChainsFn;
  /** The Phase-5 reconciliation op for RR#4 rehydrate. Defaults to core. */
  readonly resumeCrossChain?: MinerResumeCrossChainFn;
  /** The Phase-3 balance refresh, fired once on settle. */
  readonly refresh?: () => void;
  /** Durable in-flight storage. Defaults to the context-injected adapter. */
  readonly storage?: StorageAdapter;
}

export interface UseMinerAggregationResult {
  readonly targetChain: string;
  setTargetChain(chainId: string): void;
  /** Per-chain sweep rows derived from T11.1, with their progress state machine. */
  readonly sources: ChainEntry[];
  /** Lower a source's sweep amount (the user can sweep less than the full balance). */
  setAmount(chainId: string, amount: string): void;
  /** Run the parallel sweep. No-op while a sweep is already in flight. */
  aggregate(): Promise<void>;
  /**
   * Re-run the sweep for ONE source only. Used by the `guard-unavailable` retry: a
   * pre-burn transient keyset-read failure landed NOTHING on chain, so re-sweeping
   * just that source is safe and never re-burns a sibling that may carry a pending
   * burn. No-op while a sweep is already in flight.
   */
  reAggregateSource(chainId: string): Promise<void>;
  readonly isExecuting: boolean;
  /** True when the last `aggregate()` short-circuited on a locked wallet. */
  readonly locked: boolean;
}

/**
 * The MUTABLE per-chain runtime overlay merged over the plan-derived `sources`.
 * The public `ChainEntry` fields are `readonly`, so the overlay is a separate
 * writable shape the `progressMap` accumulates and `sources` projects from.
 */
interface ChainOverlay {
  progress?: ChainEntry['progress'];
  requestKey?: string;
  spvAttempt?: number;
  spvMaxAttempts?: number;
  continuationKey?: string;
  error?: string;
  recoveryRoute?: MinerRecoveryRoute;
}

/** Decode a stored blob to a UTF-8 string regardless of the backend's representation. */
function blobToString(raw: StoredBlob): string {
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

/** The durable per-chain in-flight record persisted by T11.2's sweep. */
interface PersistedMinerRecord {
  readonly requestKey: string;
  readonly sourceChain: string;
  readonly targetChain: string;
  readonly amount: string;
  readonly step: string;
  readonly reason?: string;
}

/** The pending terminal stages — those that carry a recovery route and never retry. */
const PENDING_STAGES: ReadonlySet<MinerChainStage> = new Set<MinerChainStage>([
  'network-lost',
  'spv-timeout',
  'continuation-pending',
  'guard-unavailable',
]);

function isPendingStage(stage: MinerChainStage | 'idle'): boolean {
  return PENDING_STAGES.has(stage as MinerChainStage);
}

/**
 * State hook composing the pre-scan (Phase-1/3 `getBalances`) → T11.1
 * `buildSweepPlan` (target + funded-source selection) → T11.2
 * `aggregateAcrossChains` (parallel sweep) into a per-chain React state machine.
 *
 * SECURITY: the keypair SET is resolved ONCE up-front through the WalletContext
 * seam (mirroring the Phase-5 `useCrossChainTransfer` → `sendCrossChainStep0`
 * pattern) and threaded straight into the core orchestrator; it is never held in
 * hook state, never re-resolved per chain, and never logged. No `console.*` output
 * is emitted, so nothing can leak a mnemonic/password/keypair.
 *
 * MONEY-SAFETY: a TIMEOUT terminal (`network-lost`/`spv-timeout`/
 * `continuation-pending`/`guard-unavailable`) is a distinct PENDING state carrying
 * the requestKey + a recovery route to the Phase-5 Continue tab; the hook NEVER
 * re-invokes the sweep for that chain. On mount it rehydrates persisted per-chain
 * in-flight records (XP-5) and reconciles them against on-chain state via the
 * Phase-5 `resumeCrossChain` (RR#4) — an already-completed burn clears the stale
 * record rather than re-surfacing as actionable pending.
 */
export function useMinerAggregation(
  options: UseMinerAggregationOptions = {},
): UseMinerAggregationResult {
  const wallet = useWallet();

  const account =
    options.account !== undefined
      ? options.account
      : (wallet.activeAccount?.account ?? null);

  // The pre-scan defaults to the SAME core balances seam `useBalances` uses, so the
  // production Miner tab (no injected `getBalances`) actually reads the active
  // account's 10 chains rather than fail-safing to a permanent empty source list.
  const getBalances = options.getBalances ?? coreGetBalances;
  const aggregateOp = options.aggregateAcrossChains ?? coreAggregateAcrossChains;
  const resumeOp = options.resumeCrossChain ?? coreResumeCrossChain;
  const storage = options.storage ?? wallet.storage;
  const refresh = options.refresh;

  // The default resolver routes through the WalletContext seam in BOTH modes
  // (XP-1/XP-12): local mode resolves the real keypair SET inside the context;
  // remote mode returns a PUBLIC-only set plus a background sign override. The keys
  // NEVER leave the context — the popup holds none. Maps the context's discriminated
  // result onto the hook's sweep-signers shape.
  const resolveActiveMinerSigners = wallet.resolveActiveMinerSigners;
  const defaultResolve = useCallback(
    async (needsGasStation: boolean): Promise<ResolveSweepSignersResult> => {
      const resolved = await resolveActiveMinerSigners(needsGasStation);
      if (!resolved.ok) {
        return { ok: false, reason: 'locked' };
      }
      return {
        ok: true,
        signingKeypairs: resolved.signingKeypairs,
        gasStationKeypair: resolved.gasStationKeypair,
        signTransaction: resolved.signTransaction,
      };
    },
    [resolveActiveMinerSigners],
  );
  const resolveSigners = options.resolveSigningKeypairs ?? defaultResolve;

  const [targetChain, setTargetChainState] = useState<string>(
    options.targetChain ?? STOA_CHAINS[0],
  );

  // The raw pre-scan, fetched ONCE per account; changing targetChain re-derives
  // sources from this WITHOUT a re-fetch.
  const [balances, setBalances] = useState<SweepBalances | null>(null);

  // Per-chain runtime progress overlay, keyed by chainId. Merged over the
  // plan-derived `sources` so a re-derive (target change) keeps in-flight progress.
  const [progressMap, setProgressMap] = useState<Record<string, ChainOverlay>>(
    {},
  );
  // User-lowered amounts, keyed by chainId (overrides the full-balance default).
  const [amountOverrides, setAmountOverrides] = useState<Record<string, string>>(
    {},
  );

  const [isExecuting, setIsExecuting] = useState(false);
  const [locked, setLocked] = useState(false);

  // The in-flight guard: a ref (not state) so two synchronous aggregate() calls
  // see the flag the FIRST set, before the rendered disabled state catches up.
  const inFlightRef = useRef(false);

  // Suppress post-resolution setState after unmount (MV3 popup close mid-sweep).
  // The signed submits inside T11.2 are NOT aborted; only the UI write + the poll
  // loops (via the signal) are. The post-resolution write is dropped.
  const cancelledRef = useRef(false);
  const sweepAbortRef = useRef<AbortController | null>(null);

  const setProgress = useCallback(
    (chainId: string, update: ChainOverlay) => {
      if (cancelledRef.current) return;
      setProgressMap((prev) => ({
        ...prev,
        [chainId]: { ...prev[chainId], ...update },
      }));
    },
    [],
  );

  // SINGLE-OWNER cancelledRef (mirrors the Phase-5 `useCrossChainTransfer`): ONE
  // effect owns the mount=false / unmount=true lifecycle of `cancelledRef` and the
  // poll-abort. The per-account pre-scan effect below MUST NOT reset it — an
  // account switch re-runs that effect, and resetting `cancelledRef` there would
  // race a concurrent unmount cleanup into a setState-after-unmount.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      sweepAbortRef.current?.abort();
    };
  }, []);

  // PRE-SCAN: fetch the raw 10-chain balances ONCE per account. Owns only its own
  // `active` latch (per-account staleness), never the shared `cancelledRef`.
  useEffect(() => {
    if (account === null) {
      setBalances(null);
      return;
    }
    let active = true;
    void (async () => {
      const data = await getBalances(account);
      if (!active || cancelledRef.current) return;
      setBalances(data);
    })();
    return () => {
      active = false;
    };
  }, [account, getBalances]);

  // Derive the funded sources from the pre-scan via T11.1. Re-runs on a
  // targetChain change WITHOUT re-fetching balances.
  const plannedSources = useMemo<SweepSource[]>(() => {
    if (balances === null || account === null) return [];
    const plan = buildSweepPlan({ balances, targetChain, account });
    return plan.ok ? plan.sources : [];
  }, [balances, targetChain, account]);

  // REHYDRATE on MOUNT (XP-5): probe the per-chain miner namespace for any
  // persisted in-flight record (the adapter has no key enumeration, so probe each
  // of the 10 chains) and reconcile it against on-chain state via the Phase-5
  // resume op (RR#4): an already-completed/done reconciliation CLEARS the stale
  // record; any other reconciliation surfaces the record as PENDING carrying the
  // requestKey. The sweep is NEVER auto-resumed.
  useEffect(() => {
    let active = true;
    void (async () => {
      for (const chainId of STOA_CHAINS) {
        const raw = await storage.get(minerInflightKey(chainId));
        if (!active || raw === null) continue;
        let record: PersistedMinerRecord;
        try {
          record = JSON.parse(blobToString(raw)) as PersistedMinerRecord;
        } catch {
          // A corrupt record is ignored — recovery stays reachable manually and a
          // malformed blob must not crash the mount.
          continue;
        }
        if (typeof record.requestKey !== 'string') continue;

        // RR#4: reconcile against on-chain state before presenting as actionable.
        let reconciled: ResumeCrossChainResult | null = null;
        try {
          reconciled = await resumeOp({
            requestKey: record.requestKey,
            sourceChain: record.sourceChain,
            targetChain: record.targetChain,
          });
        } catch {
          // A thrown reconcile is ambiguous — keep the record pending (never clear
          // on uncertainty, never auto-resubmit).
          reconciled = null;
        }
        if (!active || cancelledRef.current) return;

        const alreadyDone =
          reconciled !== null &&
          (reconciled.ok || reconciled.reason === 'already-completed');

        if (alreadyDone) {
          // The burn already completed — drop the stale record so it is never
          // re-presented as actionable pending (crash-between-confirm-and-clear).
          await storage.remove(minerInflightKey(chainId));
          continue;
        }

        const stage = (record.reason as MinerChainStage) ?? 'spv-timeout';
        setProgress(record.sourceChain, {
          progress: isPendingStage(stage) ? stage : 'spv-timeout',
          requestKey: record.requestKey,
          recoveryRoute: {
            requestKey: record.requestKey,
            sourceChain: record.sourceChain,
            targetChain: record.targetChain,
          },
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [storage, resumeOp, setProgress]);

  const sources = useMemo<ChainEntry[]>(() => {
    return plannedSources.map((src) => {
      const overlay = progressMap[src.chainId];
      return {
        chainId: src.chainId,
        amount: amountOverrides[src.chainId] ?? src.amount,
        progress: overlay?.progress ?? 'idle',
        requestKey: overlay?.requestKey,
        spvAttempt: overlay?.spvAttempt,
        spvMaxAttempts: overlay?.spvMaxAttempts,
        continuationKey: overlay?.continuationKey,
        error: overlay?.error,
        recoveryRoute: overlay?.recoveryRoute,
      };
    });
  }, [plannedSources, progressMap, amountOverrides]);

  const setTargetChain = useCallback((chainId: string) => {
    setTargetChainState(chainId);
  }, []);

  const setAmount = useCallback((chainId: string, amount: string) => {
    setAmountOverrides((prev) => ({ ...prev, [chainId]: amount }));
  }, []);

  /** Map one T11.2 progress update onto the matching entry's overlay (allSettled isolation). */
  const onChainProgress = useCallback(
    (chainId: string, update: MinerChainProgress) => {
      const patch: ChainOverlay = {
        progress: update.stage,
        requestKey: update.requestKey,
        spvAttempt: update.spvAttempt,
        spvMaxAttempts: update.spvMaxAttempts,
        continuationKey: update.continuationKey,
      };
      if (update.stage === 'error') {
        patch.error = update.detail;
      }
      // A PENDING terminal carries the recovery route (continue affordance), never
      // a retry; a hard error and the in-flight stages carry neither.
      if (isPendingStage(update.stage) && update.requestKey !== undefined) {
        patch.recoveryRoute = {
          requestKey: update.requestKey,
          sourceChain: chainId,
          targetChain,
        };
      }
      setProgress(chainId, patch);
    },
    [setProgress, targetChain],
  );

  // The shared sweep runner: resolves signers ONCE up-front, then invokes the core
  // orchestrator over the supplied subset of funded sources. `aggregate()` passes
  // every funded source; `reAggregateSource()` passes exactly one (the safe
  // guard-unavailable retry). Both share the double-submit guard + locked gate +
  // settle-refresh so the money-safety posture is identical for either entry point.
  const runSweep = useCallback(
    async (toSweep: readonly SweepSource[]): Promise<void> => {
      // Double-submit guard: the ref flips synchronously, so a second call fired in
      // the same tick is a no-op and core is invoked once.
      if (inFlightRef.current) return;
      if (toSweep.length === 0 || account === null) return;
      inFlightRef.current = true;
      setIsExecuting(true);
      setLocked(false);

      // RESOLVE KEYPAIRS ONCE, UP-FRONT (XP-1): resolve the sender SET and — when a
      // chain-0 source is present — the gas-station keypair, BEFORE invoking T11.2.
      // Never resolve a keypair inside the per-chain progression.
      const needsGasStation = toSweep.some((s) => s.chainId === '0');
      const signers = await resolveSigners(needsGasStation);

      if (!signers.ok) {
        // A LOCKED wallet / no active account → distinct locked state, core NOT called.
        inFlightRef.current = false;
        if (!cancelledRef.current) {
          setIsExecuting(false);
          setLocked(true);
        }
        return;
      }

      const controller = new AbortController();
      sweepAbortRef.current = controller;

      try {
        await aggregateOp({
          sources: toSweep,
          targetChain,
          account,
          signingKeypairs: signers.signingKeypairs,
          gasStationKeypair: signers.gasStationKeypair,
          // Remote mode threads the background sign override into the sweep; local
          // mode leaves it undefined (the real keypairs sign via core's default).
          signTransaction: signers.signTransaction,
          storage,
          onChainProgress,
          signal: controller.signal,
        });
      } finally {
        sweepAbortRef.current = null;
        inFlightRef.current = false;
        if (!cancelledRef.current) {
          setIsExecuting(false);
          // On settle (all sources terminal) refresh the Phase-3 balances once.
          refresh?.();
        }
      }
    },
    [
      account,
      resolveSigners,
      aggregateOp,
      targetChain,
      storage,
      onChainProgress,
      refresh,
    ],
  );

  const aggregate = useCallback(async (): Promise<void> => {
    const sweepSources: SweepSource[] = plannedSources.map((s) => ({
      chainId: s.chainId,
      amount: amountOverrides[s.chainId] ?? s.amount,
    }));
    await runSweep(sweepSources);
  }, [plannedSources, amountOverrides, runSweep]);

  const reAggregateSource = useCallback(
    async (chainId: string): Promise<void> => {
      const src = plannedSources.find((s) => s.chainId === chainId);
      if (src === undefined) return;
      // Re-sweep EXACTLY this one source — never the siblings (they may carry a
      // pending burn). Safe only because guard-unavailable is a pre-burn read failure
      // where NOTHING landed on chain for this source.
      await runSweep([
        { chainId: src.chainId, amount: amountOverrides[src.chainId] ?? src.amount },
      ]);
    },
    [plannedSources, amountOverrides, runSweep],
  );

  return {
    targetChain,
    setTargetChain,
    sources,
    setAmount,
    aggregate,
    reAggregateSource,
    isExecuting,
    locked,
  };
}
