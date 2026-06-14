import { STOA_CHAINS } from '@stoawallet/core';
import { useMemo, useState, type ReactNode } from 'react';

import { TokenGlyph } from '../theme/TokenGlyph';
import styles from './MinerAggregationView.module.css';
import {
  useMinerAggregation,
  type ChainEntry,
  type MinerRecoveryRoute,
  type UseMinerAggregationOptions,
} from './useMinerAggregation';

/** The braided chain IDs — core's canonical `STOA_CHAINS` is the single source. */
const CHAIN_IDS: readonly string[] = STOA_CHAINS;

/**
 * The recover-via-Continue-tab PENDING terminals — the burn MAY have committed
 * (a requestKey exists), so the user resumes step-1, NEVER re-burns. NOTE:
 * `guard-unavailable` is DELIBERATELY excluded: it is a PRE-burn transient read
 * failure (no requestKey, nothing landed), handled as a retryable state below.
 */
const PENDING = new Set<ChainEntry['progress']>([
  'network-lost',
  'spv-timeout',
  'continuation-pending',
]);

/** A pre-burn transient keyset-read failure: nothing landed, safe to re-aggregate. */
const GUARD_UNAVAILABLE: ChainEntry['progress'] = 'guard-unavailable';

export interface MinerAggregationViewProps {
  /**
   * Forwarded verbatim to `useMinerAggregation` — the pre-scan, the up-front
   * signer resolver, the sweep orchestrator, and the durable storage seam. The app
   * shell wires the real ops; tests inject stubs. The view holds NO key material:
   * the hook owns resolution + signing.
   */
  readonly hookOptions?: UseMinerAggregationOptions;
  /**
   * Called when a PENDING source's "Continue tab" affordance is used. The burn's
   * identity is prefilled so the Phase-5 recovery view resumes the step-1
   * continuation WITHOUT re-burning. The view does NOT route itself — it exposes
   * the callback, mirroring `CrossChainTransferForm.onRouteToRecovery`.
   */
  readonly onRouteToRecovery?: (route: MinerRecoveryRoute) => void;
  /** Called when a `locked` sweep outcome should route the user to unlock. */
  readonly onRequireUnlock?: () => void;
}

/** Sum 12-decimal STOA amount strings as integer pico-units, then re-format. */
function sumAmounts(amounts: readonly string[]): string {
  const scale = 12n;
  const factor = 10n ** scale;
  let total = 0n;
  for (const raw of amounts) {
    const [whole, frac = ''] = raw.split('.');
    const fracPadded = (frac + '000000000000').slice(0, 12);
    total += BigInt(whole || '0') * factor + BigInt(fracPadded || '0');
  }
  const whole = total / factor;
  const frac = (total % factor).toString().padStart(12, '0');
  return `${whole.toString()}.${frac}`;
}

/**
 * The MINER AGGREGATION view: a TARGET-chain selector (the 10 `STOA_CHAINS`) and a
 * pre-scanned SOURCE list (the funded chains EXCLUDING the target — the hook's
 * `sources`, so zero-balance/absent chains are already skipped and the target is
 * never a source). Each source card shows its chain id, live balance, a
 * full-balance-default amount input with a MAX control, and its own per-chain
 * progress. A single "Aggregate STOA" runs the parallel sweep.
 *
 * The view composes `useMinerAggregation` and holds NO key material — the hook
 * resolves signers ONCE up-front and owns signing. The sweep is GASLESS (chain-0
 * via the Ouronet Gas Station, chains 1-9 via kadena-xchain-gas), so there is no
 * per-source gas input.
 *
 * Each source's terminal state is DISTINCT so the user is never misled and one
 * chain's outcome never masks another's (allSettled isolation):
 *   - in-flight   → a staged line; `waiting-spv` shows the live n/30 SPV counter.
 *   - done        → the target-chain continuation key.
 *   - error       → a HARD failure (no funds moved) — no recovery affordance.
 *   - PENDING     → "may have committed — PENDING" with the Step-0 request key
 *                   (copyable) and a "Use the Continue tab" action routing to the
 *                   Phase-5 recovery view with source/target/requestKey prefilled.
 *                   NEVER a re-aggregate/re-send-Step-0 control (a fresh burn would
 *                   double-spend), and NEVER rendered as done.
 *
 * The aggregate result is the RR#5 THREE-WAY breakdown — aggregated / pending /
 * failed — never a single X-of-Y. A `locked` outcome routes to unlock. Amounts
 * render with the gold ❖ via the shared `<TokenGlyph>`, and the typed amount
 * STRING reaches the hook intact so 12-decimal precision survives. The view emits
 * no telemetry: nothing logs the amounts or any key material.
 */
