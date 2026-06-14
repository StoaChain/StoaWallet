import { STOA_CHAINS } from '@stoawallet/core';
import type { AdvancedAccount } from '@stoawallet/core';
import { useState, type ReactNode } from 'react';

import { TokenGlyph } from '../theme/TokenGlyph';
import styles from './AddAdvancedAccount.module.css';
import { PasteKeyModal } from './PasteKeyModal';
import {
  useAdvancedAccounts,
  type UseAdvancedAccountsOptions,
} from './useAdvancedAccounts';

export interface AddAdvancedAccountProps {
  /**
   * Options forwarded verbatim to `useAdvancedAccounts` — the stubbed add op,
   * the foreign-key-resolve op, and the list reader. The app shell wires the
   * real ops behind the context seam; tests inject stubs. The view itself never
   * holds key material.
   */
  readonly hookOptions?: UseAdvancedAccountsOptions;
  /**
   * Optional EXTERNAL entry point for resolving a foreign key on a watch-only
   * account. When provided, the view hands the account up and the host drives its
   * own paste flow. When OMITTED (the default), the view renders `PasteKeyModal`
   * INLINE, sharing the SINGLE `useAdvancedAccounts` instance so a successful
   * watch-only -> send-capable promotion re-reads the shared list and the row
   * flips to send-capable without a second hook instance going stale.
   */
  readonly onPasteKey?: (account: AdvancedAccount) => void;
  /** Called when a `locked` error should route the user to unlock. */
  readonly onRequireUnlock?: () => void;
}

/**
 * The braided chain IDs from core's canonical `STOA_CHAINS`. StoaChain numbers
 * its chains "0".."N-1" as strings — the same form the add op keys on — so the
 * selector and the op agree without a hardcoded list. The default is chain "0".
 */
const CHAIN_IDS: readonly string[] = STOA_CHAINS;

