/**
 * Encrypt-at-rest for the wallet's secret recovery phrase.
 *
 * A thin typed wrapper over the SDK crypto codex. It does NOT reimplement any
 * cryptography — `encryptPhrase` / `decryptPhrase` delegate to the SDK's
 * `smartEncrypt` / `smartDecrypt`, forcing the V2 envelope (PBKDF2-SHA512 /
 * 600k iterations → AES-GCM-256). The legacy V1 format (PBKDF2-SHA256 / 10k,
 * sub-OWASP) is never produced and never accepted here.
 *
 * Decrypt failures are surfaced as three distinct, catch-discriminable error
 * classes so the caller can react correctly:
 *   - `WrongPasswordError`     — KDF ran, AES-GCM auth-tag failed (retry pw).
 *   - `UnsupportedFormatError` — envelope parses but is not the V2 schema this
 *                                wallet writes (e.g. a stray legacy V1 blob).
 *   - `CorruptEnvelopeError`   — the blob is not a readable envelope at all.
 *
 * The SDK's `smartDecrypt` silently routes any non-V2 blob to the weaker V1
 * KDF; this wrapper guards against that downgrade by rejecting non-V2
 * envelopes up front, which is also what makes `UnsupportedFormatError`
 * reachable as a distinct outcome.
 */
import {
  CorruptEnvelopeError,
  UnsupportedFormatError,
  isEncryptedV2,
  smartDecrypt,
  smartEncrypt,
} from '@stoachain/stoa-core/crypto';

import type { EncryptedBlob } from './vault';

// `EncryptedBlob` is the single canonical brand owned by `./vault`. Re-exported
// here so existing `encryptAtRest` importers keep resolving the same type, and
// so `encryptPhrase`'s output assigns directly to `StoredWallet.encryptedPhrase`.
export type { EncryptedBlob };

/** Schema-version string that forces `smartEncrypt` down the V2 path. */
const V2_SCHEMA_VERSION = '2';

/** Encrypt a recovery phrase to an opaque V2 envelope. */
export async function encryptPhrase(
  phrase: string,
  password: string,
): Promise<EncryptedBlob> {
  const blob = await smartEncrypt(phrase, password, V2_SCHEMA_VERSION);
  return blob as EncryptedBlob;
}

/**
 * Decrypt a V2 envelope back to its plaintext phrase.
 *
 * Throws `CorruptEnvelopeError` if `blob` is not a readable envelope,
 * `UnsupportedFormatError` if it parses but is not V2, `WrongPasswordError`
 * if the password is wrong — all propagated so the caller can discriminate.
 */
export async function decryptPhrase(
  blob: string,
  password: string,
): Promise<string> {
  if (typeof blob !== 'string' || blob.length === 0) {
    throw new CorruptEnvelopeError('Encrypted blob is empty or not a string');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(blob));
  } catch (cause) {
    throw new CorruptEnvelopeError('Encrypted blob is not a readable envelope', {
      cause,
    });
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new CorruptEnvelopeError('Encrypted envelope must be a JSON object');
  }

  if (!isEncryptedV2(blob)) {
    throw new UnsupportedFormatError(
      'Encrypted envelope is not the supported V2 format',
    );
  }

  // V2 envelope confirmed — delegate the actual KDF + AES-GCM to the SDK.
  // WrongPasswordError / CorruptEnvelopeError from here propagate unchanged.
  return smartDecrypt(blob, password);
}