export function MinerAggregationView({
  hookOptions,
  onRouteToRecovery,
  onRequireUnlock,
}: MinerAggregationViewProps): ReactNode {
  const {
    targetChain,
    setTargetChain,
    sources,
    setAmount,
    aggregate,
    reAggregateSource,
    isExecuting,
    locked,
  } = useMinerAggregation(hookOptions);

  if (locked) {
    return (
      <section className={styles.view} data-testid="miner-locked">
        <p className={styles.lockedText}>
          Your wallet is locked — unlock it to aggregate.
        </p>
        <button
          type="button"
          data-testid="miner-unlock"
          className={styles.primary}
          onClick={() => onRequireUnlock?.()}
        >
          Unlock
        </button>
      </section>
    );
  }

  const hasFundedSources = sources.length > 0;
  const settled = sources.some((s) => s.progress !== 'idle');

  return (
    <section className={styles.view} data-testid="miner-view">
      <h1 className={styles.heading}>Aggregate Miner Rewards</h1>
      <p className={styles.subheading}>
        Sweep your mined Stoa Coin from every funded chain into one target chain.
      </p>

      <label className={styles.label}>
        <span className={styles.labelText}>Target chain</span>
        <select
          data-testid="miner-target"
          className={styles.input}
          value={targetChain}
          onChange={(e) => setTargetChain(e.target.value)}
          disabled={isExecuting}
        >
          {CHAIN_IDS.map((id) => (
            <option key={id} value={id}>
              Chain {id}
            </option>
          ))}
        </select>
      </label>

      <p className={styles.gasless} data-testid="miner-gasless">
        This sweep is gasless — chain-0 sources are sponsored by the Ouronet Gas
        Station (DALOS.GAS_PAYER) and chains 1-9 by kadena-xchain-gas. You pay no
        gas on either path.
      </p>

      {hasFundedSources ? (
        <ul className={styles.sourceList}>
          {sources.map((entry) => (
            <SourceCard
              key={entry.chainId}
              entry={entry}
              disabled={isExecuting}
              onAmount={(amount) => setAmount(entry.chainId, amount)}
              onRouteToRecovery={onRouteToRecovery}
              onRetry={() => void reAggregateSource(entry.chainId)}
            />
          ))}
        </ul>
      ) : (
        <p className={styles.empty} data-testid="miner-empty">
          No funded chains to sweep — every chain is empty or holds the target.
        </p>
      )}

      <button
        type="button"
        data-testid="miner-aggregate"
        className={styles.primary}
        onClick={() => void aggregate()}
        disabled={isExecuting || !hasFundedSources}
      >
        {isExecuting ? 'Aggregating…' : 'Aggregate STOA'}
      </button>

      {settled && <ResultPanel sources={sources} />}
    </section>
  );
}

/** One funded source chain: id, balance, amount input + MAX, and its progress. */
function SourceCard({
  entry,
  disabled,
  onAmount,
  onRouteToRecovery,
  onRetry,
}: {
  entry: ChainEntry;
  disabled: boolean;
  onAmount: (amount: string) => void;
  onRouteToRecovery?: (route: MinerRecoveryRoute) => void;
  onRetry?: () => void;
}): ReactNode {
  const { chainId, amount, progress } = entry;
  // A recover-via-Continue PENDING locks the amount input (the burn may have
  // committed); guard-unavailable does NOT lock it (nothing landed — safe to retry).
  const isPending = PENDING.has(progress);

  return (
    <li className={styles.card} data-testid={`miner-source-${chainId}`}>
      <div className={styles.cardHead}>
        <span className={styles.chainTag}>Chain {chainId}</span>
        <span className={styles.balance}>
          {amount} <TokenGlyph token="STOA" className={styles.amountGlyph} />
        </span>
      </div>

      <div className={styles.amountRow}>
        <input
          data-testid={`miner-amount-${chainId}`}
          className={styles.input}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0.000000000000"
          value={amount}
          onChange={(e) => onAmount(e.target.value)}
          disabled={disabled || isPending}
        />
        <button
          type="button"
          data-testid={`miner-max-${chainId}`}
          className={styles.maxButton}
          onClick={() => onAmount(entry.amount)}
          disabled={disabled || isPending}
        >
          MAX
        </button>
      </div>

      <SourceProgress
        entry={entry}
        onRouteToRecovery={onRouteToRecovery}
        onRetry={onRetry}
      />
    </li>
  );
}