/** Truncate a `k:`/custom address to head…tail for compact list display. */
function truncateAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 10)}…${address.slice(-6)}`;
}

/**
 * The ADD-ADVANCED-ACCOUNT view: an address input + a chain selector (default
 * "0") + an Add control composing `useAdvancedAccounts`. It renders a DISTINCT
 * affordance per terminal so the user is never misled:
 *
 *   - adding     → a staged-progress affordance (never a frozen/blank state).
 *   - added/send-capable → a clear "added — signable" affordance.
 *   - added/watch-only   → a CLEARLY-LABELLED watch-only add ("balances visible,
 *                 sending disabled"), the exact "N more key(s) needed to sign"
 *                 count, and a "paste a private key" entry point (handed up via
 *                 `onPasteKey`). The watch-only LIST row NEVER renders a send
 *                 action — send is gated on `mode` structurally.
 *   - warning/not-key-guarded → a distinct, non-error warning (the guard is not
 *                 key-based and cannot be added as signable); nothing send-capable.
 *   - warning/unrecognized-predicate → its own distinct warning.
 *   - error/locked → routes to unlock rather than a generic error.
 *
 * The view emits no telemetry: nothing logs the address or any key material.
 */
export function AddAdvancedAccount({
  hookOptions,
  onPasteKey,
  onRequireUnlock,
}: AddAdvancedAccountProps): ReactNode {
  const [address, setAddress] = useState('');
  const [chainId, setChainId] = useState(CHAIN_IDS[0] ?? '0');
  // The account whose paste modal is open (inline default flow). Null = no modal.
  const [pasteTarget, setPasteTarget] = useState<AdvancedAccount | null>(null);

  const { state, advancedAccounts, addAccount, pasteKey } =
    useAdvancedAccounts(hookOptions);

  const status = state.status;
  const isLocked = status === 'error' && state.reason === 'locked';

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    void addAccount(address.trim(), chainId);
  };

  // Default flow: open the INLINE modal bound to THIS hook instance. An external
  // host can override by passing `onPasteKey` (then it drives its own flow).
  const handlePasteKey = (account: AdvancedAccount): void => {
    if (onPasteKey) {
      onPasteKey(account);
      return;
    }
    setPasteTarget(account);
  };

  return (
    <section className={styles.view} data-testid="advanced-view">
      <form className={styles.fields} onSubmit={onSubmit}>
        <label className={styles.label}>
          <span className={styles.labelText}>Account address</span>
          <input
            data-testid="advanced-address"
            className={styles.input}
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="k:…"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>

        <label className={styles.label}>
          <span className={styles.labelText}>Chain</span>
          <select
            data-testid="advanced-chain"
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

        <button
          type="submit"
          data-testid="advanced-submit"
          className={styles.primary}
          disabled={status === 'adding'}
        >
          Add account
        </button>
      </form>

      {status === 'adding' && (
        <div className={styles.stage} role="status" data-testid="advanced-adding">
          Adding account — checking its on-chain guard…
        </div>
      )}

      {status === 'added' && state.mode === 'send-capable' && (
        <div
          className={styles.success}
          role="status"
          data-testid="advanced-added"
        >
          <p className={styles.successText}>Added — signable.</p>
          <p className={styles.resultDetail}>
            This account&apos;s guard is satisfied — it can sign transfers.
          </p>
        </div>
      )}

      {status === 'added' && state.mode === 'watch-only' && (
        <div
          className={styles.watchOnly}
          role="status"
          data-testid="advanced-added"
        >
          <p className={styles.watchOnlyText}>
            Watch-only: balances visible, sending disabled.
          </p>
          <p className={styles.resultDetail}>
            {state.neededMore ?? 0} more key(s) needed to sign.
          </p>
          <button
            type="button"
            data-testid="advanced-paste-key"
            className={styles.secondary}
            onClick={() => handlePasteKey(state.account)}
          >
            Paste a private key
          </button>
        </div>
      )}

      {status === 'warning' && (
        <div
          className={styles.warning}
          role="alert"
          data-testid="advanced-warning"
        >
          {state.reason === 'not-key-guarded' ? (
            <p className={styles.warningText}>
              Only key-based guards are supportable. This account&apos;s guard is
              not key-based and cannot be added as signable.
            </p>
          ) : (
            <p className={styles.warningText}>
              This account&apos;s guard uses an unrecognized predicate, so it was
              added watch-only and cannot be auto-treated as signable.
            </p>
          )}
        </div>
      )}

      {isLocked && (
        <div className={styles.locked} role="alert" data-testid="advanced-locked">
          <p className={styles.lockedText}>
            Your wallet is locked — unlock it to add an account.
          </p>
          <button
            type="button"
            data-testid="advanced-unlock"
            className={styles.primary}
            onClick={() => onRequireUnlock?.()}
          >
            Unlock
          </button>
        </div>
      )}

      {status === 'error' && !isLocked && (
        <div className={styles.error} role="alert" data-testid="advanced-error">
          <p className={styles.errorText}>
            The account couldn&apos;t be added. Check the address and try again.
          </p>
        </div>
      )}

      <AdvancedAccountList accounts={advancedAccounts} />

      {pasteTarget !== null && (
        <PasteKeyModal
          account={pasteTarget}
          pasteKey={pasteKey}
          onClose={() => setPasteTarget(null)}
          onRequireUnlock={onRequireUnlock}
        />
      )}
    </section>
  );
}

/**
 * The advanced-accounts list. Each row shows the truncated address + a mode
 * badge. A `send-capable` row carries an HONEST, disabled "send via send screen"
 * affordance rather than a live Send button: the end-to-end advanced-account SEND
 * FORM is a forward dependency (no task in this phase builds it; the sign-ready
 * keypair SET is reachable via `WalletContext.resolveAdvancedSigningKeypairs`, but
 * the form that consumes it ships later). A watch-only row structurally has no
 * send affordance at all, so a not-yet-signable account can never be mistaken for
 * spendable.
 */
function AdvancedAccountList({
  accounts,
}: {
  accounts: readonly AdvancedAccount[];
}): ReactNode {
  if (accounts.length === 0) return null;

  return (
    <ul className={styles.list} data-testid="advanced-list">
      {accounts.map((account) => {
        const sendCapable = account.mode === 'send-capable';
        return (
          <li
            key={account.id}
            className={styles.row}
            data-testid={`advanced-row-${account.id}`}
          >
            <span className={styles.rowAddress}>
              {truncateAddress(account.address)}
            </span>
            <span
              data-testid="advanced-badge"
              className={
                sendCapable ? styles.badgeSendCapable : styles.badgeWatchOnly
              }
            >
              {account.mode}
            </span>
            {sendCapable && (
              <button
                type="button"
                data-testid="advanced-row-send"
                className={styles.rowSend}
                disabled
                title="Sending for advanced accounts arrives with the send screen."
              >
                Send via send screen{' '}
                <TokenGlyph token="STOA" className={styles.rowSendGlyph} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
