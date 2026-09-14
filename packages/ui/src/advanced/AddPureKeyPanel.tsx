import { useMemo, useState, type ReactNode } from 'react';
import {
  generatePureKeypair,
  isPastedKeyFormat,
  validatePastedKey,
  type GeneratedPureKeypair,
} from '@stoawallet/core';
import { tryDerivePublicKey } from '@stoachain/stoa-core/guard';

import { useWallet } from '../context/WalletContext';
import styles from './AdvancedTab.module.css';

type Mode = 'generate' | 'import';

/** User-facing copy for the vault's secret-free refusal codes. */
const REASON_COPY: Readonly<Record<string, string>> = {
  'duplicate-key': 'That key is already in this wallet.',
  'key-mismatch': 'The private key does not derive that public key.',
  'bad-format': 'That private key is not in a recognised format.',
  'invalid-key': 'Could not derive a public key from this private key.',
  locked: 'Unlock the wallet to add the keypair.',
};

const HEX64 = /^[0-9a-f]{64}$/;

interface PairValidation {
  readonly state: 'idle' | 'ok' | 'err';
  readonly msg: string;
}

/**
 * Live validation of a pasted pair — Codex's ImportSubtab checks, in the same
 * order and with the same wording. Inputs arrive trimmed and lowercased.
 */
function validatePair(publicKey: string, privateKey: string): PairValidation {
  if (publicKey === '' && privateKey === '') return { state: 'idle', msg: '' };
  if (privateKey !== '' && !isPastedKeyFormat(privateKey)) {
    return {
      state: 'err',
      msg: 'Private key must be 64 hex (Ed25519) or 128 (Chainweaver extended key).',
    };
  }
  if (publicKey !== '' && !HEX64.test(publicKey)) {
    return { state: 'err', msg: 'Public key must be 64 hex characters.' };
  }
  if (!HEX64.test(publicKey) || !isPastedKeyFormat(privateKey)) {
    return { state: 'idle', msg: 'Enter both keys to validate.' };
  }
  const result = validatePastedKey(privateKey, [publicKey]);
  if (result.ok) {
    return { state: 'ok', msg: 'Keys match — the public key derives from this private key. ✓' };
  }
  if (result.reason === 'invalid-key') {
    return { state: 'err', msg: 'Could not derive a public key from this private key.' };
  }
  const derived = tryDerivePublicKey(privateKey) ?? '';
  return {
    state: 'err',
    msg: `Mismatch — this private key derives a different public key (${derived.slice(0, 16)}…).`,
  };
}

export interface AddPureKeyPanelProps {
  /** Called with the stored key's public key once it has been added. */
  readonly onDone: (publicKey: string) => void;
}

/**
 * ADD A PURE KEY — ported from Ouronet Codex's PureKeypairsTab.
 *
 * Generate: a fresh Ed25519 keypair (the standard `pact -g`), shown in full so
 * the private key can be saved outside the wallet before it is stored.
 * Import: paste both halves; the private key (64-hex, or the 128-hex Chainweaver
 * extended key) must derive the public key, so a mistyped pair cannot be saved.
 */
