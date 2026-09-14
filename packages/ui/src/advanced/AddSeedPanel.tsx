import { useEffect, useState, type ReactNode } from 'react';
import { generateMnemonicFor, previewSeedPublicKey } from '@stoawallet/core';

import { seedTypeChipStyle } from '../app/seedTypeConfig';
import { useWallet, type AddableSeedType } from '../context/WalletContext';
import styles from './AdvancedTab.module.css';

type Mode = 'generate' | 'restore';

interface SeedTypeOption {
  readonly value: AddableSeedType;
  readonly label: string;
  readonly words: 12 | 24;
  readonly desc: string;
}

/** The seed types and their descriptions, ported verbatim from Ouronet Codex. */
const SEED_TYPE_OPTIONS: readonly SeedTypeOption[] = [
  {
    value: 'koala',
    label: 'Koala',
    words: 24,
    desc: '24-word BIP39 mnemonic (256-bit entropy). Standard Koala Wallet seed.',
  },
  {
    value: 'chainweaver',
    label: 'Chainweaver',
    words: 12,
    desc: '12-word Kadena Chainweaver mnemonic.',
  },
  {
    value: 'eckowallet',
    label: 'EckoWallet',
    words: 12,
    desc: '12-word mnemonic — same derivation as Chainweaver.',
  },
];

/** User-facing copy for the vault's secret-free refusal codes. */
const REASON_COPY: Readonly<Record<string, string>> = {
  'duplicate-seed': 'That seed is already in this wallet.',
  'invalid-words': 'Seed phrase is invalid for this seed type.',
  'missing-name': 'Please enter a name for this seed.',
  locked: 'Unlock the wallet to add a seed.',
};

/**
 * Restore-textarea gate: letters, digits and whitespace only. Whitespace is kept
 * (including newlines) so a phrase pasted one word per line still splits into
 * words — stripping newlines outright would glue adjacent words together.
 */
const DISALLOWED = /[^0-9A-Za-z\s]/g;

function wordsOf(phrase: string): string[] {
  return phrase.trim().split(/\s+/).filter(Boolean);
}

export interface AddSeedPanelProps {
  /** Called with the new seed's id once it has been added. */
  readonly onDone: (walletId: string) => void;
  readonly onCancel: () => void;
}

/**
 * ADD A SEED to the wallet — ported from Ouronet Codex's CreateKadenaSeedModal.
 *
 * Generate a new phrase or restore an existing one, for Koala (24 words),
 * Chainweaver or EckoWallet (12 words). A live Key #0 preview shows the address
 * the phrase produces before anything is saved; the seed needs a name; Key #0 and
 * Key #1 are derived on save; the active seed does not change.
 *
 * No password field: the vault seals the phrase with the unlocked session's
 * wallet password, where Codex asks for its codex password instead.
 */
