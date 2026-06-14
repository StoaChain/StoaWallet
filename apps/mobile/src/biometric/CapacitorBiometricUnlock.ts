/**
 * Native (Capacitor) `BiometricUnlock` backer for the mobile app.
 *
 * It implements the platform-AGNOSTIC `BiometricUnlock` contract from
 * `@stoawallet/core` — so the SAME `UnlockScreen` consumes it without any
 * platform branching — while keeping every Capacitor/native import HERE, never
 * in `packages/core`.
 *
 * SECURITY DISCIPLINE (mirrors the core contract's invariants):
 *   - Biometric unlock is an ALTERNATIVE way to obtain the vault PASSWORD, not a
 *     vault decryptor. On a successful prompt it returns the sealed password so
 *     the ordinary `decryptPhrase` / KeyringManager unlock runs unchanged. It
 *     never holds the mnemonic and never bypasses at-rest `smartEncrypt`.
 *   - The password is sealed into the device secure storage only AFTER it is
 *     verified to actually unlock the vault (`enableBiometric`), behind explicit
 *     opt-in. A password that does not verify never reaches storage.
 *   - BIOMETRY-TYPE CHANGE DETECTION (NOT a true current-set guarantee): the
 *     secure-storage plugin does not expose
 *     `kSecAccessControlBiometryCurrentSet` (iOS) /
 *     `setInvalidatedByBiometricEnrollment` (Android), so what the software check
 *     enforces is narrow: a biometry TYPE category snapshot (`biometryType` /
 *     `biometryTypes`, e.g. fingerprint vs face) is taken at enable-time and
 *     re-checked on every unlock. It trips ONLY when the type changes
 *     (fingerprint↔face) or when all enrollment is lost. It CANNOT detect an
 *     attacker ADDING their own SAME-TYPE credential (a second fingerprint of
 *     the same class) — the realistic local-attacker scenario — because that
 *     leaves the type set unchanged. This is therefore NOT a real current-set
 *     binding; it is defense-in-depth only. The true binding requires the native
 *     ACL flags marked as a RELEASE BLOCKER in the build-time note at the foot of
 *     this file.
 *   - The password/secret is NEVER logged. No console writes carry it.
 */
import type {
  BiometricSecret,
  BiometricUnlock,
  BiometricUnlockResult,
} from '@stoawallet/core';

/**
 * The slice of `@aparajita/capacitor-biometric-auth` this backer consumes.
 * Declared structurally so tests can inject a faithful double and production
 * passes the real `BiometricAuth` proxy.
 */
export interface BiometryProbe {
  /** True only when the device has enrolled biometry available right now. */
  readonly isAvailable: boolean;
  /** The primary enrolled biometry type (enum ordinal). */
  readonly biometryType: number;
  /** All supported biometry types (Android can report several). */
  readonly biometryTypes: number[];
}

export interface BiometricAuthBackend {
  checkBiometry(): Promise<BiometryProbe>;
  /** Resolves on success; rejects with a `{code}`-bearing error otherwise. */
  authenticate(options?: { reason?: string }): Promise<void>;
}

/**
 * The slice of `capacitor-secure-storage-plugin` this backer consumes. Faithful
 * to the native plugin: `get` REJECTS when the key is absent (it does not
 * resolve an empty value).
 */
export interface SecureStorageBackend {
  get(options: { key: string }): Promise<{ value: string }>;
  set(options: { key: string; value: string }): Promise<{ value: boolean }>;
  remove(options: { key: string }): Promise<{ value: boolean }>;
}

/** Verifies a candidate password actually unlocks the vault (decrypts). */
export type VerifyPassword = (candidate: string) => Promise<boolean>;

export interface CapacitorBiometricUnlockDeps {
  readonly auth: BiometricAuthBackend;
  readonly storage: SecureStorageBackend;
  readonly verifyPassword: VerifyPassword;
  /** Reason copy surfaced in the OS prompt. */
  readonly reason?: string;
}

/**
 * Secure-storage key holding the biometric-sealed vault password. The wallet
 * password lives here ONLY after `enableBiometric` verified it; reading it is
 * gated behind a successful biometric `authenticate()`.
 */
