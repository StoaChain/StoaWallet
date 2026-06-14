import { STOA_CHAINS } from '@stoawallet/core';
import { useMemo, useState, type ReactNode } from 'react';

import { useWallet } from '../context/WalletContext';
import { TokenGlyph } from '../theme/TokenGlyph';
import styles from './CrossChainTransferForm.module.css';
import {
  useCrossChainTransfer,
  type CrossChainTransferParams,
  type UseCrossChainTransferOptions,
} from './useCrossChainTransfer';

/** Where the recovery route is prefilled from a pending burn. Mirrors core `ResumeParams`. */
export interface CrossChainRecoveryRoute {
  readonly requestKey: string;
  readonly sourceChain: string;
  readonly targetChain: string;
}

export interface CrossChainTransferFormProps {
  /**
   * Options forwarded verbatim to `useCrossChainTransfer` — the stubbed step-0
   * op, the SPV poll op, and the durable storage seam. The app shell wires the
   * real ops; tests inject stubs. The form itself never holds key material:
   * signing happens inside the context step-0 op the hook calls.
   */
  readonly hookOptions?: UseCrossChainTransferOptions;
  /**
   * Called when a PENDING transfer's "Continue tab" affordance is used. The
   * burn's identity is prefilled so the recovery view (the Continue tab / T5.8)
   * can resume the step-1 continuation WITHOUT re-burning. The form does NOT
   * route itself — it only exposes the callback.
   */
  readonly onRouteToRecovery?: (route: CrossChainRecoveryRoute) => void;
  /** Called when a `locked` result should route the user to unlock. */
  readonly onRequireUnlock?: () => void;
}

/**
 * The braided chain IDs, taken from core's canonical `STOA_CHAINS` array (the
 * single source of truth). StoaChain numbers its chains "0".."N-1" as strings —
 * the same form the step-0 op keys on — so the selectors and the op agree
 * without a hardcoded list.
 */
const CHAIN_IDS: readonly string[] = STOA_CHAINS;

/** Steps during which the transfer/confirm control must be disabled. */
const IN_FLIGHT = new Set<string>(['building', 'submitting', 'waiting-spv']);

/** The first chain id that is NOT `source` — the default target when source changes onto it. */
function firstOtherChain(source: string): string {
  return CHAIN_IDS.find((id) => id !== source) ?? CHAIN_IDS[0];
}

/**
 * The CROSS-CHAIN transfer form: a SOURCE + TARGET chain selector pair (each
 * enumerated from `CHAIN_IDS`, with the target chip matching the source DISABLED
 * so source ≠ target), a receiver input defaulting to the active SELF account
 * with a custom-address mode, and a 12-decimal-aware amount input. It composes
 * `useCrossChainTransfer` and gates the step-0 burn behind an explicit
 * preview→confirm step so funds never move until the user confirms.
 *
 * Terminal-state affordances are DISTINCT so the user is never misled:
 *   - preview     → receiver/route/amount/gas review + a CONFIRM control; the
 *                   hook's `transfer` is NOT called until confirm.
 *   - in-flight   → a staged progress line; during `waiting-spv` it shows the
 *                   live SPV attempt/max counter (n/30), not a frozen spinner.
 *   - done        → the continuation request key + a "transfer another" affordance.
 *   - pending     → a DISTINCT "may have committed — PENDING" message with the
 *                   step-0 request key (copyable) and a "Use the Continue tab"
 *                   affordance routing to recovery. NEVER success, NEVER a
 *                   re-send-step-0 control (a fresh burn would double-spend).
 *   - error       → a clear failure DISTINCT from pending (no tx landed).
 *   - locked      → routes to unlock rather than a generic error.
 *
 * The amount reaches the hook as the typed STRING — never Number()'d, rounded,
 * or truncated — so 12-decimal precision survives. The form emits no telemetry:
 * nothing logs the receiver, amount, or any key material.
 */
