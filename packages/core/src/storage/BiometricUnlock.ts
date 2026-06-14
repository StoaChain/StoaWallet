/**
 * An ALTERNATIVE way to obtain the secret that unseals the vault — never a
 * bypass of at-rest encryption.
 *
 * The normal unlock path is: user types the password → `decryptPhrase` /
 * `KeyringManager` uses it to unseal the encrypted envelope. Biometric unlock
 * does NOT replace that path; it merely SUPPLIES the same password through a
 * platform authenticator (Touch ID / Face ID / Android BiometricPrompt) that
 * has the password sealed behind the OS keystore. After `unlock()` hands back
 * the secret, the SAME `decryptPhrase` / KeyringManager unlock runs unchanged.
 *
 * Consequences of this discipline:
 *   - The encrypted envelope on disk is ALWAYS password-encrypted. Biometrics
 *     guard access to the password, not to the plaintext key — a stolen device
 *     with a defeated sensor still faces the at-rest encryption.
 *   - This interface is platform-AGNOSTIC: no `chrome.*`, no Capacitor imports.
 *     Concrete biometric backers (Capacitor secure storage + native prompt)
 *     are wired per-platform; `packages/core` only declares the contract and a
 *     web/extension default that has no biometrics at all.
 *
 * NEVER log or persist the value carried by a successful `unlock()` — it is the
 * cleartext vault password and exists only to be fed straight into the decrypt
 * path.
 */

/**
 * The secret carried by a successful biometric `unlock()` — the cleartext vault
 * password that the standard decrypt path consumes.
 *
 * Typed as `string` because it is the same password the user would otherwise
 * type. It is opaque to this layer: this contract obtains it, it does not
 * interpret or validate it.
 */
export type BiometricSecret = string;

/**
 * Why a biometric `unlock()` did not yield a secret. Each reason maps to a
 * distinct, user-meaningful outcome the UI degrades on:
 *   - `biometric-unavailable`: no platform backer, or none enabled yet — the
 *     affordance should not even appear; if it does, fall back silently.
 *   - `biometric-cancelled`: the user dismissed the OS prompt — not an error,
 *     just hand control back to the password field.
 *   - `biometric-failed`: the authenticator rejected (no match / lockout), or
 *     the enrolled biometry changed since enable (current-set invalidation) —
 *     degrade to password, never bypass at-rest encryption.
 */
export type BiometricUnlockFailureReason =
  | 'biometric-unavailable'
  | 'biometric-cancelled'
  | 'biometric-failed';

/**
 * Discriminated result of a biometric `unlock()`.
 *
 * It is a RESULT, never a thrown rejection: a secret-bearing thrown Error risks
 * leaking the cleartext password into logs/telemetry, and an unhandled
 * rejection could break the unlock screen. Callers branch on `ok` and feed
 * `secret` into the same decrypt path on success, or degrade on `reason`.
 */
export type BiometricUnlockResult =
  | { readonly ok: true; readonly secret: BiometricSecret }
  | { readonly ok: false; readonly reason: BiometricUnlockFailureReason };

export interface BiometricUnlock {
  /**
   * Capability probe: whether this platform can actually perform a biometric
   * unlock right now (hardware present, enrolled, and a password has been
   * sealed for it).
   *
   * The UI gates the biometric option on this: a `false` result means show
   * password-only. Implementations MUST resolve (never reject) so the probe
   * itself can never break the unlock screen.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Trigger the platform authenticator and, on success, resolve with a
   * discriminated result carrying the vault password to feed into the SAME
   * `decryptPhrase` / KeyringManager unlock.
   *
   * This returns the unlock SECRET only — it does NOT itself decrypt anything.
   * It RESOLVES a `{ok:false, reason}` (never rejects) when biometrics are
   * unavailable, the user cancels, or the authenticator fails, so callers fall
   * back to the password entry flow without a try/catch.
   */
  unlock(): Promise<BiometricUnlockResult>;
}

/**
 * The production default for web and the Chrome extension, where there is no
 * platform biometric API at all.
 *
 * `isAvailable()` resolves `false` so the UI hides the biometric option, and
 * `unlock()` resolves the `biometric-unavailable` failure result. This is real
 * runtime behavior, not a test stub: it lets the unlock screen render
 * password-only without any platform branching in the UI.
 */
export class UnsupportedBiometricUnlock implements BiometricUnlock {
  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }

  unlock(): Promise<BiometricUnlockResult> {
    return Promise.resolve({ ok: false, reason: 'biometric-unavailable' });
  }
}