export const BIOMETRIC_PASSWORD_KEY = 'stoawallet:biometric:password';

/**
 * Secure-storage key holding the enrollment fingerprint captured at enable-time.
 * Compared on every unlock to enforce current-set binding in software.
 */
export const BIOMETRIC_ENROLLMENT_KEY = 'stoawallet:biometric:enrollment';

/**
 * `BiometryError` codes (from `@aparajita/capacitor-biometric-auth`) that mean
 * the USER dismissed the prompt rather than the authenticator failing. These
 * map to `biometric-cancelled`; every other rejection maps to `biometric-failed`.
 */
const CANCEL_CODES = new Set([
  'userCancel',
  'appCancel',
  'systemCancel',
  'userFallback',
]);

/**
 * Canonical, stable fingerprint of the enrolled biometry TYPE set. Sorting the
 * type list makes the comparison order-insensitive so only a biometry-TYPE
 * change (a type added/removed, e.g. fingerprint↔face, or total loss of
 * enrollment) trips the check, not a reordered report. NOTE: this is a TYPE
 * category snapshot — it does NOT capture which specific credentials are
 * enrolled, so an attacker adding a same-type credential is NOT detected. See
 * the file header and the build-time release-blocker note.
 */
function fingerprintEnrollment(probe: BiometryProbe): string {
  return JSON.stringify({
    primary: probe.biometryType,
    set: [...probe.biometryTypes].sort((a, b) => a - b),
  });
}

function errorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return '';
}

export class CapacitorBiometricUnlock implements BiometricUnlock {
  private readonly auth: BiometricAuthBackend;
  private readonly storage: SecureStorageBackend;
  private readonly verifyPassword: VerifyPassword;
  private readonly reason: string;

  constructor(deps: CapacitorBiometricUnlockDeps) {
    this.auth = deps.auth;
    this.storage = deps.storage;
    this.verifyPassword = deps.verifyPassword;
    this.reason = deps.reason ?? 'Unlock your StoaWallet';
  }

  /**
   * True only when (a) the device reports enrolled biometry AND (b) a password
   * has been sealed for it. Either missing → false (the UI hides the
   * affordance). Contract-bound to RESOLVE, never reject: a misbehaving probe
   * degrades to false so it can never break the unlock screen.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const probe = await this.auth.checkBiometry();
      if (!probe.isAvailable) return false;
      return await this.hasSealedPassword();
    } catch {
      return false;
    }
  }

  /**
   * Trigger the OS prompt and, on success, return the sealed password as a
   * discriminated result. NEVER throws and NEVER returns the secret in a thrown
   * error. Order of guards:
   *   1. No sealed password → `biometric-unavailable` (nothing to return).
   *   2. Biometry TYPE changed since enable (type-change check, NOT a true
   *      current-set binding) → `biometric-failed`; the OS prompt is NOT even
   *      shown under a stale snapshot, and the UI re-prompts for the password.
   *      This catches fingerprint↔face / loss of enrollment ONLY — an added
   *      same-type credential is NOT detected here (see the file header).
   *   3. Prompt cancelled → `biometric-cancelled`; any other rejection →
   *      `biometric-failed`.
   */
  async unlock(): Promise<BiometricUnlockResult> {
    const sealedPassword = await this.readSealed(BIOMETRIC_PASSWORD_KEY);
    const sealedEnrollment = await this.readSealed(BIOMETRIC_ENROLLMENT_KEY);
    if (sealedPassword === null || sealedEnrollment === null) {
      return { ok: false, reason: 'biometric-unavailable' };
    }

    let probe: BiometryProbe;
    try {
      probe = await this.auth.checkBiometry();
    } catch {
      return { ok: false, reason: 'biometric-failed' };
    }
    if (!probe.isAvailable) {
      return { ok: false, reason: 'biometric-unavailable' };
    }
    if (fingerprintEnrollment(probe) !== sealedEnrollment) {
      // Biometry-TYPE change detected (fingerprint↔face / lost enrollment).
      // Refuse to hand back the sealed password; degrade to the password path.
      // This does NOT detect an added same-type credential — it is not a true
      // current-set guarantee (see the file header and the release-blocker note).
      return { ok: false, reason: 'biometric-failed' };
    }

    try {
      await this.auth.authenticate({ reason: this.reason });
    } catch (error) {
      const reason = CANCEL_CODES.has(errorCode(error))
        ? 'biometric-cancelled'
        : 'biometric-failed';
      return { ok: false, reason };
    }

    const secret: BiometricSecret = sealedPassword;
    return { ok: true, secret };
  }