/** The per-chain staged surface — distinct per stage, isolated to this card. */
function SourceProgress({
  entry,
  onRouteToRecovery,
  onRetry,
}: {
  entry: ChainEntry;
  onRouteToRecovery?: (route: MinerRecoveryRoute) => void;
  onRetry?: () => void;
}): ReactNode {
  const { chainId, progress } = entry;

  if (progress === 'idle') return null;

  // guard-unavailable is a PRE-burn transient read failure (no requestKey, nothing
  // landed) — a DISTINCT retryable state, never bucketed with the requestKey-bearing
  // Continue-tab PENDING stages (which would render a dead recovery affordance).
  if (progress === GUARD_UNAVAILABLE) {
    return <GuardUnavailableRow entry={entry} onRetry={onRetry} />;
  }

  if (PENDING.has(progress)) {
    return (
      <PendingRow entry={entry} onRouteToRecovery={onRouteToRecovery} />
    );
  }

  if (progress === 'error') {
    return (
      <p
        className={styles.errorRow}
        role="alert"
        data-testid={`miner-progress-${chainId}`}
      >
        Failed — no funds left this chain. Error: {entry.error ?? 'unknown'}.
      </p>
    );
  }

  if (progress === 'done') {
    return (
      <p
        className={styles.doneRow}
        data-testid={`miner-progress-${chainId}`}
      >
        Done.
        {entry.continuationKey !== undefined && (
          <>
            {' '}
            Continuation key:{' '}
            <span className={styles.mono}>{entry.continuationKey}</span>
          </>
        )}
      </p>
    );
  }

  // The in-flight stages: submitting / confirming / waiting-spv / completing.
  return (
    <p
      className={styles.stageRow}
      role="status"
      data-testid={`miner-progress-${chainId}`}
    >
      <StageText entry={entry} />
    </p>
  );
}

/** The in-flight stage copy; `waiting-spv` shows the live n/30 counter. */
function StageText({ entry }: { entry: ChainEntry }): ReactNode {
  switch (entry.progress) {
    case 'submitting':
      return <>Submitting the source-chain burn…</>;
    case 'confirming':
      return (
        <>
          Confirming
          {entry.requestKey !== undefined && (
            <>
              {' '}
              (<span className={styles.mono}>{entry.requestKey}</span>)
            </>
          )}
          …
        </>
      );
    case 'waiting-spv':
      return (
        <>
          Waiting for SPV proof ({entry.spvAttempt ?? 0}/
          {entry.spvMaxAttempts ?? 0})…
        </>
      );
    case 'completing':
      return <>Completing on the target chain…</>;
    default:
      return <>Working…</>;
  }
}

/**
 * The PENDING landing for one source: the burn MAY have committed but its
 * confirmation was lost. Reads as PENDING (never done), surfaces the Step-0
 * request key with a copy affordance, and routes to recovery with the burn's
 * identity prefilled. Renders NO re-aggregate/re-send-Step-0 control.
 */
