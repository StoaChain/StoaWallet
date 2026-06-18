import { STOA_CHAINS, coreInfo } from '@stoawallet/core';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useAddressBook } from '../addressbook/useAddressBook';
import { AmountDisplay } from '../components/AmountDisplay';
import { useBalances } from '../balances/useBalances';
import { useWallet } from '../context/WalletContext';
import { useToast } from '../toast/ToastContext';
import type { CrossChainRecoveryRoute } from '../crosschain/CrossChainTransferForm';
import {
  useCrossChainTransfer,
  type CrossChainTransferParams,
} from '../crosschain/useCrossChainTransfer';
import { TokenGlyph } from '../theme/TokenGlyph';
import styles from './SendForm.module.css';
import {
  useSendSameChain,
  type SendConfirmation,
  type UseSendSameChainOptions,
} from './useSendSameChain';

/** The StoaChain explorer transaction URL for a request key. */
function explorerTxUrl(requestKey: string): string {
  return `https://explorer.stoachain.com/transactions/${requestKey}`;
}

/** The StoaChain explorer ACCOUNT URL (for the gas-sponsor disclosures). */
function explorerAccountUrl(account: string): string {
  return `https://explorer.stoachain.com/accounts/${account}`;
}

/** The autonomic Ouronet Gas Station account that sponsors chain-0 / same-chain gas. */
const OURONET_GAS_STATION = 'c:iQQFWj6gWtpGEzhM_O5ekW1QtnQQy55R8BRPGhj_0FU';
/** The Chainweb cross-chain gas account that funds the continuation (step 1). */
const KADENA_XCHAIN_GAS = 'kadena-xchain-gas';