export function CrossChainTransferForm({
  hookOptions,
  onRouteToRecovery,
  onRequireUnlock,
}: CrossChainTransferFormProps): ReactNode {
  const { activeAccount } = useWallet();
  const selfReceiver = activeAccount?.account ?? '';

  const [sourceChain, setSourceChain] = useState(CHAIN_IDS[0]);
  const [targetChain, setTargetChain] = useState(firstOtherChain(CHAIN_IDS[0]));
  const [amount, setAmount] = useState('');
  const [receiverMode, setReceiverMode] = useState<'self' | 'custom'>('self');
  const [customReceiver, setCustomReceiver] = useState('');
  // The params captured at preview time — `transfer` is gated behind confirm so
  // the burn never fires on the preview submit.
  const [pendingParams, setPendingParams] =
    useState<CrossChainTransferParams | null>(null);

  const { state, transfer, reset } = useCrossChainTransfer(hookOptions);

  const receiver = receiverMode === 'self' ? selfReceiver : customReceiver;
  const status = state.step;
  const inFlight = IN_FLIGHT.has(status);
  const showPreview = pendingParams !== null && (status === 'configure' || inFlight);

  // Source 0 routes gas through the Ouronet Gas Station (DALOS.GAS_PAYER co-sign);
  // any other source uses kadena-xchain-gas. The disclosure names who pays so the
  // user is never misled about gas on either path.
  const gasMode = useMemo(
    () =>
      sourceChain === '0'
        ? 'Gas covered by the Ouronet Gas Station (DALOS.GAS_PAYER).'
        : 'Gas covered by kadena-xchain-gas.',
    [sourceChain],
  );

  const onSourceChange = (next: string): void => {
    setSourceChain(next);
    // Keep source ≠ target: if the new source collides with the target, bump the
    // target to the first other chain.
    if (next === targetChain) {
      setTargetChain(firstOtherChain(next));
    }
  };

  const onSubmitPreview = (event: React.FormEvent): void => {
    event.preventDefault();
    setPendingParams({ receiver, amount, sourceChain, targetChain });
  };

  const onConfirm = (): void => {
    if (pendingParams === null) return;
    void transfer(pendingParams);
  };

  const onReset = (): void => {
    setPendingParams(null);
    reset();
  };

  if (status === 'error' && state.reason === 'locked') {
    return (
      <section className={styles.form} data-testid="xchain-locked">
        <p className={styles.lockedText}>
          Your wallet is locked — unlock it to transfer.
        </p>
        <button
          type="button"
          className={styles.primary}
          onClick={() => onRequireUnlock?.()}
        >
          Unlock
        </button>
      </section>
    );
  }

  return (
    <section className={styles.form} data-testid="xchain-form">
      {status !== 'done' && status !== 'pending' && !inFlight && (
        <form className={styles.fields} onSubmit={onSubmitPreview}>
          <div className={styles.routeRow}>
            <label className={styles.label}>
              <span className={styles.labelText}>From chain</span>
              <select
                data-testid="xchain-source"
                className={styles.input}
                value={sourceChain}
                onChange={(e) => onSourceChange(e.target.value)}
              >
                {CHAIN_IDS.map((id) => (
                  <option key={id} value={id}>
                    Chain {id}
                  </option>
                ))}
              </select>
            </label>

            <span className={styles.routeArrow} aria-hidden="true">
              →
            </span>

            <label className={styles.label}>
              <span className={styles.labelText}>To chain</span>
              <select
                data-testid="xchain-target"
                className={styles.input}
                value={targetChain}
                onChange={(e) => setTargetChain(e.target.value)}
              >
                {CHAIN_IDS.map((id) => (
                  <option key={id} value={id} disabled={id === sourceChain}>
                    Chain {id}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className={styles.receiverFieldset}>
            <legend className={styles.labelText}>Receiver</legend>
            <label className={styles.radioRow}>
              <input
                data-testid="xchain-receiver-self"
                type="radio"
                name="xchain-receiver-mode"
                checked={receiverMode === 'self'}
                onChange={() => setReceiverMode('self')}
              />
              <span>
                My account <span className={styles.mono}>{selfReceiver}</span>
              </span>
            </label>
            <label className={styles.radioRow}>
              <input
                data-testid="xchain-receiver-custom"
                type="radio"
                name="xchain-receiver-mode"
                checked={receiverMode === 'custom'}
                onChange={() => setReceiverMode('custom')}
              />
              <span>Another address</span>
            </label>
            {receiverMode === 'custom' && (
              <input
                data-testid="xchain-receiver-input"
                className={styles.input}
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="k:…"
                value={customReceiver}
                onChange={(e) => setCustomReceiver(e.target.value)}
              />
            )}
          </fieldset>

          <label className={styles.label}>
            <span className={styles.labelText}>
              Amount <TokenGlyph token="STOA" className={styles.amountGlyph} />
            </span>
            <input
              data-testid="xchain-amount"
              className={styles.input}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder="0.000000000000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>

          <span className={styles.gasMode} data-testid="xchain-gas-mode">
            {gasMode}
          </span>

          <button
            type="submit"
            data-testid="xchain-submit"
            className={styles.primary}
          >
            Review transfer
          </button>
        </form>
      )}

      {showPreview && pendingParams !== null && (
        <div className={styles.preview} data-testid="xchain-preview">
          <h3 className={styles.previewHeading}>Review cross-chain transfer</h3>
          <dl className={styles.previewList}>
            <div className={styles.previewRow}>
              <dt>Sender</dt>
              <dd className={styles.mono}>{selfReceiver}</dd>
            </div>
            <div className={styles.previewRow}>
              <dt>Receiver</dt>
              <dd className={styles.mono}>{pendingParams.receiver}</dd>
            </div>
            {receiverMode === 'self' && (
              <div className={styles.previewRow}>
                <dt>Receiver guard</dt>
                <dd>Your own keyset (self-transfer).</dd>
              </div>
            )}
            <div className={styles.previewRow}>
              <dt>Amount</dt>
              <dd className={styles.mono}>
                {pendingParams.amount}{' '}
                <TokenGlyph token="STOA" className={styles.amountGlyph} />
              </dd>
            </div>
            <div className={styles.previewRow}>
              <dt>Route</dt>
              <dd>
                Chain {pendingParams.sourceChain} → Chain{' '}
                {pendingParams.targetChain}
              </dd>
            </div>
            <div className={styles.previewRow}>
              <dt>Gas</dt>
              <dd>{gasMode}</dd>
            </div>
          </dl>
          <div className={styles.previewActions}>
            <button
              type="button"
              data-testid="xchain-confirm"
              className={styles.primary}
              onClick={onConfirm}
              disabled={inFlight}
            >
              Confirm &amp; transfer
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={onReset}
              disabled={inFlight}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {inFlight && (
        <div className={styles.stage} role="status" data-testid="xchain-stage">
          <StageText state={state} />
        </div>
      )}

      {status === 'done' && (
        <div className={styles.success} data-testid="xchain-success">
          <p className={styles.successText}>Cross-chain transfer complete.</p>
          <p className={styles.requestKey}>
            Continuation key:{' '}
            <span className={styles.mono}>{state.continuationKey}</span>
          </p>
          <button type="button" className={styles.secondary} onClick={onReset}>
            Transfer another
          </button>
        </div>
      )}

      {status === 'pending' && (
        <PendingPanel
          requestKey={state.requestKey}
          sourceChain={sourceChain}
          targetChain={targetChain}
          onRouteToRecovery={onRouteToRecovery}
          onReset={onReset}
        />
      )}

      {status === 'error' && state.reason !== 'locked' && (
        <div className={styles.error} role="alert" data-testid="xchain-error">
          <p className={styles.errorText}>
            The cross-chain transfer couldn&apos;t be sent. No funds left your
            account — check the details and try again.
          </p>
          <button type="button" className={styles.secondary} onClick={onReset}>
            Try again
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The staged progress line. During `waiting-spv` it renders the LIVE attempt/max
 * counter the poll emits, so the ~120s block-finality wait reads as progress
 * (n/30), never a frozen spinner.
 */
function StageText({
  state,
}: {
  state: ReturnType<typeof useCrossChainTransfer>['state'];
}): ReactNode {
  switch (state.step) {
    case 'building':
      return <>Preparing transfer…</>;
    case 'submitting':
      return <>Submitting the source-chain burn…</>;
    case 'waiting-spv':
      return (
        <>
          Waiting for SPV proof ({state.spvAttempt}/{state.spvMaxAttempts})…
        </>
      );
    default:
      return <>Working…</>;
  }
}

/**
 * The PENDING landing: the burn MAY have committed but its confirmation was
 * lost. It reads as PENDING (never success), surfaces the step-0 request key
 * with a copy affordance, and offers a "Use the Continue tab" action that routes
 * to recovery with the burn's identity prefilled. It renders NO re-send control —
 * a fresh burn would double-spend.
 */
function PendingPanel({
  requestKey,
  sourceChain,
  targetChain,
  onRouteToRecovery,
  onReset,
}: {
  requestKey: string;
  sourceChain: string;
  targetChain: string;
  onRouteToRecovery?: (route: CrossChainRecoveryRoute) => void;
  onReset: () => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);

  const onCopy = (): void => {
    void navigator.clipboard?.writeText(requestKey).then(() => setCopied(true));
  };

  return (
    <div className={styles.pending} role="status" data-testid="xchain-pending">
      <p className={styles.pendingText}>
        Submitted — confirmation unknown. This transfer is PENDING: the burn may
        have committed on the source chain. Do not re-send — resume it from the
        Continue tab instead.
      </p>
      <p className={styles.requestKey}>
        Request key: <span className={styles.mono}>{requestKey}</span>
      </p>
      <div className={styles.previewActions}>
        <button type="button" className={styles.secondary} onClick={onCopy}>
          {copied ? 'Copied' : 'Copy request key'}
        </button>
        <button
          type="button"
          data-testid="xchain-continue"
          className={styles.primary}
          onClick={() =>
            onRouteToRecovery?.({ requestKey, sourceChain, targetChain })
          }
        >
          Use the Continue tab with this Request Key
        </button>
        <button type="button" className={styles.secondary} onClick={onReset}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