function PendingRow({
  entry,
  onRouteToRecovery,
}: {
  entry: ChainEntry;
  onRouteToRecovery?: (route: MinerRecoveryRoute) => void;
}): ReactNode {
  const { chainId, requestKey, recoveryRoute } = entry;
  const [copied, setCopied] = useState(false);

  const onCopy = (): void => {
    if (requestKey === undefined) return;
    void navigator.clipboard?.writeText(requestKey).then(() => setCopied(true));
  };

  return (
    <div
      className={styles.pendingRow}
      role="status"
      data-testid={`miner-pending-${chainId}`}
    >
      <p className={styles.pendingText}>
        Submitted — confirmation unknown. This chain is PENDING: the burn may have
        committed. Do not re-send — resume it from the Continue tab.
      </p>
      {requestKey !== undefined && (
        <p className={styles.requestKey}>
          Request key: <span className={styles.mono}>{requestKey}</span>
        </p>
      )}
      <div className={styles.pendingActions}>
        {requestKey !== undefined && (
          <button
            type="button"
            data-testid={`miner-copy-${chainId}`}
            className={styles.secondary}
            onClick={onCopy}
          >
            {copied ? 'Copied' : 'Copy request key'}
          </button>
        )}
        {recoveryRoute !== undefined && (
          <button
            type="button"
            data-testid={`miner-continue-${chainId}`}
            className={styles.primary}
            onClick={() => onRouteToRecovery?.(recoveryRoute)}
          >
            Use the Continue tab with this Request Key
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The guard-unavailable landing for one source: the target keyset could not be read
 * (a transient PRE-burn failure). NOTHING landed on chain — there is no requestKey
 * and no Continue-tab route — so this offers a RE-AGGREGATE-this-source retry, which
 * is safe (re-arming the burn for this one source cannot double-commit). It renders
 * NEITHER a request key NOR a Continue-tab control.
 */
function GuardUnavailableRow({
  entry,
  onRetry,
}: {
  entry: ChainEntry;
  onRetry?: () => void;
}): ReactNode {
  const { chainId } = entry;
  return (
    <div
      className={styles.pendingRow}
      role="status"
      data-testid={`miner-guard-unavailable-${chainId}`}
    >
      <p className={styles.pendingText}>
        The target chain&apos;s keyset was temporarily unreadable — nothing was sent.
        This is safe to retry.
      </p>
      <div className={styles.pendingActions}>
        <button
          type="button"
          data-testid={`miner-retry-${chainId}`}
          className={styles.primary}
          onClick={() => onRetry?.()}
        >
          Retry this chain
        </button>
      </div>
    </div>
  );
}

/**
 * The RR#5 three-way aggregate breakdown: the total STOA aggregated (done sources)
 * with the gold ❖, plus the count of pending-unknown and failed sources — never a
 * single X-of-Y number, so a lost-confirmation chain is never silently counted as
 * a success or a failure.
 */
function ResultPanel({ sources }: { sources: readonly ChainEntry[] }): ReactNode {
  const breakdown = useMemo(() => {
    const done = sources.filter((s) => s.progress === 'done');
    const pending = sources.filter((s) => PENDING.has(s.progress));
    const failed = sources.filter((s) => s.progress === 'error');
    return {
      done,
      pendingCount: pending.length,
      failedCount: failed.length,
      // The denominator: every source the sweep INTENDED to aggregate (SG-003).
      intended: sources.length,
      aggregated: sumAmounts(done.map((s) => s.amount)),
    };
  }, [sources]);

  return (
    <div className={styles.result} data-testid="miner-result">
      <p className={styles.resultLine}>
        <span className={styles.resultLabel}>Aggregated</span>
        <span data-testid="miner-result-aggregated" className={styles.resultValue}>
          {breakdown.done.length}
        </span>
        <span className={styles.resultDenominator}>
          {' '}of{' '}
          <span data-testid="miner-result-intended">{breakdown.intended}</span>
        </span>
        <span className={styles.resultAmount}>
          {breakdown.aggregated}{' '}
          <TokenGlyph token="STOA" className={styles.amountGlyph} />
        </span>
      </p>
      <p className={styles.resultLine}>
        <span className={styles.resultLabel}>Pending</span>
        <span data-testid="miner-result-pending" className={styles.resultValue}>
          {breakdown.pendingCount}
        </span>
      </p>
      <p className={styles.resultLine}>
        <span className={styles.resultLabel}>Failed</span>
        <span data-testid="miner-result-failed" className={styles.resultValue}>
          {breakdown.failedCount}
        </span>
      </p>
    </div>
  );
}
