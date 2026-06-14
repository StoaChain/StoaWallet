import { STOA_CHAINS } from '@stoawallet/core';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useBalances } from '../balances/useBalances';
import { useWallet } from '../context/WalletContext';
import { TokenGlyph } from '../theme/TokenGlyph';
import styles from './SendForm.module.css';
import {
  useSendSameChain,
  type UseSendSameChainOptions,
} from './useSendSameChain';

export interface SendFormProps {
  /**
   * Options forwarded verbatim to `useSendSameChain` — the stubbed send op,
   * the gasless gating source, and the on-success refresh trigger. The app
   * shell wires the real ops; tests inject stubs. The form itself never holds
   * key material: signing happens inside the context send op the hook calls.
   */
  readonly hookOptions?: UseSendSameChainOptions;
  /** Called when a `locked` error should route the user to unlock. */
  readonly onRequireUnlock?: () => void;
}

/**
 * The braided chain IDs, taken from core's canonical `STOA_CHAINS` array (the
 * single source of truth re-exported from `@stoachain/stoa-core/constants`).
 * StoaChain numbers its chains "0".."N-1" as strings — the same form
 * `getBalances` / the send op key on — so the selector and the send op agree
 * without a hardcoded list.
 */
const CHAIN_IDS: readonly string[] = STOA_CHAINS;

/** Statuses during which the send/confirm control must be disabled. */
const IN_FLIGHT = new Set<string>(['building', 'sending']);

/**
 * A `k:` single-key StoaChain address: the literal prefix `k:` followed by a
 * 64-char hex Ed25519 public key. This is the SAME gate core applies to a typed
 * recipient — a scanned value is untrusted, so it must clear this before it is
 * allowed to pre-fill the recipient field.
 */
const K_ACCOUNT_RE = /^k:[0-9a-fA-F]{64}$/;

/**
 * The transient outcome of the last QR scan, surfaced as a distinct message so a
 * permission denial or a garbage payload never reads as a silent no-op. `null`
 * is the resting state (a successful pre-fill, a cancel, or no scan yet).
 */
type ScanFeedback = 'invalid' | 'permission-denied';

/**
 * The same-chain SEND form: a `k:` recipient input, a 12-decimal-aware amount
 * input, and a chain selector populated from `CHAIN_IDS`. It composes
 * `useSendSameChain` and renders the explicit preview→confirm gate plus a
 * distinct affordance for every terminal state so the user is never misled:
 *
 *   - preview   → recipient/amount/chain review with a CONFIRM control; submit
 *                 does NOT run until confirm.
 *   - in-flight → a single honest "sending" stage (the core op is atomic, so the
 *                 form never advertises a submit stage it can't observe); the
 *                 confirm control is disabled to block a double-spend.
 *   - success   → the request key + a "send another" affordance.
 *   - pending   → a DISTINCT "submitted — confirmation unknown" message (the tx
 *                 may be on-chain), never success and never a re-send button.
 *   - gas-payer-rejected → its own message; when a self-paid fallback is
 *                 possible an INFORMATIONAL (non-executing) affordance shows.
 *   - locked    → routes to unlock rather than a generic error.
 *
 * The amount is passed to the hook as the typed STRING — never Number()'d,
 * rounded, or truncated — so 12-decimal precision survives intact. The form
 * emits no telemetry: nothing logs the recipient, amount, or any key material.
 */
