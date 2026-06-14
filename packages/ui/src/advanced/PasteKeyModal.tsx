import { isPastedKeyFormat, type AdvancedAccount } from '@stoawallet/core';
import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { ContextResolveForeignKeyResult } from './useAdvancedAccounts';
import styles from './PasteKeyModal.module.css';

const FORMAT_HINT = 'Must be 64 or 128 hex chars.';

/** Truncate a PUBLIC key for display. Never applied to the private key. */
function truncatePublic(publicKey: string): string {
  return `${publicKey.slice(0, 16)}…`;
}

/**
 * The transient outcome rendered after a paste attempt. It carries ONLY derived,
 * public, or constant text — NEVER the entered private key. This is what keeps a
 * mismatch message (and the DOM) free of secret material.
 */
type PasteOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'format-error' }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'guard-changed' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'signable' }
  | { readonly kind: 'watch-only'; readonly neededMore: number };

interface PasteKeyModalBodyProps {
  readonly account: AdvancedAccount;
  /**
   * Resolve the pasted key against the account guard. Injected (defaults to
   * `useAdvancedAccounts().pasteKey` at the call site). Receives the EXACT
   * entered value; this component keeps NO state copy of it afterward.
   */
  pasteKey(
    account: AdvancedAccount,
    privateKey: string,
  ): Promise<ContextResolveForeignKeyResult>;
  /** Close + clear. Invoked on cancel and after a successful accept. */
  onClose(): void;
  /**
   * Route the user to unlock when a paste hits a `locked` wallet. Optional: when
   * omitted the locked outcome still renders its neutral "unlock and retry"
   * message, just without an actionable unlock control.
   */
  onRequireUnlock?(): void;
}

export type PasteKeyModalProps = PasteKeyModalBodyProps;

