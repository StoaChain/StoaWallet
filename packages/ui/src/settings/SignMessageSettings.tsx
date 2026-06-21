import { getForwardSearchPref } from '@stoawallet/core';
import { useState, type ReactNode } from 'react';

import { useWallet } from '../context/WalletContext';
import styles from './SignMessageSettings.module.css';

/**
 * "Sign a message" tool (Settings). Signs an arbitrary text challenge with the
 * key for the address the message is bound to and shows the hex signature to
 * copy out — e.g. to prove control of a Stoa payout address to an external
 * mining pool. The signature is `Ed25519(blake2b256(message))`, the format such
 * pools verify. The private key never leaves the background service worker.
 *
 * It uses keys the wallet HOLDS by default. If the wallet-wide "Forward key
 * search" setting is on (the separate advanced card), it also probes derivation
 * indices to find an address a seed controls but hasn't added — showing a
 * determinate progress bar while the (potentially slow) scan runs.
 */
export function SignMessageSettings(): ReactNode {
  const { signMessage, storage } = useWallet();
  const [message, setMessage] = useState('');
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [progress, setProgress] = useState<{ scanned: number; total: number } | null>(null);

  async function onSign(): Promise<void> {
    setBusy(true);
    setError(null);
    setSignature(null);
    setProgress(null);
    try {
      // Honor the wallet-wide forward-search preference: depth when enabled, else
      // 0 (no scan → keys the wallet holds only).
      const pref = await getForwardSearchPref(storage);
      const scanDepth = pref.enabled ? pref.depth : 0;
      const res = await signMessage(message, {
        scanDepth,
        onProgress: (scanned, total) => setProgress({ scanned, total }),
      });
      if (res.ok) {
        setSignature(res.signature);
      } else if (res.reason === 'locked') {
        setError('Unlock your wallet first, then sign.');
      } else if (res.reason === 'no-wallet') {
        setError(
          pref.enabled
            ? 'No key found in this wallet to sign this message — no seed controls the address ' +
                'it’s bound to within the search depth. Increase the depth (Forward key search ' +
                'settings), import the account, or sign from a wallet that has it.'
            : 'No key found in this wallet to sign this message — it doesn’t hold the key for the ' +
                'address it’s bound to. Add/import that account, or enable Forward key search ' +
                '(advanced settings) to probe un-added positions.',
        );
      } else {
        setError('Could not sign this message.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Signing failed.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function onCopy(): Promise<void> {
    if (signature === null) return;
    try {
      await navigator.clipboard.writeText(signature);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the signature box is selectable as a fallback */
    }
  }

  const pct =
    progress !== null && progress.total > 0
      ? Math.min(100, Math.round((progress.scanned / progress.total) * 100))
      : 0;

  return (
    <section className={styles.section} data-testid="sign-message-settings">
      <h3 className={styles.heading}>Sign a message</h3>
      <p className={styles.help}>
        Sign a text challenge with the key for the address in the message — e.g. to prove you
        control a payout address for a mining pool. Paste the message, sign, then copy the
        signature back.
      </p>

      <textarea
        data-testid="sign-message-input"
        className={styles.textarea}
        placeholder="Paste the message to sign…"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={5}
      />
      <button
        type="button"
        data-testid="sign-message-button"
        className={styles.button}
        disabled={busy || message.trim() === ''}
        onClick={() => void onSign()}
      >
        {busy ? 'Signing…' : 'Sign message'}
      </button>

      {busy && progress !== null && (
        <div className={styles.progress} data-testid="sign-message-progress">
          <div className={styles.progressHead}>
            <span>Searching accounts…</span>
            <span>
              {progress.scanned}/{progress.total}
            </span>
          </div>
          <div className={styles.bar}>
            <div className={styles.barFill} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {error !== null && <p className={styles.error}>{error}</p>}
      {signature !== null && (
        <div className={styles.result}>
          <div className={styles.resultHead}>
            <span className={styles.label}>Signature (hex)</span>
            <button type="button" className={styles.copy} onClick={() => void onCopy()}>
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
          <textarea
            data-testid="sign-message-output"
            className={styles.sigBox}
            readOnly
            value={signature}
            rows={3}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}
    </section>
  );
}
