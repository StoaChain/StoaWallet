import { useCallback, useState } from 'react';

import { PasswordInput } from '../components/PasswordInput';
import { useWallet, type WalletActionReason } from '../context/WalletContext';
import styles from './CreateWalletFlow.module.css';

/**
 * The streamlined create-wallet flow:
 *
 *   1. BACKUP   — display the freshly generated 24-word phrase in a numbered
 *                 grid with copy-to-clipboard, gated behind a confirmation
 *                 checkbox the user must tick before continuing.
 *   2. PASSWORD — collect + confirm an encryption password and seal the wallet
 *                 via `saveWallet`, which clears the in-memory phrase on success.
 *
 * The plaintext phrase lives only in the wallet context's state; this component
 * renders it but never logs it and never lifts it into a wider store. On a
 * successful save the context scrubs `words`, so nothing persists in the UI.
 */

export interface CreateWalletFlowProps {
  /** Invoked once the wallet is sealed and the flow is complete. */
  onComplete(): void;
}

type Step = 'backup' | 'password';

/** Human-readable copy for each discriminated save failure. */
const REASON_COPY: Record<WalletActionReason, string> = {
  'wrong-password': 'The password was incorrect.',
  'corrupt-envelope': 'The stored wallet data is corrupt and cannot be read.',
  'unsupported-format': 'The stored wallet uses an unsupported format.',
  'corrupt-vault': 'The wallet store is corrupt and cannot be read.',
  'word-count': 'The recovery phrase has the wrong number of words.',
  'invalid-words': 'The recovery phrase contains invalid words.',
  'no-wallet': 'No wallet was found to save.',
  locked: 'The wallet is locked. Unlock it and try again.',
  unknown: 'Something went wrong while creating your wallet.',
};

export function CreateWalletFlow({
  onComplete,
}: CreateWalletFlowProps): React.ReactElement {
  const { words, hasConfirmedBackup, setHasConfirmedBackup, saveWallet, startCreate } =
    useWallet();

  const [step, setStep] = useState<Step>('backup');
  const [copied, setCopied] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const copyPhrase = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(words.join(' '));
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the phrase is still visible on screen,
      // so a copy failure is non-fatal and intentionally not surfaced loudly.
      setCopied(false);
    }
  }, [words]);

  const submitPassword = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);

      if (password.length === 0) {
        setError('Enter a password.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }

      setSaving(true);
      const result = await saveWallet(password);
      setSaving(false);

      if (result.ok) {
        onComplete();
        return;
      }
      setError(REASON_COPY[result.reason]);
    },
    [password, confirmPassword, saveWallet, onComplete],
  );

  if (step === 'password') {
    return (
      <form className={styles.flow} onSubmit={submitPassword}>
        <h1 className={styles.heading}>Set a password</h1>
        <p className={styles.subheading}>
          This password encrypts your wallet on this device.
        </p>

        <PasswordInput
          id="create-password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
        />

        <PasswordInput
          id="create-confirm-password"
          label="Confirm password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          autoComplete="new-password"
        />

        {error !== null && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <button
          className={styles.primary}
          type="submit"
          disabled={saving}
        >
          {saving ? 'Creating…' : 'Create wallet'}
        </button>
      </form>
    );
  }

  return (
    <div className={styles.flow}>
      <h1 className={styles.heading}>Back up your recovery phrase</h1>
      <p className={styles.subheading}>
        Write down these 24 words in order and keep them somewhere safe. They
        are the only way to restore your wallet.
      </p>

      <ol className={styles.grid} data-testid="phrase-grid">
        {words.map((word, index) => (
          <li
            key={`${index}-${word}`}
            className={styles.cell}
            data-testid="phrase-word"
          >
            <span className={styles.cellIndex}>{index + 1}</span>
            <span className={styles.cellWord}>{word}</span>
          </li>
        ))}
      </ol>

      <div className={styles.actionRow}>
        <button
          className={styles.secondary}
          type="button"
          onClick={copyPhrase}
        >
          {copied ? 'Copied' : 'Copy phrase'}
        </button>

        <button
          className={styles.secondary}
          type="button"
          onClick={() => {
            setCopied(false);
            void startCreate();
          }}
        >
          Generate new phrase
        </button>
      </div>

      <label className={styles.confirm}>
        <input
          type="checkbox"
          checked={hasConfirmedBackup}
          onChange={(e) => setHasConfirmedBackup(e.target.checked)}
        />
        <span>I have saved my recovery phrase somewhere safe.</span>
      </label>

      <button
        className={styles.primary}
        type="button"
        disabled={!hasConfirmedBackup}
        onClick={() => setStep('password')}
      >
        I&rsquo;ve saved my phrase
      </button>
    </div>
  );
}