function PasteKeyModalBody({
  account,
  pasteKey,
  onClose,
  onRequireUnlock,
}: PasteKeyModalBodyProps): React.JSX.Element {
  // RR#7: the raw private key lives in a ref-mirrored uncontrolled input, NOT in
  // useState. useState is React-tree/DevTools-observable and serializable into a
  // dev error overlay; a ref is none of those. The input is the single home of
  // the secret and we read `inputRef.current.value` only at submit time.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [outcome, setOutcome] = useState<PasteOutcome>({ kind: 'idle' });
  const [submitting, setSubmitting] = useState(false);

  const clearKey = useCallback(() => {
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  // Clear the secret on unmount so it never lingers in a detached input node.
  useEffect(() => () => clearKey(), [clearKey]);

  const stillNeeded = account.guardSummary?.keys ?? [];

  const handleSubmit = useCallback(async () => {
    const privateKey = inputRef.current?.value ?? '';

    // Client-side format pre-check before the round-trip, using core's single
    // `isPastedKeyFormat` gate (64/128 hex) so the UI never drifts from the
    // authoritative validation. The value is matched, never echoed: only a
    // constant hint is rendered on failure.
    if (!isPastedKeyFormat(privateKey)) {
      setOutcome({ kind: 'format-error' });
      return;
    }

    setSubmitting(true);
    try {
      const result = await pasteKey(account, privateKey);
      if (result.ok) {
        if (result.mode === 'send-capable') {
          setOutcome({ kind: 'signable' });
          clearKey();
          onClose();
          return;
        }
        setOutcome({ kind: 'watch-only', neededMore: result.neededMore });
        return;
      }
      // Failure branches render ONLY constant text or truncated public info —
      // the private key never reaches the DOM through any of these.
      if (result.reason === 'bad-format') {
        setOutcome({ kind: 'format-error' });
      } else if (result.reason === 'guard-changed') {
        setOutcome({ kind: 'guard-changed' });
      } else if (result.reason === 'locked') {
        // A locked wallet is NOT a key mismatch — surface a neutral unlock-and-
        // retry outcome (matching AddAdvancedAccount's locked treatment) instead
        // of the misleading "does not match the guard" message.
        setOutcome({ kind: 'locked' });
      } else {
        // 'key-mismatch' | 'invalid-key' → one safe message.
        setOutcome({ kind: 'mismatch' });
      }
    } finally {
      setSubmitting(false);
    }
  }, [account, pasteKey, onClose, clearKey]);

  const handleCancel = useCallback(() => {
    clearKey();
    setOutcome({ kind: 'idle' });
    onClose();
  }, [clearKey, onClose]);

  return (
    <div className={styles.backdrop}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Paste private key"
      >
        <h2 className={styles.heading}>Paste private key</h2>
        <p className={styles.subtle}>
          Provide the private key for this account&apos;s guard. Stored
          encrypted at rest.
        </p>

        {stillNeeded.length > 0 && (
          <div className={styles.guardPanel}>
            <span className={styles.guardLabel}>
              Still needed ({account.guardSummary?.pred ?? 'guard'}, threshold{' '}
              {account.guardSummary?.threshold ?? stillNeeded.length}):
            </span>
            <ul className={styles.pubKeyList}>
              {stillNeeded.map((pk) => (
                <li key={pk} className={styles.pubKey}>
                  {truncatePublic(pk)}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className={styles.field}>
          <input
            ref={inputRef}
            type="password"
            defaultValue=""
            autoComplete="off"
            spellCheck={false}
            maxLength={128}
            placeholder="64 or 128 hex chars"
            className={styles.input}
            aria-label="Private key"
            onChange={() => {
              if (outcome.kind !== 'idle') setOutcome({ kind: 'idle' });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSubmit();
            }}
          />
          <p className={styles.hint}>
            64-char = standard Ed25519 / Koala; 128-char = extended BIP32
            [kL|kR].
          </p>
        </div>

        {outcome.kind === 'format-error' && (
          <p className={styles.error} role="alert">
            {FORMAT_HINT}
          </p>
        )}
        {outcome.kind === 'mismatch' && (
          <p className={styles.error} role="alert">
            This key does not match the guard.
          </p>
        )}
        {outcome.kind === 'guard-changed' && (
          <p className={styles.error} role="alert">
            The account&apos;s guard changed — re-check.
          </p>
        )}
        {outcome.kind === 'locked' && (
          <div role="alert" data-testid="paste-locked">
            <p className={styles.error}>Wallet locked — unlock and retry.</p>
            {onRequireUnlock && (
              <button
                type="button"
                data-testid="paste-unlock"
                className={styles.secondary}
                onClick={() => onRequireUnlock()}
              >
                Unlock
              </button>
            )}
          </div>
        )}
        {outcome.kind === 'signable' && (
          <p className={styles.success}>Account is now signable.</p>
        )}
        {outcome.kind === 'watch-only' && (
          <p className={styles.pending}>
            Key accepted — {outcome.neededMore} more key(s) still needed.
          </p>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondary}
            onClick={handleCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={submitting}
            onClick={() => void handleSubmit()}
          >
            Paste key
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A minimal error boundary that swallows the rendered subtree on a render throw
 * and shows a neutral message. It deliberately captures NOTHING about the error
 * (no `error.message`, no component stack into state) so a throw mid-entry can
 * NEVER serialize the typed private key into a state-backed dev overlay. This is
 * intentionally NOT a state-serializing error reporter.
 */
class SecretSafeBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className={styles.backdrop}>
          <div className={styles.modal} role="dialog" aria-modal="true">
            <p className={styles.error}>
              Something went wrong. Please close and try again.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Paste-private-key modal: accepts a 64- or 128-char hex key and derives-to-
 * confirm against the account guard via `pasteKey`. The raw key never enters
 * React state and the rendered DOM never contains it (see RR#7 / secret hygiene
 * notes in the body and the boundary above).
 */
export function PasteKeyModal(props: PasteKeyModalProps): React.JSX.Element {
  return (
    <SecretSafeBoundary>
      <PasteKeyModalBody {...props} />
    </SecretSafeBoundary>
  );
}