  /**
   * Opt-in: verify the wallet password actually unlocks the vault, then seal it
   * (and an enrollment fingerprint) into secure storage behind the biometric
   * ACL. A password that does not verify is REJECTED and never written.
   */
  async enableBiometric(walletPassword: string): Promise<void> {
    const verified = await this.verifyPassword(walletPassword);
    if (!verified) {
      throw new Error(
        'Cannot enable biometric unlock: the wallet password did not verify.',
      );
    }
    const probe = await this.auth.checkBiometry();
    await this.storage.set({
      key: BIOMETRIC_ENROLLMENT_KEY,
      value: fingerprintEnrollment(probe),
    });
    await this.storage.set({
      key: BIOMETRIC_PASSWORD_KEY,
      value: walletPassword,
    });
  }

  /**
   * Revoke biometric unlock: delete the sealed password and enrollment
   * fingerprint. Called on biometrics-disable, wallet-password-change, and
   * wallet-reset. After this, `isAvailable()` → false and `unlock()` →
   * `biometric-unavailable` until `enableBiometric` runs again.
   */
  async clearBiometric(): Promise<void> {
    await this.removeQuietly(BIOMETRIC_PASSWORD_KEY);
    await this.removeQuietly(BIOMETRIC_ENROLLMENT_KEY);
  }

  private async hasSealedPassword(): Promise<boolean> {
    return (await this.readSealed(BIOMETRIC_PASSWORD_KEY)) !== null;
  }

  /**
   * Read a secure-storage value, mapping the native plugin's missing-key
   * REJECTION to a `null` so callers branch on presence without try/catch noise.
   */
  private async readSealed(key: string): Promise<string | null> {
    try {
      const { value } = await this.storage.get({ key });
      return value;
    } catch {
      return null;
    }
  }

  /** Remove a key, tolerating the plugin's reject-on-missing-key. */
  private async removeQuietly(key: string): Promise<void> {
    try {
      await this.storage.remove({ key });
    } catch {
      // Already absent — clearing is idempotent.
    }
  }
}

/*
 * RELEASE BLOCKER — native ACL backing for a TRUE current-set binding:
 *
 * Biometric unlock MUST NOT ship to production until the sealed secure item is
 * bound to the CURRENT enrolled biometric set at the NATIVE layer. The software
 * check above is NOT a substitute: it only compares a biometry TYPE snapshot, so
 * an attacker who ADDS their own same-type fingerprint can still unlock. That is
 * the realistic local-attacker scenario, and only the native ACL flags close it.
 *
 * `capacitor-secure-storage-plugin@0.13.0` seals values to the iOS Keychain /
 * Android Keystore but does NOT expose the access-control flags that bind a
 * stored item to the CURRENT enrolled biometry:
 *   - iOS:     `kSecAccessControlBiometryCurrentSet`
 *   - Android: KeyGenParameterSpec `setUserAuthenticationRequired(true)` +
 *              `setInvalidatedByBiometricEnrollment(true)` (STRONG biometric class)
 *
 * The software TYPE-change compare above is defense-in-depth ONLY — a partial
 * fail-closed degrade that catches fingerprint↔face / total enrollment loss. It
 * is NOT a hardware guarantee and does NOT detect an added same-type credential.
 *
 * To unblock production, the secure-storage layer must be replaced or extended
 * with one that sets the flags above (e.g. a Keystore-backed plugin exposing the
 * access-control options) AND that binding must be verified on-device. Until that
 * lands and is verified, biometric unlock is a NON-SHIPPABLE feature; the software
 * binding is the documented, tested interim behavior, not a release substitute.
 */