export function AddSeedPanel({ onDone, onCancel }: AddSeedPanelProps): ReactNode {
  const { addSeed } = useWallet();

  const [mode, setMode] = useState<Mode>('generate');
  const [seedType, setSeedType] = useState<AddableSeedType>('koala');
  const [phrase, setPhrase] = useState('');
  const [name, setName] = useState('');
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  // Bumped by "Generate new phrase" to re-run generation for the same type.
  const [generation, setGeneration] = useState(0);

  const option = SEED_TYPE_OPTIONS.find((o) => o.value === seedType) ?? SEED_TYPE_OPTIONS[0];
  const words = wordsOf(phrase);

  // Generate on open and on every type/mode change; restore starts blank.
  useEffect(() => {
    setError(null);
    setPreviewKey(null);
    if (mode !== 'generate') {
      setPhrase('');
      return undefined;
    }
    let cancelled = false;
    void generateMnemonicFor(seedType).then((next) => {
      if (!cancelled) setPhrase(next);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, seedType, generation]);

  // Live Key #0 preview — only once the word count is right for the type.
  useEffect(() => {
    if (wordsOf(phrase).length !== option.words) {
      setPreviewKey(null);
      return undefined;
    }
    let cancelled = false;
    void previewSeedPublicKey(phrase, seedType).then((key) => {
      if (!cancelled) setPreviewKey(key);
    });
    return () => {
      cancelled = true;
    };
  }, [phrase, seedType, option.words]);

  const countHint =
    mode === 'restore' && words.length > 0 && words.length !== option.words
      ? `This seed type needs exactly ${option.words} words (have ${words.length}).`
      : null;
  const shownError = error ?? countHint;
  const canSubmit = previewKey !== null && name.trim() !== '' && !submitting;

  const copyPhrase = (): void => {
    void navigator.clipboard?.writeText(phrase).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await addSeed({
        phrase: words.join(' ').toLowerCase(),
        seedType,
        name: name.trim(),
      });
      if (result.ok) {
        onDone(result.walletId);
        return;
      }
      setError(REASON_COPY[result.reason] ?? 'Failed to add seed.');
    } catch {
      setError('Failed to add seed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.addPanel} data-testid="add-seed-panel">
      <h3 className={styles.addHeading}>Add seed</h3>

      <div className={styles.addSegmented} role="tablist" aria-label="Add seed mode">
        {(['generate', 'restore'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            data-testid={`add-seed-mode-${m}`}
            className={`${styles.addSegment} ${mode === m ? styles.addSegmentActive : ''}`}
            onClick={() => setMode(m)}
          >
            {m === 'generate' ? 'Generate New' : 'Restore Existing'}
          </button>
        ))}
      </div>

      <div className={styles.addSegmented} role="radiogroup" aria-label="Seed type">
        {SEED_TYPE_OPTIONS.map((o) => {
          const on = o.value === seedType;
          const accent = seedTypeChipStyle(o.value).color;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`add-seed-type-${o.value}`}
              className={`${styles.addSegment} ${on ? styles.addSegmentActive : ''}`}
              style={on ? { color: accent, borderColor: accent } : undefined}
              onClick={() => setSeedType(o.value)}
            >
              {o.label}
              <span className={styles.addSegmentSub}>{o.words} words</span>
            </button>
          );
        })}
      </div>
      <p className={styles.importHelp}>{option.desc}</p>

      {mode === 'generate' ? (
        <>
          <ol className={styles.addWordGrid} data-testid="add-seed-words">
            {words.map((word, i) => (
              <li key={`${i}-${word}`} className={styles.addWordCell}>
                {word}
              </li>
            ))}
          </ol>
          <p className={styles.addWarning}>
            ⚠ Write these words down. Anyone with them controls the keys.
          </p>
          <div className={styles.addActions}>
            <button
              type="button"
              className={styles.addSecondary}
              data-testid="add-seed-copy"
              disabled={words.length === 0}
              onClick={copyPhrase}
            >
              {copied ? 'Copied' : 'Copy phrase'}
            </button>
            <button
              type="button"
              className={styles.addSecondary}
              data-testid="add-seed-regenerate"
              onClick={() => setGeneration((n) => n + 1)}
            >
              Generate new phrase
            </button>
          </div>
        </>
      ) : (
        <textarea
          className={styles.addPhraseInput}
          data-testid="add-seed-phrase"
          aria-label="Seed phrase"
          rows={4}
          spellCheck={false}
          autoComplete="off"
          placeholder={`Enter your ${option.words}-word seed phrase…`}
          value={phrase}
          onChange={(e) => {
            setError(null);
            setPhrase(e.target.value.replace(DISALLOWED, ''));
          }}
        />
      )}

      <span className={styles.addFieldLabel}>Key #0 preview</span>
      <p className={styles.addPreviewKey} data-testid="add-seed-preview">
        {previewKey !== null ? `k:${previewKey}` : '—'}
      </p>

      <label className={styles.addFieldLabel} htmlFor="add-seed-name">
        Seed name
      </label>
      <input
        id="add-seed-name"
        className={styles.addTextInput}
        data-testid="add-seed-name"
        maxLength={64}
        value={name}
        onChange={(e) => {
          setError(null);
          setName(e.target.value);
        }}
      />

      {shownError !== null && (
        <p className={styles.importError} role="alert" data-testid="add-seed-error">
          {shownError}
        </p>
      )}

      <div className={styles.addActions}>
        <button
          type="button"
          className={styles.addSecondary}
          data-testid="add-seed-cancel"
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.addPrimary}
          data-testid="add-seed-submit"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {submitting ? 'Adding…' : 'Add seed'}
        </button>
      </div>
    </div>
  );
}