export function SendForm({
  hookOptions,
  onRequireUnlock,
}: SendFormProps): ReactNode {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [chainId, setChainId] = useState(CHAIN_IDS[0]);

  // The injected platform scanner. On web/extension this is UnsupportedQrScanner
  // (isAvailable false), so the affordance below stays hidden and the form is
  // manual-entry-only with no platform fork. The mobile app injects a real one.
  const { qrScanner } = useWallet();
  const [scanAvailable, setScanAvailable] = useState(false);
  const [scanFeedback, setScanFeedback] = useState<ScanFeedback | null>(null);

  // Probe the scanner ONCE and gate the affordance on the result. The probe is
  // guarded against an unmount-after-resolve so it never sets state on a torn-
  // down form.
  useEffect(() => {
    let active = true;
    void qrScanner.isAvailable().then((available) => {
      if (active) setScanAvailable(available);
    });
    return () => {
      active = false;
    };
  }, [qrScanner]);

  // Open the scanner and reconcile its structured outcome:
  //   ok + valid k:    → pre-fill the recipient (NOT the chain — RR#11), clear msg
  //   ok + garbage     → distinct invalid-address message, no pre-fill
  //   invalid-payload  → SAME distinct invalid-address message (oversized / non-
  //                      ASCII QR was bounded out — the scan ran, the payload is
  //                      just not a usable address, so it must not read as silent)
  //   permission-denied→ distinct camera-permission message, manual entry stays
  //   cancelled        → silent return to manual entry
  //   unavailable      → silent (the affordance shouldn't have shown)
  // A recipient address is public; nothing here is logged.
  const onScan = useCallback(async (): Promise<void> => {
    const result = await qrScanner.scan();
    if (result.ok) {
      if (K_ACCOUNT_RE.test(result.value)) {
        setRecipient(result.value);
        setScanFeedback(null);
      } else {
        setScanFeedback('invalid');
      }
      return;
    }
    if (result.reason === 'invalid-payload') {
      setScanFeedback('invalid');
      return;
    }
    if (result.reason === 'permission-denied') {
      setScanFeedback('permission-denied');
      return;
    }
    // cancelled / unavailable: silent return to manual entry.
    setScanFeedback(null);
  }, [qrScanner]);

  // Per-chain spendable balance for the insufficient-funds pre-flight (RR#3).
  // The form composes `useBalances` (the single balance source) and projects a
  // selected-chain available amount into the hook; an explicit hookOptions
  // override (tests) takes precedence. A chain still loading / errored has no
  // funded|zero entry → null → the hook skips the over-balance check.
  const { chains } = useBalances();
  const derivedGetAvailableBalance = useCallback(
    (selected: string): string | null => {
      const entry = chains.find((c) => String(c.chainId) === selected);
      if (entry === undefined) return null;
      if (entry.kind === 'funded' || entry.kind === 'zero') return entry.balance;
      return null;
    },
    [chains],
  );

  // Gating is per selected chain, so the hook is fed the live selection.
  const options = useMemo<UseSendSameChainOptions>(
    () => ({
      ...hookOptions,
      chainId,
      getAvailableBalance:
        hookOptions?.getAvailableBalance ?? derivedGetAvailableBalance,
    }),
    [hookOptions, chainId, derivedGetAvailableBalance],
  );

  const { state, preview, gating, send, confirm, reset } =
    useSendSameChain(options);

  const status = state.status;
  const inFlight = IN_FLIGHT.has(status);
  const isLocked = status === 'error' && state.reason === 'locked';

  const onSubmitPreview = (event: React.FormEvent): void => {
    event.preventDefault();
    void send({ recipient, amount, chainId });
  };

  const onConfirm = (): void => {
    void confirm();
  };

  if (isLocked) {
    return (
      <section className={styles.form} data-testid="send-locked">
        <p className={styles.lockedText}>
          Your wallet is locked — unlock it to send.
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
    <section className={styles.form} data-testid="send-form">
      <form className={styles.fields} onSubmit={onSubmitPreview}>
        <label className={styles.label}>
          <span className={styles.labelText}>Recipient</span>
          <div className={styles.recipientRow}>
            <input
              data-testid="send-recipient"
              className={styles.input}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="k:…"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
            {scanAvailable && (
              <button
                type="button"
                data-testid="send-scan-qr"
                className={styles.scanButton}
                onClick={() => void onScan()}
                aria-label="Scan a recipient QR code"
                title="Scan QR"
              >
                <ScanIcon />
              </button>
            )}
          </div>
          {scanFeedback === 'invalid' && (
            <p
              className={styles.scanInvalid}
              role="alert"
              data-testid="send-scan-invalid"
            >
              That QR isn&apos;t a valid StoaChain address.
            </p>
          )}
          {scanFeedback === 'permission-denied' && (
            <p
              className={styles.scanPermission}
              role="alert"
              data-testid="send-scan-permission"
            >
              Camera access is needed to scan a QR — enable it in Settings, or
              enter the address manually.
            </p>
          )}
        </label>

        <label className={styles.label}>
          <span className={styles.labelText}>
            Amount <TokenGlyph token="STOA" className={styles.amountGlyph} />
          </span>
          <input
            data-testid="send-amount"
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

        <label className={styles.label}>
          <span className={styles.labelText}>Chain</span>
          <select
            data-testid="send-chain"
            className={styles.input}
            value={chainId}
            onChange={(e) => setChainId(e.target.value)}
          >
            {CHAIN_IDS.map((id) => (
              <option key={id} value={id}>
                Chain {id}
              </option>
            ))}
          </select>
        </label>

        <GaslessBadge gating={gating} />

        <button
          type="submit"
          data-testid="send-submit"
          className={styles.primary}
          disabled={inFlight || status === 'preview'}
        >
          Review send
        </button>
      </form>

      {(status === 'preview' || inFlight) && preview !== null && (
        <div className={styles.preview} data-testid="send-preview">
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
                <TokenGlyph token="STOA" className={styles.amountGlyph} />
              </dd>
            </div>
            <div className={styles.previewRow}>
              <dt>Chain</dt>
              <dd>{preview.chainId}</dd>
            </div>
            {preview.isNewAccount === true && (
              <div className={styles.previewRow}>
                <dt>New account</dt>
                <dd>A keyset will be created for this recipient.</dd>
              </div>
            )}
          </dl>
          <p className={styles.sponsorNote}>
            Gas is sponsored — you pay no transaction fee.
          </p>
          <div className={styles.previewActions}>
            <button
              type="button"
              data-testid="send-confirm"
              className={styles.primary}
              onClick={onConfirm}
              disabled={inFlight}
            >
              Confirm &amp; send
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
        <div className={styles.stage} role="status" data-testid="send-stage">
          Sending transfer…
        </div>
      )}

      {status === 'success' && (
        <div className={styles.success} data-testid="send-success">
          <p className={styles.successText}>Transfer submitted.</p>
          <p className={styles.requestKey}>
            Request key: <span className={styles.mono}>{state.requestKey}</span>
          </p>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => reset()}
          >
            Send another
          </button>
        </div>
      )}

      {status === 'pending' && (
        <div className={styles.pending} role="status" data-testid="send-pending">
          <p className={styles.pendingText}>
            Submitted — confirmation unknown. The transfer may have reached the
            network; check the explorer before retrying to avoid sending twice.
          </p>
          {state.requestKey !== undefined && (
            <p className={styles.requestKey}>
              Request key:{' '}
              <span className={styles.mono}>{state.requestKey}</span>
            </p>
          )}
        </div>
      )}

      {status === 'error' &&
        state.reason === 'gas-payer-rejected' && (
          <div
            className={styles.gasPayerRejected}
            role="alert"
            data-testid="send-gas-payer-rejected"
          >
            <p className={styles.gasPayerText}>
              This transfer can&apos;t be sponsored gaslessly right now — the
              gas-payer module rejected it (rate-limit / eligibility).
            </p>
            {state.selfPaidFallbackPossible === true ? (
              <p
                className={styles.selfPaidFallback}
                data-testid="send-self-paid-fallback"
              >
                You may be able to send paying gas yourself. (Self-paid sending
                isn&apos;t available in this build yet.)
              </p>
            ) : (
              <p className={styles.gasPayerText}>
                It can&apos;t proceed gaslessly right now.
              </p>
            )}
          </div>
        )}

      {status === 'error' && state.reason === 'invalid-amount' && (
        <div className={styles.error} role="alert" data-testid="send-invalid-amount">
          <p className={styles.errorText}>
            Enter a valid amount — a positive number with at most 12 decimal
            places.
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

      {status === 'error' && state.reason === 'insufficient-funds' && (
        <div
          className={styles.error}
          role="alert"
          data-testid="send-insufficient-funds"
        >
          <p className={styles.errorText}>
            Insufficient funds on the selected chain for this amount.
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

      {status === 'error' &&
        state.reason !== 'gas-payer-rejected' &&
        state.reason !== 'locked' &&
        state.reason !== 'invalid-amount' &&
        state.reason !== 'insufficient-funds' && (
          <div className={styles.error} role="alert" data-testid="send-error">
            <p className={styles.errorText}>
              The transfer couldn&apos;t be sent. Check the recipient and amount
              and try again.
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
    </section>
  );
}

/**
 * An inline "scan QR" glyph (lucide is not installed). Four bracketed corners
 * framing a viewport — the conventional scan/scanner mark. `currentColor` inherits
 * the button's gold-on-near-black theme color; `aria-hidden` defers labeling to
 * the button's `aria-label`.
 */
function ScanIcon(): ReactNode {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <line x1="7" y1="12" x2="17" y2="12" />
    </svg>
  );
}

/**
 * The gold-tinted gasless pill. A `verified` chain advertises UNCONDITIONAL
 * "gasless"; a `simulate-only` chain uses the hedged framing so the wallet
 * never over-promises a sponsorship it only confirmed via simulation.
 */
function GaslessBadge({ gating }: { gating: string }): ReactNode {
  const verified = gating === 'verified';
  return (
    <span className={styles.gaslessBadge} data-testid="gasless-badge">
      {verified ? 'gasless' : 'gasless — verified by simulation only'}
    </span>
  );
}
