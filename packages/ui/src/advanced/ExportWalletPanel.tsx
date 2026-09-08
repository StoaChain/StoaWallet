import { useCallback, useState, type ReactNode } from 'react';

import { useWallet } from '../context/WalletContext';
import { PasswordInput } from '../components/PasswordInput';
import styles from './AdvancedTab.module.css';

/**
 * Filename for the backup, matching the Ouronet Codex convention exactly:
 * `OuronetCodex_<ISO with : and . replaced by ->.json` becomes
 * `StoaWallet_<same>.json`. Keeping the timestamp shape identical means the two
 * families of files sort and group together in a download folder, and the
 * seconds+millis component makes successive exports collide-free (a date-only
 * name would silently overwrite an earlier backup the same day).
 */
export function exportFileName(now: Date): string {
  return `StoaWallet_${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

/**
 * Hand the user a file. Uses a Blob + a synthetic `<a download>` click, which
 * needs no `downloads` manifest permission — keeping the extension's permission
 * set (and therefore its store-review surface) unchanged.
 */
function downloadJson(json: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * BACK UP the wallet as an Ouronet Codex file.
 *
 * The wallet lives in `chrome.storage.local`; clearing browser data or removing
 * the extension wipes it. This is the preservation path — and it emits the same
 * Codex format the wallet imports, so restoring is the existing "Import Codex"
 * flow rather than a second, less-tested code path.
 *
 * TWO passwords, deliberately distinct: the export password seals the FILE
 * (which leaves the device and ends up in backups and cloud drives), while the
 * wallet password stays the daily unlock secret. Reusing the latter would spread
 * it wherever the file goes.
 */
export function ExportWalletPanel(): ReactNode {
  const { exportCodex } = useWallet();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<readonly [number, number] | null>(null);

  const passwordsMatch = password.length > 0 && password === confirmPassword;

  const onExport = useCallback(async (): Promise<void> => {
    if (!passwordsMatch || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setProgress([0, 0]);
    try {
      const result = await exportCodex(password, (done, total) =>
        setProgress([done, total]),
      );
      if (!result.ok) {
        setError(
          result.reason === 'locked'
            ? 'Unlock the wallet before exporting.'
            : 'Could not export the wallet.',
        );
        return;
      }
      const name = exportFileName(new Date());
      downloadJson(result.json, name);
      setNotice(`Exported to ${name}. Keep it somewhere safe.`);
      // The export password is a file secret, not session state — drop it.
      setPassword('');
      setConfirmPassword('');
    } catch {
      setError('Could not export the wallet.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [busy, exportCodex, password, passwordsMatch]);

  return (
    <div className={styles.importPanel} data-testid="export-wallet-panel">
      <h3 className={styles.importHeading}>Back up wallet</h3>
      <p className={styles.importHelp}>
        Saves every seed and key as a Codex file you can import again later. The
        wallet lives in browser storage — clearing browser data erases it, and
        this file is how you get it back.
      </p>

      <PasswordInput
        id="export-password"
        label="Export password"
        value={password}
        onChange={(next) => {
          setPassword(next);
          setError(null);
        }}
        autoComplete="new-password"
      />
      <PasswordInput
        id="export-confirm-password"
        label="Confirm export password"
        value={confirmPassword}
        onChange={(next) => {
          setConfirmPassword(next);
          setError(null);
        }}
        autoComplete="new-password"
      />
      <p className={styles.importHelp}>
        This password protects the file itself. Choose a different one from your
        wallet password — and remember it, because the file cannot be opened
        without it.
      </p>

      {error !== null && (
        <p className={styles.importError} role="alert" data-testid="export-error">
          {error}
        </p>
      )}
      {notice !== null && (
        <p className={styles.importHelp} role="status" data-testid="export-notice">
          {notice}
        </p>
      )}

      {progress !== null && (
        <div
          className={styles.codexProgress}
          data-testid="export-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress[1]}
          aria-valuenow={progress[0]}
          aria-label="Exporting wallet"
        >
          <div className={styles.codexProgressTrack}>
            <div
              className={styles.codexProgressFill}
              style={{
                width: `${progress[1] > 0 ? Math.round((progress[0] / progress[1]) * 100) : 0}%`,
              }}
            />
          </div>
          <span data-testid="export-progress-label">
            {progress[1] > 0
              ? `Sealing ${progress[0]} of ${progress[1]}…`
              : 'Preparing…'}
          </span>
        </div>
      )}

      <button
        type="button"
        className={styles.importButton}
        data-testid="export-submit"
        disabled={busy || !passwordsMatch}
        onClick={() => void onExport()}
      >
        {busy ? 'Exporting…' : 'Export wallet'}
      </button>
    </div>
  );
}
