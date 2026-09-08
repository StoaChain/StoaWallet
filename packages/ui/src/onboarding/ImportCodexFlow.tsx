import {
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import { useWallet } from '../context/WalletContext';
import { PasswordInput } from '../components/PasswordInput';
import styles from './ImportWalletFlow.module.css';

/** The two steps: prove the codex opens, then choose the wallet password. */
type Step = 'codex' | 'password';

/**
 * User-facing copy for every secret-free failure reason the codex importer can
 * return. Keyed by reason so a new reason surfaces as a real message rather
 * than a silent no-op.
 */
const REASON_COPY: Record<string, string> = {
  'invalid-json': 'That file is not a readable Codex export.',
  'unsupported-version': 'That Codex version is not supported by this wallet.',
  'wrong-codex-password': 'Wrong Codex password.',
  'no-importable-content': 'That Codex contains no seeds this wallet can import.',
  unknown: 'Could not import that Codex.',
};

/**
 * Read a picked file as text — `File.text()` where available, else `FileReader`
 * (so it works in browsers AND the jsdom test environment).
 */
function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * FIRST-RUN onboarding from an Ouronet Codex export.
 *
 * Why two passwords: the codex file is sealed at the CODEX password, and the
 * wallet re-seals every seed it takes out at the WALLET password chosen here.
 * The codex password is used once, in memory, and is never stored.
 *
 * The codex file + password are collected FIRST so a wrong codex password is
 * reported before the user invents a wallet password. Nothing is written to
 * storage unless the whole import succeeds.
 */
export function ImportCodexFlow(): ReactNode {
  const { onboardFromCodex } = useWallet();

  const [step, setStep] = useState<Step>('codex');
  const [json, setJson] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [codexPassword, setCodexPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Determinate import progress: [done, total] items, or null before it starts.
  const [progress, setProgress] = useState<readonly [number, number] | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const passwordsMatch = password.length > 0 && password === confirmPassword;
  const codexReady = json !== null && codexPassword.length > 0;

  const onPickFile = useCallback(async (file: File | undefined): Promise<void> => {
    setError(null);
    if (file === undefined) {
      setJson(null);
      setFileName(null);
      return;
    }
    setFileName(file.name);
    setJson(await readFileText(file));
  }, []);

  const submit = useCallback(
    async (event: FormEvent): Promise<void> => {
      event.preventDefault();
      if (json === null || !passwordsMatch || submitting) return;

      setSubmitting(true);
      setError(null);
      setProgress([0, 0]);
      try {
        const result = await onboardFromCodex(
          json,
          codexPassword,
          password,
          (done, total) => setProgress([done, total]),
        );
        if (!result.ok) {
          setProgress(null);
          setError(REASON_COPY[result.reason] ?? REASON_COPY.unknown);
          // Every failure here belongs to the codex file or its password, not to
          // the wallet password — send the user back to the step that owns it.
          setStep('codex');
        }
        // On success the provider flips `hasExistingWallet`, so the shell swaps
        // this flow out for the unlocked wallet — nothing to do here.
      } catch {
        setProgress(null);
        setError(REASON_COPY.unknown);
        setStep('codex');
      } finally {
        setSubmitting(false);
      }
    },
    [codexPassword, json, onboardFromCodex, password, passwordsMatch, submitting],
  );

  return (
    <div className={styles.flow} data-testid="import-codex-flow">
      {step === 'codex' ? (
        <div className={styles.panel}>
          <h2 className={styles.heading}>Import a Codex</h2>
          <p className={styles.hint}>
            Select your Ouronet Codex export and enter the password that
            protects it. Every seed and account it holds is imported.
          </p>

          {/* The native control stays in the DOM — it owns the file dialog and
              the change event — but is visually hidden behind an in-app button. */}
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            data-testid="onboard-codex-file"
            aria-label="Codex file"
            className={styles.fileHidden}
            onChange={(e) => void onPickFile(e.target.files?.[0])}
          />
          <button
            type="button"
            className={styles.filePicker}
            data-testid="onboard-codex-choose"
            onClick={() => fileRef.current?.click()}
          >
            {fileName === null ? 'Choose Codex file' : 'Choose a different file'}
          </button>
          {fileName !== null && (
            <p className={styles.fileChosen} data-testid="onboard-codex-filename">
              {fileName}
            </p>
          )}

          <PasswordInput
            id="onboard-codex-password"
            label="Codex password"
            value={codexPassword}
            onChange={(next) => {
              setCodexPassword(next);
              setError(null);
            }}
            autoComplete="off"
          />

          {error !== null && (
            <p
              className={styles.error}
              role="alert"
              data-testid="onboard-codex-error"
            >
              {error}
            </p>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              data-testid="onboard-codex-continue"
              disabled={!codexReady}
              onClick={() => {
                setStep('password');
                setError(null);
              }}
            >
              Continue
            </button>
          </div>
        </div>
      ) : (
        <form
          className={styles.panel}
          data-testid="password-form"
          onSubmit={submit}
        >
          <h2 className={styles.heading}>Set a password</h2>
          <p className={styles.hint}>
            This password encrypts the imported wallet on this device. It is
            separate from your Codex password.
          </p>

          <PasswordInput
            id="onboard-codex-wallet-password"
            label="Password"
            value={password}
            onChange={(next) => {
              setPassword(next);
              setError(null);
            }}
            autoComplete="new-password"
          />

          <PasswordInput
            id="onboard-codex-confirm-password"
            label="Confirm password"
            value={confirmPassword}
            onChange={(next) => {
              setConfirmPassword(next);
              setError(null);
            }}
            autoComplete="new-password"
          />

          {error !== null && (
            <p
              className={styles.error}
              role="alert"
              data-testid="onboard-codex-error"
            >
              {error}
            </p>
          )}

          {progress !== null && (
            <ImportProgress done={progress[0]} total={progress[1]} />
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setStep('codex');
                setError(null);
              }}
              disabled={submitting}
            >
              Back
            </button>
            <button
              type="submit"
              className={styles.primary}
              data-testid="onboard-codex-submit"
              disabled={submitting || !passwordsMatch}
            >
              {submitting ? 'Importing…' : 'Import Codex'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * A DETERMINATE import bar.
 *
 * Each seed and pure key costs two password-KDF rounds (decrypt at the codex
 * password, re-seal at the wallet password), so a multi-seed codex visibly
 * pauses. Showing real counts tells the user their codex password was accepted
 * and the wallet is working, instead of a static label that reads as a hang.
 *
 * `total` is 0 only in the instant between submitting and the first tick; the
 * percentage guards against dividing by it.
 */
function ImportProgress({
  done,
  total,
}: {
  readonly done: number;
  readonly total: number;
}): ReactNode {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div
      className={styles.progress}
      data-testid="codex-import-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label="Importing Codex"
    >
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${pct}%` }} />
      </div>
      <p className={styles.hint} data-testid="codex-import-progress-label">
        {total > 0 ? `Importing ${done} of ${total}…` : 'Opening Codex…'}
      </p>
    </div>
  );
}