export function AddPureKeyPanel({ onDone }: AddPureKeyPanelProps): ReactNode {
  const { addPureKeypair } = useWallet();

  const [mode, setMode] = useState<Mode>('generate');
  const [pair, setPair] = useState<GeneratedPureKeypair | null>(null);
  const [label, setLabel] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const publicT = publicKey.trim().toLowerCase();
  const privateT = privateKey.trim().toLowerCase();
  const validation = useMemo(() => validatePair(publicT, privateT), [publicT, privateT]);

  async function save(privateHex: string, publicHex: string): Promise<void> {
    setSaving(true);
    setError(null);
    const trimmedLabel = label.trim();
    try {
      const result = await addPureKeypair({
        privateKey: privateHex,
        publicKey: publicHex,
        ...(trimmedLabel === '' ? {} : { label: trimmedLabel }),
      });
      if (result.ok) {
        setPair(null);
        setPublicKey('');
        setPrivateKey('');
        setLabel('');
        onDone(result.publicKey);
        return;
      }
      setError(REASON_COPY[result.reason] ?? 'Failed to add keypair.');
    } catch {
      setError('Failed to add keypair.');
    } finally {
      setSaving(false);
    }
  }

  const labelField = (
    <>
      <label className={styles.addFieldLabel} htmlFor="pure-key-label">
        Label (optional)
      </label>
      <input
        id="pure-key-label"
        className={styles.addTextInput}
        data-testid="pure-key-label"
        maxLength={64}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
    </>
  );

  return (
    <div className={styles.addPanel} data-testid="add-pure-key-panel">
      <h3 className={styles.addHeading}>Add pure key</h3>

      <div className={styles.addSegmented} role="tablist" aria-label="Add pure key mode">
        {(['generate', 'import'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            data-testid={`pure-key-mode-${m}`}
            className={`${styles.addSegment} ${mode === m ? styles.addSegmentActive : ''}`}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
          >
            {m === 'generate' ? 'Generate' : 'Import'}
          </button>
        ))}
      </div>

      {mode === 'generate' ? (
        <>
          <p className={styles.importHelp}>
            Generate a fresh ed25519 keypair (the standard <code>pact -g</code>).
          </p>
          <div className={styles.addActions}>
            <button
              type="button"
              className={styles.addSecondary}
              data-testid="pure-key-generate"
              onClick={() => {
                setError(null);
                setPair(generatePureKeypair());
              }}
            >
              {pair === null ? 'Generate keypair' : 'Generate another'}
            </button>
          </div>

          {pair !== null && (
            <>
              <span className={styles.addFieldLabel}>Public key</span>
              <code className={styles.addKeyValue} data-testid="pure-key-generated-public">
                {pair.publicKey}
              </code>
              <span className={styles.addFieldLabel}>Private key</span>
              <code className={styles.addKeyValue} data-testid="pure-key-generated-private">
                {pair.privateKey}
              </code>
              <p className={styles.addWarning}>Save this private key now.</p>
              {labelField}
              {error !== null && (
                <p className={styles.importError} role="alert" data-testid="pure-key-error">
                  {error}
                </p>
              )}
              <div className={styles.addActions}>
                <button
                  type="button"
                  className={styles.addPrimary}
                  data-testid="pure-key-save"
                  disabled={saving}
                  onClick={() => void save(pair.privateKey, pair.publicKey)}
                >
                  {saving ? 'Saving…' : 'Save key'}
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <label className={styles.addFieldLabel} htmlFor="pure-key-import-public">
            Public key (64 hex)
          </label>
          <input
            id="pure-key-import-public"
            className={styles.addTextInput}
            data-testid="pure-key-import-public"
            spellCheck={false}
            autoComplete="off"
            value={publicKey}
            onChange={(e) => {
              setError(null);
              setPublicKey(e.target.value);
            }}
          />
          <label className={styles.addFieldLabel} htmlFor="pure-key-import-private">
            Private key (64 or 128 hex)
          </label>
          <input
            id="pure-key-import-private"
            className={styles.addTextInput}
            data-testid="pure-key-import-private"
            spellCheck={false}
            autoComplete="off"
            value={privateKey}
            onChange={(e) => {
              setError(null);
              setPrivateKey(e.target.value);
            }}
          />
          <p
            data-testid="pure-key-import-status"
            className={
              validation.state === 'ok'
                ? styles.addStatusOk
                : validation.state === 'err'
                  ? styles.addStatusErr
                  : styles.importHelp
            }
          >
            {validation.msg}
          </p>
          {labelField}
          {error !== null && (
            <p className={styles.importError} role="alert" data-testid="pure-key-error">
              {error}
            </p>
          )}
          <div className={styles.addActions}>
            <button
              type="button"
              className={styles.addPrimary}
              data-testid="pure-key-import-submit"
              disabled={validation.state !== 'ok' || saving}
              onClick={() => void save(privateT, publicT)}
            >
              {saving ? 'Adding…' : 'Add key'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
