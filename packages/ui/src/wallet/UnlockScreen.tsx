import {
  type BiometricUnlock,
  UnsupportedBiometricUnlock,
} from '@stoawallet/core';
import { useEffect, useState, type ReactNode } from 'react';

import { BrandSplash } from '../components/BrandSplash';
import { PasswordInput } from '../components/PasswordInput';
import {
  useWallet,
  type WalletActionReason,
} from '../context/WalletContext';
import styles from './UnlockScreen.module.css';

/**
 * Distinct, user-actionable copy for each failure class. A wrong password is a
 * fixable typo; a corrupt/unreadable vault is a storage-integrity problem the
 * user CANNOT fix by retyping. Collapsing them into one generic "unlock failed"
 * (the anti-pattern this replaces) leaves the user retyping a password against a
 * vault that can never decrypt.
 */
const WRONG_PASSWORD_MESSAGE = 'Wrong password';
const CORRUPT_MESSAGE = 'Stored wallet is corrupted / unreadable';

function messageForReason(reason: WalletActionReason): string {
  switch (reason) {
    case 'wrong-password':
      return WRONG_PASSWORD_MESSAGE;
    case 'corrupt-envelope':
    case 'unsupported-format':
    case 'corrupt-vault':
      return CORRUPT_MESSAGE;
    case 'no-wallet':
      return 'No wallet found to unlock';
    default:
      return 'Unable to unlock';
  }
}

export interface UnlockScreenProps {
  /**
   * Platform biometric authenticator. Defaults to the web/extension
   * `UnsupportedBiometricUnlock`, whose `isAvailable()` resolves false — so the
   * biometric affordance is hidden unless a capable backer is injected. The
   * context does not yet surface biometrics, so this prop is the injection seam.
   */
  readonly biometric?: BiometricUnlock;
  /**
   * When true, frame the unlock as a RESUME after the background session expired
   * (MV3 service-worker terminated, or the idle auto-lock fired) rather than a
   * first-open lock. The SAME unlock flow runs — only the heading + an explanatory
   * line change — so there is no second unlock implementation. The password is
   * still obtained fresh from the user and never stored.
   */
  readonly sessionExpired?: boolean;
}

function FingerprintIcon(): ReactNode {
  // Inline so the package adds no icon dependency; decorative, hidden from AT
  // (the button's accessible name carries the meaning).
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 10v4" />
      <path d="M8 7a5 5 0 0 1 8 0" />
      <path d="M5 11a9 9 0 0 1 14 0" />
      <path d="M8 15a4 4 0 0 0 8 0" />
    </svg>
  );
}

export function UnlockScreen({
  biometric = new UnsupportedBiometricUnlock(),
  sessionExpired = false,
}: UnlockScreenProps): ReactNode {
  const { unlock } = useWallet();
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);

  // Probe the platform once: only a true result reveals the biometric option.
  // The probe is contracted never to reject, but guard anyway so a misbehaving
  // backer cannot break the unlock screen.
  useEffect(() => {
    let alive = true;
    biometric
      .isAvailable()
      .then((ok) => {
        if (alive) setBiometricAvailable(ok);
      })
      .catch(() => {
        if (alive) setBiometricAvailable(false);
      });
    return () => {
      alive = false;
    };
  }, [biometric]);

  async function runUnlock(result: Awaited<ReturnType<typeof unlock>>) {
    if (result.ok) {
      setErrorMessage(null);
      return;
    }
    setErrorMessage(messageForReason(result.reason));
  }

  async function handlePasswordUnlock() {
    setBusy(true);
    try {
      runUnlock(await unlock(password));
    } finally {
      setBusy(false);
    }
  }

  async function handleBiometricUnlock() {
    setBusy(true);
    try {
      const result = await biometric.unlock();
      // The biometric contract resolves a discriminated result (it never
      // throws). On a non-ok outcome (unavailable / cancelled / failed) we fall
      // back to password entry WITHOUT claiming a password error — a different
      // cause, so no message swap. Only an ok result feeds the same unlock path.
      if (result.ok) {
        runUnlock(await unlock(result.secret));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <BrandSplash>
      <div className={styles.screen}>
        <h1 className={styles.title}>Unlock wallet</h1>

        {sessionExpired && (
          <p className={styles.notice} role="status">
            Session expired — please unlock again.
          </p>
        )}

        {/* The field + Unlock button live in a form so pressing Enter in the
            password field submits — a type="button" click handler would not fire
            on Enter. The PasswordInput's own reveal toggle stays type="button" so
            it never submits this form. */}
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void handlePasswordUnlock();
          }}
        >
          <div className={styles.field}>
            <PasswordInput
              id="unlock-password"
              label="Password"
              autoComplete="current-password"
              value={password}
              onChange={setPassword}
            />
          </div>

          {errorMessage !== null && (
            <p className={styles.error} role="alert">
              {errorMessage}
            </p>
          )}

          <button
            type="submit"
            className={styles.primary}
            disabled={busy}
          >
            Unlock
          </button>
        </form>

        {biometricAvailable && (
          <button
            type="button"
            className={styles.biometric}
            disabled={busy}
            onClick={() => void handleBiometricUnlock()}
            aria-label="Unlock with biometric"
          >
            <FingerprintIcon />
            Use biometric
          </button>
        )}
      </div>
    </BrandSplash>
  );
}
