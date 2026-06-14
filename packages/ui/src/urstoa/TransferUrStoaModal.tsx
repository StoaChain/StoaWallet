import { useState, type ReactNode } from 'react';

import { UrStoaMark } from './glyph';
import styles from './TransferUrStoaModal.module.css';
import {
  useTransferUrStoa,
  type UseTransferUrStoaOptions,
  type UseTransferUrStoaResult,
} from './useTransferUrStoa';

export interface TransferUrStoaModalProps {
  /** Whether the modal is mounted/visible. T12.10's card opens it by flipping this. */
  readonly open: boolean;
  /** Dismiss the modal (the card's open-state owner closes it). */
  readonly onClose: () => void;
  /**
   * Options forwarded verbatim to `useTransferUrStoa` — the wallet balance for
   * the insufficient-funds pre-flight and the on-success holdings `refresh`. The
   * app shell wires the real seams; the modal itself never holds key material.
   */
  readonly hookOptions?: UseTransferUrStoaOptions;
  /** Called when a `locked` error should route the user to unlock. */
  readonly onRequireUnlock?: () => void;
  /**
   * The composed transfer hook. Defaults to the real `useTransferUrStoa`; tests
   * inject a stub so each staged/terminal state can be rendered in isolation.
   */
  readonly useTransfer?: (
    options?: UseTransferUrStoaOptions,
  ) => UseTransferUrStoaResult;
}

/** Statuses during which the confirm control must be disabled (RR#6). */
const IN_FLIGHT = new Set<string>(['building', 'submitting']);

/**
 * The native UrStoa TRANSFER modal (chain 0 only — NO chain selector). Composes
 * the T12.9 `useTransferUrStoa` hook into a recipient `k:` input + a decimal-aware
 * amount input, an explicit preview→confirm gate (RR#5), staged progress, and a
 * distinct affordance for every terminal state so the user is never misled:
 *
 *   - preview   → recipient/amount review + a gasless sponsor + new-account note,
 *                 with an explicit CONFIRM; sign+submit does NOT run until confirm.
 *   - in-flight → a single honest staged-progress line (the core op is atomic);
 *                 the confirm control is disabled to block a double-spend.
 *   - success   → the request key (the hook fires the holdings refresh).
 *   - pending   → a DISTINCT "submitted — confirmation unknown" panel (the tx may
 *                 be on-chain), never success and never an auto-resubmit (RR#6).
 *   - error     → a distinct inline message per reason (invalid-recipient /
 *                 insufficient-funds / gas-payer-rejected); `locked` routes to
 *                 unlock rather than a generic error.
 *
 * The amount reaches the hook as the typed STRING — never Number()'d, rounded, or
 * truncated — so 24-decimal precision survives intact (the T12.1 formatter handles
 * the on-chain literal downstream). The modal emits no telemetry: nothing logs the
 * recipient, amount, or any key material.
 */