export interface SendFormProps {
  /**
   * Options forwarded verbatim to `useSendSameChain` — the stubbed send op,
   * the gasless gating source, and the on-success refresh trigger. The app
   * shell wires the real ops; tests inject stubs. The form itself never holds
   * key material: signing happens inside the context send op the hook calls.
   */
  readonly hookOptions?: UseSendSameChainOptions;
  /**
   * The SOURCE chain — fixed to the chain currently selected on the Stoa tab.
   * Unlike the Cross-chain action (which lets you pick the source freely), Send
   * locks the source to where you already are; you only choose the DESTINATION.
   * Defaults to the first braided chain when not provided (tests / standalone).
   */
  readonly sourceChain?: string;
  /** Called when a `locked` error should route the user to unlock. */
  readonly onRequireUnlock?: () => void;
  /**
   * When the user picks a destination chain different from the (fixed) source,
   * the Send form runs a fully-sponsored CROSS-CHAIN transfer. A PENDING burn
   * routes here so the shell can resume the SPV continuation (never re-burn) —
   * the same recovery seam the Cross-chain action uses.
   */
  readonly onRouteToRecovery?: (route: CrossChainRecoveryRoute) => void;
  /**
   * Whether the SOURCE chain is locked to {@link sourceChain} (the default, for
   * the Send action — "from where you are"). The Cross-chain action passes
   * `false` so the user can ALSO pick the source freely (a From dropdown); that
   * is the only difference between the two surfaces.
   */
  readonly lockSource?: boolean;
  /**
   * Options forwarded to the cross-chain hook (tests inject the stubbed step-0 op
   * + storage). Omitted in production so the hook wires the real context ops.
   */
  readonly crossChainHookOptions?: Parameters<typeof useCrossChainTransfer>[0];
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

/** Cross-chain steps during which the form is mid-flight (no new submit). */
const XCHAIN_IN_FLIGHT = new Set<string>(['building', 'submitting', 'waiting-spv']);

/** The NEXT braided chain after `source` (wrapping) — the self-transfer target. */
function nextChain(source: string): string {
  const n = (Number(source) + 1) % coreInfo.chainCount;
  return String(n);
}

/** Middle-truncate a `k:` address for compact display (keeps the gold ends). */
function shortAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

/**
 * Whether `amount` is a SENDABLE value: a plain non-negative decimal that is
 * strictly greater than zero and within 12 fractional digits. Mirrors the hook's
 * pre-flight so the Review control can gate BEFORE a preview ever opens — `0`,
 * `0.0`, empty, and malformed all fail.
 */
function amountIsSendable(amount: string): boolean {
  const trimmed = amount.trim();
  if (trimmed === '' || !/^\d+(\.\d+)?$/.test(trimmed)) return false;
  const dot = trimmed.indexOf('.');
  const fraction = dot === -1 ? '' : trimmed.slice(dot + 1);
  if (fraction.length > 12) return false;
  return Number(trimmed) > 0;
}

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
  sourceChain: sourceChainProp,
  lockSource = true,
  onRequireUnlock,
  onRouteToRecovery,
  crossChainHookOptions,
}: SendFormProps): ReactNode {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');

  // The SOURCE chain. For Send (`lockSource`) it is FIXED to the selected chain.
  // For the Cross-chain action (`lockSource === false`) it is user-editable (a
  // From dropdown) — the only difference between the two surfaces. `chainId`
  // aliases it so the gating/balance/send below read the source funds leave from.
  const [sourceChain, setSourceChain] = useState(sourceChainProp ?? CHAIN_IDS[0]);
  const chainId = sourceChain;

  // The DESTINATION is the only chain Send lets you pick. It defaults to the
  // source (a plain same-chain send); choosing a different chain makes it a
  // fully-sponsored CROSS-CHAIN transfer (the SAME core path the Cross-chain
  // action uses — gas station on chain 0 / kadena-xchain-gas elsewhere).
  const [targetChain, setTargetChain] = useState(sourceChain);
  const isCrossChain = targetChain !== sourceChain;

  // Editing the source (Cross-chain action only) keeps source ≠ target: if the new
  // source collides with the destination, bump the destination to the next chain.
  const onSourceChange = useCallback(
    (next: string): void => {
      setSourceChain(next);
      setTargetChain((current) => (current === next ? nextChain(next) : current));
    },
    [],
  );

  // The injected platform scanner. On web/extension this is UnsupportedQrScanner
  // (isAvailable false), so the affordance below stays hidden and the form is
  // manual-entry-only with no platform fork. The mobile app injects a real one.
  const { qrScanner, awaitSendConfirmation, activeAccount } = useWallet();
  const senderAddress = activeAccount?.account ?? '';

  // "Send to self": move your own funds to your OWN account on ANOTHER chain. The
  // recipient is locked to the sender and the destination is forced off the
  // source (the next chain), so it is ALWAYS a cross-chain self-transfer — a
  // same-chain self-send is pointless and stays unavailable while the tick is on.
  const [sendToSelf, setSendToSelf] = useState(false);
  const onToggleSelf = useCallback(
    (next: boolean): void => {
      setSendToSelf(next);
      if (next) {
        setRecipient(senderAddress);
        // Force the destination off the source to the next chain in line.
        if (targetChain === sourceChain) setTargetChain(nextChain(sourceChain));
      } else {
        setRecipient('');
        // Return the destination to the source — unticking self-send drops back
        // to a plain SAME-CHAIN send, so the cross-chain disclosure must clear.
        setTargetChain(sourceChain);
      }
    },
    [senderAddress, sourceChain, targetChain],
  );

  // The recipient address-book picker: a search + saved-name dropdown. The book
  // is plain config (name + public k:) — no key material.
  const addressBook = useAddressBook();
  const [bookOpen, setBookOpen] = useState(false);
  const [bookQuery, setBookQuery] = useState('');
  const bookBoxRef = useRef<HTMLDivElement | null>(null);
  // The save-this-address prompt shown after a send to an UNKNOWN address.
  const [saveName, setSaveName] = useState('');
  const [saveDismissed, setSaveDismissed] = useState(false);

  // Close the picker on an outside click so the collapsed input is the resting state.
  useEffect(() => {
    if (!bookOpen) return;
    function onDocClick(e: MouseEvent): void {
      if (bookBoxRef.current && !bookBoxRef.current.contains(e.target as Node)) {
        setBookOpen(false);
        setBookQuery('');
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [bookOpen]);
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

  // The SOURCE chain's spendable balance, shown under the amount field with a
  // Max affordance. Gas is sponsored, so the full balance is sendable.
  const getBalance = hookOptions?.getAvailableBalance ?? derivedGetAvailableBalance;
  const sourceBalance = getBalance(sourceChain);

  // The book entries matching the typed query (by name OR address); the dropdown
  // surfaces ~the first handful, search narrows the rest.
  const filteredBook = useMemo(() => {
    const q = bookQuery.trim().toLowerCase();
    const all = addressBook.entries;
    if (q === '') return all.slice(0, 10);
    return all
      .filter(
        (e) =>
          e.name.toLowerCase().includes(q) || e.address.toLowerCase().includes(q),
      )
      .slice(0, 10);
  }, [addressBook.entries, bookQuery]);

  // Gating is per selected chain, so the hook is fed the live selection.
  const options = useMemo<UseSendSameChainOptions>(
    () => ({
      ...hookOptions,
      chainId,
      getAvailableBalance:
        hookOptions?.getAvailableBalance ?? derivedGetAvailableBalance,
      // On-chain confirmation: the context op by default (tests may override via
      // hookOptions) so the form can report a real confirmed/failed outcome.
      awaitConfirmation: hookOptions?.awaitConfirmation ?? awaitSendConfirmation,
    }),
    [hookOptions, chainId, derivedGetAvailableBalance, awaitSendConfirmation],
  );

  const { state, confirmation, preview, gating, send, confirm, reset } =
    useSendSameChain(options);

  // The cross-chain transfer hook — the SAME state machine the Cross-chain action
  // drives (step-0 burn → SPV proof → continuation), with durable in-flight
  // persistence. Only exercised when `isCrossChain`; idle otherwise.
  const xchain = useCrossChainTransfer(crossChainHookOptions);
  // The cross-chain preview captured at "Review send" so the burn fires only on
  // an explicit confirm (mirrors the same-chain preview gate).
  const [xPreview, setXPreview] = useState<CrossChainTransferParams | null>(null);

  const status = state.status;
  const inFlight = IN_FLIGHT.has(status);
  const isLocked = status === 'error' && state.reason === 'locked';

  // Gate "Review send": require a valid `k:` recipient AND a sendable (> 0,
  // ≤12-decimal) amount, so an empty recipient or a 0 / 0.0 amount can never even
  // open the preview. (Self-send fills the recipient with the sender's k:.)
  const canReview =
    K_ACCOUNT_RE.test(recipient.trim()) && amountIsSendable(amount);

  const xStep = xchain.state.step;
  const xInFlight = XCHAIN_IN_FLIGHT.has(xStep);
  const xLocked =
    xchain.state.step === 'error' && xchain.state.reason === 'locked';

  // ── Transaction toasts (floating, self-dismissing — OuronetUI-style) ──
  // A submitted send opens a PENDING toast; when the on-chain outcome resolves the
  // SAME toast flips to ✓ confirmed / ✗ failed (with an auto-dismiss timer). The
  // refs dedupe by request key so each send toasts exactly once.
  const toast = useToast();
  const toastIdRef = useRef<string | null>(null);
  const toastedKeyRef = useRef<string | null>(null);
  const submittedKey = status === 'success' ? state.requestKey : null;

  useEffect(() => {
    if (submittedKey === null || toastedKeyRef.current === submittedKey) return;
    toastedKeyRef.current = submittedKey;
    toastIdRef.current = toast.show({
      status: 'pending',
      title: 'Transaction submitted',
      detail: 'Confirming on-chain…',
    });
  }, [submittedKey, toast]);

  useEffect(() => {
    const id = toastIdRef.current;
    if (id === null || confirmation === null || confirmation.phase === 'confirming') {
      return;
    }
    if (confirmation.phase === 'confirmed') {
      toast.update(id, {
        status: 'success',
        title: 'Transaction confirmed',
        detail:
          confirmation.blockHeight !== undefined
            ? `On chain #${chainId} · block ${confirmation.blockHeight}`
            : `On chain #${chainId}`,
        explorerUrl: explorerTxUrl(toastedKeyRef.current ?? ''),
        autoDismissMs: 6000,
      });
    } else if (confirmation.phase === 'failed') {
      toast.update(id, {
        status: 'error',
        title: 'Transaction failed on-chain',
        detail: confirmation.detail,
        autoDismissMs: 9000,
      });
    } else {
      toast.update(id, {
        status: 'info',
        title: "Couldn't confirm yet",
        detail: 'It may still be processing — check the explorer.',
        explorerUrl: explorerTxUrl(toastedKeyRef.current ?? ''),
        autoDismissMs: 9000,
      });
    }
    toastIdRef.current = null;
  }, [confirmation, toast, chainId]);

  // Cross-chain toast: a single pending → done/pending/error transition driven by
  // the SPV state machine (keyed by the burn's request key).
  const xToastIdRef = useRef<string | null>(null);
  const xToastedKeyRef = useRef<string | null>(null);
  const xRequestKey = xStep === 'waiting-spv' ? xchain.state.requestKey : null;

  useEffect(() => {
    if (xRequestKey !== null && xToastedKeyRef.current !== xRequestKey) {
      xToastedKeyRef.current = xRequestKey;
      xToastIdRef.current = toast.show({
        status: 'pending',
        title: 'Cross-chain transfer',
        detail: 'Burn submitted — waiting for SPV proof…',
      });
    }
  }, [xRequestKey, toast]);

  useEffect(() => {
    const id = xToastIdRef.current;
    if (id === null) return;
    if (xStep === 'done') {
      toast.update(id, {
        status: 'success',
        title: 'Cross-chain transfer complete',
        detail: undefined,
        autoDismissMs: 6000,
      });
      xToastIdRef.current = null;
    } else if (xStep === 'pending') {
      toast.update(id, {
        status: 'info',
        title: 'Cross-chain pending',
        detail: 'The burn may have committed — resume it from the Continue tab.',
        autoDismissMs: 9000,
      });
      xToastIdRef.current = null;
    } else if (xStep === 'error') {
      toast.update(id, {
        status: 'error',
        title: 'Cross-chain transfer failed',
        detail: undefined,
        autoDismissMs: 9000,
      });
      xToastIdRef.current = null;
    }
  }, [xStep, toast]);

  const onSubmitPreview = (event: React.FormEvent): void => {
    event.preventDefault();
    if (isCrossChain) {
      setXPreview({ receiver: recipient, amount, sourceChain: chainId, targetChain });
      return;
    }
    void send({ recipient, amount, chainId });
  };

  const onConfirm = (): void => {
    if (isCrossChain) {
      if (xPreview !== null) void xchain.transfer(xPreview);
      return;
    }
    void confirm();
  };

  const onCrossReset = (): void => {
    setXPreview(null);
    xchain.reset();
  };

  if (isLocked || xLocked) {
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
        <div className={styles.label}>
          <span className={`${styles.labelText} ${styles.labelRight}`}>
            Recipient
          </span>
          <div className={styles.recipientRow} ref={bookBoxRef}>
            <div className={styles.fieldGroup}>
              <input
                data-testid="send-recipient"
                className={styles.ghostInput}
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                aria-label="Recipient"
                placeholder="k:…"
                value={recipient}
                disabled={sendToSelf}
                onChange={(e) => setRecipient(e.target.value)}
              />
              {!sendToSelf && (
                <>
                  <span className={styles.fieldDivider} aria-hidden="true" />
                  <button
                    type="button"
                    data-testid="send-book-toggle"
                    className={styles.fieldIconButton}
                    aria-haspopup="listbox"
                    aria-expanded={bookOpen}
                    onClick={() => setBookOpen((open) => !open)}
                    aria-label="Pick from address book"
                    title="Address book"
                  >
                    <BookIcon />
                  </button>
                  {scanAvailable && (
                    <button
                      type="button"
                      data-testid="send-scan-qr"
                      className={styles.fieldIconButton}
                      onClick={() => void onScan()}
                      aria-label="Scan a recipient QR code"
                      title="Scan QR"
                    >
                      <ScanIcon />
                    </button>
                  )}
                </>
              )}
            </div>

            {bookOpen && !sendToSelf && (
              <div className={styles.bookDropdown}>
                <input
                  type="search"
                  className={styles.bookSearch}
                  aria-label="Search the address book"
                  placeholder="Search name or address…"
                  value={bookQuery}
                  onChange={(e) => setBookQuery(e.target.value)}
                  autoFocus
                />
                {filteredBook.length === 0 ? (
                  <p className={styles.bookEmpty} data-testid="send-book-empty">
                    {addressBook.entries.length === 0
                      ? 'No saved addresses yet.'
                      : 'No matches.'}
                  </p>
                ) : (
                  <ul className={styles.bookList} role="listbox" aria-label="Saved addresses">
                    {filteredBook.map((entry) => (
                      <li key={entry.address} role="presentation">
                        <button
                          type="button"
                          role="option"
                          aria-selected={recipient === entry.address}
                          className={styles.bookOption}
                          data-testid="send-book-entry"
                          onClick={() => {
                            setRecipient(entry.address);
                            setBookOpen(false);
                            setBookQuery('');
                          }}
                        >
                          <span className={styles.bookName}>{entry.name}</span>
                          <span className={styles.bookAddr}>
                            {shortAddress(entry.address)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <label className={styles.selfRow}>
            <span>Send to self (your account on another chain)</span>
            <input
              type="checkbox"
              data-testid="send-self-toggle"
              checked={sendToSelf}
              onChange={(e) => onToggleSelf(e.target.checked)}
            />
          </label>

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
        </div>

        <label className={styles.label}>
          <span className={styles.labelText}>
            Amount <TokenGlyph token="STOA" className={styles.amountGlyph} />
          </span>
          <div className={styles.fieldGroup}>
            <input
              data-testid="send-amount"
              className={styles.ghostInput}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder="0.000000000000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className={styles.fieldDivider} aria-hidden="true" />
            <button
              type="button"
              data-testid="send-max"
              className={styles.fieldMax}
              disabled={sourceBalance === null}
              onClick={() => {
                if (sourceBalance !== null) setAmount(sourceBalance);
              }}
            >
              MAX
            </button>
          </div>
          <span className={styles.balanceRow} data-testid="send-source-balance">
            <span className={styles.balanceLeft}>Balance on #{sourceChain}</span>
            <span className={styles.balanceValue}>
              {sourceBalance !== null ? (
                <AmountDisplay
                  amount={sourceBalance}
                  size="sub"
                  glyph="stoa"
                  align="right"
                />
              ) : (
                <span className={styles.balanceUnknown}>—</span>
              )}
            </span>
          </span>
        </label>

        <div className={styles.routeRow}>
          <label className={styles.label}>
            <span className={styles.labelText}>From chain</span>
            {lockSource ? (
              <div
                className={`${styles.input} ${styles.sourceFixed}`}
                data-testid="send-source-chain"
              >
                Chain {sourceChain}
              </div>
            ) : (
              <select
                data-testid="send-source-chain"
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
            )}
          </label>

          <span className={styles.routeArrow} aria-hidden="true">
            →
          </span>

          <label className={styles.label}>
            <span className={styles.labelText}>To chain</span>
            <select
              data-testid="send-chain"
              className={styles.input}
              value={targetChain}
              onChange={(e) => setTargetChain(e.target.value)}
            >
              {CHAIN_IDS.map((id) => (
                <option
                  key={id}
                  value={id}
                  disabled={sendToSelf && id === sourceChain}
                >
                  Chain {id}
                  {sendToSelf && id === sourceChain ? ' (source)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        {isCrossChain ? (
          <CrossChainSponsorship sourceChain={chainId} targetChain={targetChain} />
        ) : (
          <SameChainSponsorship gating={gating} />
        )}

        <button
          type="submit"
          data-testid="send-submit"
          className={styles.primary}
          disabled={inFlight || status === 'preview' || !canReview}
        >
          Review send
        </button>
      </form>

      {!isCrossChain && (status === 'preview' || inFlight) && preview !== null && (
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
          <ConfirmationIndicator
            confirmation={confirmation}
            requestKey={state.requestKey}
          />
          {!saveDismissed &&
            !sendToSelf &&
            K_ACCOUNT_RE.test(recipient) &&
            !addressBook.has(recipient) && (
              <div className={styles.savePrompt} data-testid="send-save-address">
                <p className={styles.savePromptText}>
                  Save this recipient to your address book?
                </p>
                <div className={styles.saveRow}>
                  <input
                    data-testid="send-save-name"
                    className={styles.input}
                    type="text"
                    autoComplete="off"
                    placeholder="Name (e.g. Alice)"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                  />
                  <button
                    type="button"
                    data-testid="send-save-confirm"
                    className={styles.primary}
                    disabled={saveName.trim() === ''}
                    onClick={() => {
                      void addressBook.save({
                        name: saveName.trim(),
                        address: recipient,
                      });
                      setSaveDismissed(true);
                    }}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => setSaveDismissed(true)}
                  >
                    Not now
                  </button>
                </div>
              </div>
            )}
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              setSaveName('');
              setSaveDismissed(false);
              reset();
            }}
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

      {/* ── Cross-chain (To ≠ From) — the fully-sponsored SPV flow ── */}
      {isCrossChain && xPreview !== null && (xStep === 'configure' || xInFlight) && (
        <div className={styles.preview} data-testid="send-xchain-preview">
          <h3 className={styles.previewHeading}>Review cross-chain transfer</h3>
          <dl className={styles.previewList}>
            <div className={styles.previewRow}>
              <dt>To</dt>
              <dd className={styles.mono}>{xPreview.receiver}</dd>
            </div>
            <div className={styles.previewRow}>
              <dt>Amount</dt>
              <dd className={styles.mono}>
                {xPreview.amount}{' '}
                <TokenGlyph token="STOA" className={styles.amountGlyph} />
              </dd>
            </div>
            <div className={styles.previewRow}>
              <dt>Route</dt>
              <dd>
                Chain {xPreview.sourceChain} → Chain {xPreview.targetChain}
              </dd>
            </div>
          </dl>
          <p className={styles.sponsorNote}>
            Gas is sponsored — you pay no transaction fee.
          </p>
          <div className={styles.previewActions}>
            <button
              type="button"
              data-testid="send-xchain-confirm"
              className={styles.primary}
              onClick={onConfirm}
              disabled={xInFlight}
            >
              Confirm &amp; send
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={onCrossReset}
              disabled={xInFlight}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isCrossChain && xInFlight && (
        <div className={styles.stage} role="status" data-testid="send-xchain-stage">
          <CrossChainStageText state={xchain.state} />
        </div>
      )}

      {isCrossChain && xchain.state.step === 'done' && (
        <div className={styles.success} data-testid="send-xchain-success">
          <p className={styles.successText}>Cross-chain transfer complete.</p>
          <p className={styles.requestKey}>
            Continuation key:{' '}
            <span className={styles.mono}>{xchain.state.continuationKey}</span>
          </p>
          <button type="button" className={styles.secondary} onClick={onCrossReset}>
            Send another
          </button>
        </div>
      )}

      {isCrossChain && xchain.state.step === 'pending' && (
        <div className={styles.pending} role="status" data-testid="send-xchain-pending">
          <p className={styles.pendingText}>
            Submitted — confirmation unknown. The source-chain burn may have
            committed. Do not re-send — resume it from the Continue tab.
          </p>
          <p className={styles.requestKey}>
            Request key: <span className={styles.mono}>{xchain.state.requestKey}</span>
          </p>
          <div className={styles.previewActions}>
            <button
              type="button"
              data-testid="send-xchain-continue"
              className={styles.primary}
              onClick={() => {
                if (xchain.state.step !== 'pending') return;
                onRouteToRecovery?.({
                  requestKey: xchain.state.requestKey,
                  sourceChain: xPreview?.sourceChain ?? chainId,
                  targetChain: xPreview?.targetChain ?? targetChain,
                });
              }}
            >
              Use the Continue tab with this Request Key
            </button>
            <button type="button" className={styles.secondary} onClick={onCrossReset}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {isCrossChain &&
        xchain.state.step === 'error' &&
        xchain.state.reason !== 'locked' && (
        <div className={styles.error} role="alert" data-testid="send-xchain-error">
          <p className={styles.errorText}>
            The cross-chain transfer couldn&apos;t be sent. No funds left your
            account — check the details and try again.
          </p>
          <button type="button" className={styles.secondary} onClick={onCrossReset}>
            Try again
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The cross-chain staged progress line. During `waiting-spv` it shows the live
 * SPV attempt/max counter the poll emits so the ~120s block-finality wait reads
 * as progress, never a frozen spinner.
 */
function CrossChainStageText({
  state,
}: {
  readonly state: ReturnType<typeof useCrossChainTransfer>['state'];
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

/** An inline "address book" glyph — an open book; `currentColor` inherits the
 * button's gold-on-near-black theme. `aria-hidden` defers labeling to the button. */
function BookIcon(): ReactNode {
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
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

/**
 * The on-chain confirmation indicator, layered under the submitted request key.
 * It turns the previously-silent "submitted, then nothing" gap into a live
 * lifecycle: a spinner while confirming, a ✓ with an explorer link once mined,
 * a ✗ with the on-chain reason on failure, and an honest "couldn't confirm —
 * check the explorer" when the listen times out (the tx may still be on chain).
 * `null` (no confirmation op wired) renders nothing.
 */
function ConfirmationIndicator({
  confirmation,
  requestKey,
}: {
  readonly confirmation: SendConfirmation | null;
  readonly requestKey: string;
}): ReactNode {
  if (confirmation === null) return null;

  const explorer = (
    <a
      className={styles.explorerLink}
      href={explorerTxUrl(requestKey)}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="send-explorer-link"
    >
      View on explorer ↗
    </a>
  );

  if (confirmation.phase === 'confirming') {
    return (
      <p
        className={styles.confirming}
        role="status"
        data-testid="send-confirming"
      >
        <span className={styles.spinner} aria-hidden="true" />
        Confirming on-chain…
      </p>
    );
  }

  if (confirmation.phase === 'confirmed') {
    return (
      <div className={styles.confirmed} data-testid="send-confirmed">
        <p className={styles.confirmedText}>
          ✓ Confirmed on-chain
          {confirmation.blockHeight !== undefined
            ? ` — block ${confirmation.blockHeight}.`
            : '.'}
        </p>
        {explorer}
      </div>
    );
  }

  if (confirmation.phase === 'failed') {
    return (
      <div className={styles.failedOnchain} role="alert" data-testid="send-failed-onchain">
        <p className={styles.failedText}>
          ✗ The transaction failed on-chain
          {confirmation.detail !== undefined ? `: ${confirmation.detail}` : '.'}
        </p>
        {explorer}
      </div>
    );
  }

  // unconfirmed: the listen timed out / failed — the tx MAY still be on chain.
  return (
    <div className={styles.unconfirmed} role="status" data-testid="send-unconfirmed">
      <p className={styles.unconfirmedText}>
        Couldn&apos;t confirm yet — it may still be processing. Check the explorer
        before sending again.
      </p>
      {explorer}
    </div>
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

/** A link to a gas-sponsor account on the StoaChain explorer. */
function SponsorLink({
  account,
  label,
}: {
  readonly account: string;
  readonly label: string;
}): ReactNode {
  return (
    <a
      className={styles.sponsorLink}
      href={explorerAccountUrl(account)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {label} ↗
    </a>
  );
}

/**
 * Same-chain gas disclosure: the gasless badge + a note that the Ouronet Gas
 * Station sponsors the fee, so the FULL balance is sendable (no gas held back).
 */
function SameChainSponsorship({ gating }: { gating: string }): ReactNode {
  return (
    <div className={styles.sponsorship} data-testid="send-sponsorship">
      <GaslessBadge gating={gating} />
      <p className={styles.sponsorNote}>
        Gas sponsored by the{' '}
        <SponsorLink account={OURONET_GAS_STATION} label="Ouronet Gas Station" /> —
        send your full balance, no gas fee.
      </p>
    </div>
  );
}

/**
 * Cross-chain gas disclosure: a TWO-STEP breakdown, both legs sponsored so the
 * user never pays gas. Step 0 (the source-chain burn) is covered by the Ouronet
 * Gas Station when leaving chain 0, else by `kadena-xchain-gas`; Step 1 (the
 * continuation/mint on the target chain) is covered by `kadena-xchain-gas`.
 */
function CrossChainSponsorship({
  sourceChain,
  targetChain,
}: {
  readonly sourceChain: string;
  readonly targetChain: string;
}): ReactNode {
  const step0IsGasStation = sourceChain === '0';
  return (
    <div className={styles.crossChainNote} data-testid="send-crosschain-note">
      <p className={styles.crossTitle}>
        Cross-chain transfer (Chain {sourceChain} → Chain {targetChain}) — 2 steps,
        both gas-sponsored:
      </p>
      <ol className={styles.stepList}>
        <li>
          <span className={styles.stepTag}>Step 0</span> burn on Chain {sourceChain},
          sponsored by{' '}
          {step0IsGasStation ? (
            <SponsorLink account={OURONET_GAS_STATION} label="Ouronet Gas Station" />
          ) : (
            <SponsorLink account={KADENA_XCHAIN_GAS} label="kadena-xchain-gas" />
          )}
        </li>
        <li>
          <span className={styles.stepTag}>Step 1</span> continuation on Chain{' '}
          {targetChain}, paid by{' '}
          <SponsorLink account={KADENA_XCHAIN_GAS} label="kadena-xchain-gas" />
        </li>
      </ol>
      <p className={styles.sponsorNote}>
        No gas fees — transfer without worrying about them.
      </p>
    </div>
  );
}
