import { useState, type FormEvent } from 'react';

import {
  useWallet,
  type WalletActionReason,
} from '../context/WalletContext';
import styles from './ImportWalletFlow.module.css';

/**
 * The import-wallet onboarding flow. A user pastes or types an existing 24-word
 * recovery phrase, audits the parsed words as numbered chips, then chooses a
 * password to seal the wallet under. This flow targets the 24-word koala phrase
 * only — the legacy 12-word and "ouro" variants are dropped.
 *
 * SECURITY DISCIPLINE: the in-progress phrase lives only in this component's
 * local state and is never logged, lifted to a global store, or persisted in
 * plaintext. Validation and sealing are delegated to the context's
 * `importWallet`, whose discriminated result drives the error messaging.
 */

const REQUIRED_WORD_COUNT = 24;

/** The two distinct, user-facing rejection messages. */
const WORD_COUNT_MESSAGE = 'A 24-word seed phrase is required.';
const INVALID_WORDS_MESSAGE = 'Invalid seed phrase. Please check your words.';

/**
 * Map a context rejection reason to its user-facing message. `word-count` and
 * `invalid-words` get the two distinct strings the recovery flow promises; any
 * other reason (e.g. an unexpected vault error) falls back to the generic
 * invalid-phrase message rather than leaking an internal taxonomy term.
 */
function messageForReason(reason: WalletActionReason): string {
  return reason === 'word-count' ? WORD_COUNT_MESSAGE : INVALID_WORDS_MESSAGE;
}

/** Split a pasted/typed phrase into words on any run of whitespace. */
function splitWords(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

export interface ImportWalletFlowProps {
  /** Called once the phrase is validated and the wallet is sealed. */
  onImported?(): void;
}

type Step = 'phrase' | 'password';

export function ImportWalletFlow({
  onImported,
}: ImportWalletFlowProps): React.ReactElement {
  const { importWallet } = useWallet();

  const [step, setStep] = useState<Step>('phrase');
  const [raw, setRaw] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const words = splitWords(raw);
  const hasRequiredCount = words.length === REQUIRED_WORD_COUNT;

  const removeWord = (index: number) => {
    const next = words.filter((_, i) => i !== index);
    setRaw(next.join(' '));
    setError(null);
  };

  const submitPhrase = (event: FormEvent) => {
    event.preventDefault();
    // Word-count is the one rejection knowable without the password, so guard it
    // here to keep a wrong-count phrase from ever reaching the password step.
    if (!hasRequiredCount) {
      setError(WORD_COUNT_MESSAGE);
      return;
    }
    setError(null);
    setStep('password');
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await importWallet(words, password);
    setSubmitting(false);
    if (result.ok) {
      onImported?.();
      return;
    }
    setError(messageForReason(result.reason));
  };

  return (
    <div className={styles.flow}>
      {step === 'phrase' ? (
        <form
          className={styles.panel}
          data-testid="phrase-form"
          onSubmit={submitPhrase}
        >
          <h2 className={styles.heading}>Import a wallet</h2>
          <p className={styles.hint}>
            Paste or type your 24-word recovery phrase. Words are detected
            automatically and shown below.
          </p>

          <div className={styles.chips} aria-label="Detected seed words">
            {words.length === 0 ? (
              <span className={styles.placeholder}>
                Your seed words will appear here.
              </span>
            ) : (
              words.map((word, index) => (
                <button
                  type="button"
                  key={`${index}-${word}`}
                  data-testid="seed-word-chip"
                  className={styles.chip}
                  onClick={() => removeWord(index)}
                  aria-label={`Remove word ${index + 1}: ${word}`}
                >
                  <span className={styles.chipIndex}>{index + 1}</span>
                  <span className={styles.chipWord}>{word}</span>
                  <span aria-hidden="true" className={styles.chipRemove}>
                    &times;
                  </span>
                </button>
              ))
            )}
          </div>

          <label className={styles.label} htmlFor="import-phrase">
            Seed phrase
          </label>
          <textarea
            id="import-phrase"
            className={styles.textarea}
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setError(null);
            }}
            placeholder="Paste or type your seed phrase here"
            rows={3}
            spellCheck={false}
            autoComplete="off"
          />

          <p className={styles.counter}>
            {words.length} / {REQUIRED_WORD_COUNT} words
          </p>

          {error !== null && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            className={styles.primary}
            disabled={!hasRequiredCount}
          >
            Continue
          </button>
        </form>
      ) : (
        <form
          className={styles.panel}
          data-testid="password-form"
          onSubmit={submitPassword}
        >
          <h2 className={styles.heading}>Set a password</h2>
          <p className={styles.hint}>
            This password encrypts your wallet on this device. You will need it
            to unlock.
          </p>

          <label className={styles.label} htmlFor="import-password">
            Password
          </label>
          <input
            id="import-password"
            className={styles.input}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            autoComplete="new-password"
          />

          {error !== null && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setStep('phrase');
                setError(null);
              }}
              disabled={submitting}
            >
              Back
            </button>
            <button
              type="submit"
              className={styles.primary}
              disabled={submitting || password.length === 0}
            >
              Import wallet
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