export function TransferUrStoaModal({
  open,
  onClose,
  hookOptions,
  onRequireUnlock,
  useTransfer = useTransferUrStoa,
}: TransferUrStoaModalProps): ReactNode {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');

  const { state, preview, send, confirm, reset } = useTransfer(hookOptions);

  if (!open) return null;

  const status = state.status;
  const inFlight = IN_FLIGHT.has(status);
  const isLocked = status === 'error' && state.reason === 'locked';
  const reason = status === 'error' ? state.reason : undefined;

  const onSubmitPreview = (event: React.FormEvent): void => {
    event.preventDefault();
    void send({ recipient, amount });
  };

  const onConfirm = (): void => {
    void confirm();
  };

  const onCancel = (): void => {
    reset();
    setRecipient('');
    setAmount('');
    onClose();
  };

  return (
    <div
      className={styles.backdrop}
      data-testid="urstoa-transfer-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Transfer UrStoa"
    >
      <section className={styles.modal}>
        <header className={styles.header}>
          <h2 className={styles.title}>
            Transfer <UrStoaMark className={styles.titleGlyph} />
          </h2>
          <button
            type="button"
            className={styles.close}
            onClick={onCancel}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {isLocked ? (
          <div className={styles.locked} data-testid="urstoa-transfer-locked">
            <p className={styles.lockedText}>
              Your wallet is locked — unlock it to transfer.
            </p>
            <button
              type="button"
              data-testid="urstoa-transfer-unlock"
              className={styles.primary}
              onClick={() => onRequireUnlock?.()}
            >
              Unlock
            </button>
          </div>
        ) : (
          <>
            <form className={styles.fields} onSubmit={onSubmitPreview}>
              <label className={styles.label}>
                <span className={styles.labelText}>Recipient</span>
                <input
                  data-testid="urstoa-transfer-recipient"
                  className={styles.input}
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="k:…"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                />
              </label>

              <label className={styles.label}>
                <span className={styles.labelText}>
                  Amount <UrStoaMark className={styles.amountGlyph} />
                </span>
                <input
                  data-testid="urstoa-transfer-amount"
                  className={styles.input}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0.000000000000000000000000"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>

              {reason === 'invalid-recipient' && (
                <p
                  className={styles.inlineError}
                  role="alert"
                  data-testid="urstoa-transfer-invalid-recipient"
                >
                  Enter a valid recipient — a k: account that isn&apos;t your own.
                </p>
              )}
              {reason === 'invalid-amount' && (
                <p
                  className={styles.inlineError}
                  role="alert"
                  data-testid="urstoa-transfer-invalid-amount"
                >
                  Enter a valid amount — a positive number with at most 24
                  decimal places.
                </p>
              )}
              {reason === 'insufficient-funds' && (
                <p
                  className={styles.inlineError}
                  role="alert"
                  data-testid="urstoa-transfer-insufficient-funds"
                >
                  Insufficient UrStoa in your wallet for this amount.
                </p>
              )}

              <button
                type="submit"
                data-testid="urstoa-transfer-submit"
                className={styles.primary}
                disabled={inFlight || status === 'preview'}
              >
                Review transfer
              </button>
            </form>

            {(status === 'preview' || inFlight) && preview !== null && (
              <div
                className={styles.preview}
                data-testid="urstoa-transfer-preview"
              >
                <h3 className={styles.previewHeading}>Review transfer</h3>
                <dl className={styles.previewList}>
                  <div className={styles.previewRow}>
                    <dt>To</dt>
                    <dd className={styles.mono}>{preview.recipient}</dd>
                  </div>
                  <div className={styles.previewRow}>
                    <dt>Amount</dt>
                    <dd className={styles.mono}>
                      {preview.amount}{' '}
                      <UrStoaMark className={styles.amountGlyph} />
                    </dd>
                  </div>
                  <div className={styles.previewRow}>
                    <dt>Chain</dt>
                    <dd>0</dd>
                  </div>
                </dl>
                <p className={styles.newAccountNote}>
                  If the recipient has no account yet, a single-key keyset is
                  created for them as part of this transfer.
                </p>
                <span
                  className={styles.gaslessBadge}
                  data-testid="urstoa-transfer-gasless"
                >
                  gasless — the gas station pays the fee
                </span>
                <div className={styles.previewActions}>
                  <button
                    type="button"
                    data-testid="urstoa-transfer-confirm"
                    className={styles.primary}
                    onClick={onConfirm}
                    disabled={inFlight}
                  >
                    Confirm &amp; transfer
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => reset()}
                    disabled={inFlight}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {inFlight && (
              <div
                className={styles.stage}
                role="status"
                data-testid="urstoa-transfer-stage"
              >
                {status === 'building'
                  ? 'Preparing transfer…'
                  : 'Submitting transfer…'}
              </div>
            )}

            {status === 'success' && (
              <div
                className={styles.success}
                data-testid="urstoa-transfer-success"
              >
                <p className={styles.successText}>Transfer submitted.</p>
                <p className={styles.requestKey}>
                  Request key:{' '}
                  <span className={styles.mono}>{state.requestKey}</span>
                </p>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => {
                    reset();
                    setRecipient('');
                    setAmount('');
                  }}
                >
                  Transfer again
                </button>
              </div>
            )}

            {status === 'pending' && (
              <div
                className={styles.pending}
                role="status"
                data-testid="urstoa-transfer-pending"
              >
                <p className={styles.pendingText}>
                  Submitted — confirmation unknown. The transfer may have reached
                  the network; check the explorer before retrying to avoid sending
                  twice.
                </p>
                {state.requestKey !== undefined && (
                  <p className={styles.requestKey}>
                    Request key:{' '}
                    <span className={styles.mono}>{state.requestKey}</span>
                  </p>
                )}
              </div>
            )}

            {reason === 'gas-payer-rejected' && (
              <div
                className={styles.gasPayerRejected}
                role="alert"
                data-testid="urstoa-transfer-gas-payer-rejected"
              >
                <p className={styles.gasPayerText}>
                  This transfer can&apos;t be sponsored gaslessly right now — the
                  gas-payer module rejected it (rate-limit / eligibility). Try
                  again shortly.
                </p>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => reset()}
                >
                  Try again
                </button>
              </div>
            )}

            {reason !== undefined &&
              reason !== 'invalid-recipient' &&
              reason !== 'invalid-amount' &&
              reason !== 'insufficient-funds' &&
              reason !== 'gas-payer-rejected' &&
              reason !== 'locked' && (
                <div
                  className={styles.error}
                  role="alert"
                  data-testid="urstoa-transfer-error"
                >
                  <p className={styles.errorText}>
                    The transfer couldn&apos;t be sent. Check the recipient and
                    amount and try again.
                  </p>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => reset()}
                  >
                    Try again
                  </button>
                </div>
              )}
          </>
        )}
      </section>
    </div>
  );
}
