import { useEffect, useRef, useState, type ReactNode } from 'react';

import { AmountDisplay } from '../components/AmountDisplay';
import { useToast } from '../toast/ToastContext';
import { useTxToast } from '../toast/useTxToast';

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

  // The sender's spendable UrStoa balance (chain 0) — the SAME value the hook uses
  // for its insufficient-funds pre-flight. Shown under the amount + driving MAX
  // (gas is sponsored, so the full balance is sendable). Null = unknown read.
  const walletBalance = hookOptions?.walletBalance ?? null;

  // Once SUBMITTED, hand off to the shared floating tx toast (pending → confirmed
  // → auto-dismiss) and return to the overview — the SAME mechanism every flow uses.
  const trackTx = useTxToast();
  const toast = useToast();
  const refresh = hookOptions?.refresh;
  const firedRef = useRef<string | null>(null);
  useEffect(() => {
    const s = state.status;
    if (s !== 'success' && s !== 'pending') return;
    const requestKey =
      'requestKey' in state ? (state.requestKey ?? undefined) : undefined;
    const fireKey = requestKey ?? (s === 'pending' ? 'pending' : null);
    if (fireKey === null || firedRef.current === fireKey) return;
    firedRef.current = fireKey;
    if (requestKey !== undefined) {
      trackTx({ requestKey, chainId: '0', label: 'Transfer', onConfirmed: refresh });
    } else {
      toast.show({
        status: 'info',
        title: 'Transfer submitted',
        detail: 'Confirmation unknown — check the explorer.',
        autoDismissMs: 9000,
      });
    }
    onClose();
  }, [state, trackTx, toast, refresh, onClose]);

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

  return (
    <section className={styles.page} data-testid="urstoa-transfer-modal">
      <h2 className={styles.title}>
        Transfer <UrStoaMark decorative className={styles.titleGlyph} />
      </h2>

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
                <div className={styles.fieldGroup}>
                  <input
                    data-testid="urstoa-transfer-recipient"
                    className={styles.ghostInput}
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Recipient"
                    placeholder="k:…"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                  />
                </div>
              </label>

              <label className={styles.label}>
                <span className={styles.labelText}>
                  Amount <UrStoaMark className={styles.amountGlyph} />
                </span>
                <div className={styles.fieldGroup}>
                  <input
                    data-testid="urstoa-transfer-amount"
                    className={styles.ghostInput}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="0.000"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <span className={styles.fieldDivider} aria-hidden="true" />
                  <button
                    type="button"
                    data-testid="urstoa-transfer-max"
                    className={styles.fieldMax}
                    disabled={walletBalance === null}
                    onClick={() => {
                      if (walletBalance !== null) setAmount(walletBalance);
                    }}
                  >
                    MAX
                  </button>
                </div>
                <span
                  className={styles.balanceRow}
                  data-testid="urstoa-transfer-balance"
                >
                  <span className={styles.balanceLeft}>Wallet balance</span>
                  <span className={styles.balanceValue}>
                    {walletBalance !== null ? (
                      <AmountDisplay
                        amount={walletBalance}
                        size="sub"
                        glyph="urstoa"
                        align="right"
                      />
                    ) : (
                      <span className={styles.balanceUnknown}>—</span>
                    )}
                  </span>
                </span>
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
                  Enter a valid amount — a positive number.
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
                    <dd>
                      <AmountDisplay
                        amount={preview.amount}
                        size="sub"
                        glyph="urstoa"
                        align="right"
                      />
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

            {/* Submitted/pending outcomes are handed to the floating tx toast
                (which confirms on-chain + auto-dismisses); the page returns to the
                overview. Validation + gas-payer errors stay inline below. */}

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
  );
}
