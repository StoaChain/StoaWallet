/**
 * Pasted-private-key validation and encrypt-to-record for the advanced
 * "import a foreign key" flow. PURE crypto only — no live network or storage
 * I/O happens here; the caller owns persistence.
 *
 * `validatePastedKey` confirms a user-pasted private key (64-char Ed25519 seed
 * OR 128-char BIP32-Ed25519 extended key) actually derives to one of the
 * public keys the codex is expecting, WITHOUT trusting the input's shape. The
 * derivation is delegated to the SDK's `tryDerivePublicKey`, which handles the
 * 64-vs-128 branch and returns null on any invalid key (so a single derivation
 * call covers both formats and never throws here).
 *
 * `encryptPureKeypair` wraps a validated key into an `IPureKeypair` record whose
 * private material lives ONLY inside the V2 AES-GCM envelope produced by
 * `smartEncrypt` (PBKDF2-SHA512 / 600k), identical to the recovery-phrase
 * encryption used elsewhere in the wallet.
 *
 * SECRET HANDLING (highest priority): the plaintext private key and the wallet
 * password are NEVER stored as a field, NEVER persisted, and NEVER logged. The
 * outcome of validation is a discriminated result — never a thrown Error that
 * could carry secret material in its message — and any user-facing diagnostic
 * about a mismatch uses only truncated PUBLIC keys.
 */
import { smartEncrypt } from '@stoachain/stoa-core/crypto';
import { tryDerivePublicKey } from '@stoachain/stoa-core/guard';

/** Exactly 64 OR 128 hex characters (no `0x`, no separators). */
const KEY_FORMAT = /^[0-9a-fA-F]{64}([0-9a-fA-F]{64})?$/;

/**
 * The SINGLE source of the pasted-private-key format gate: exactly 64 (standard
 * Ed25519 / Koala) OR 128 (extended BIP32 [kL|kR]) hex chars, anchored so trailing
 * garbage is rejected. UI pre-checks consume this instead of duplicating the regex,
 * so the client gate and the authoritative validation never drift.
 */
export function isPastedKeyFormat(value: string): boolean {
  return KEY_FORMAT.test(value);
}

/** Schema-version string that forces `smartEncrypt` down the V2 path. */
const V2_SCHEMA_VERSION = '2';

/** Discriminated outcome of {@link validatePastedKey}. */
export type ValidatePastedKeyResult =
  | { ok: true; publicKey: string }
  | { ok: false; reason: 'bad-format' | 'key-mismatch' | 'invalid-key' };

/**
 * The persisted shape for an imported pure key. Mirrors the codex
 * `IPureKeypair` minus the codex-only marker fields — this wallet's advanced
 * import path does not assign CodexGuard / DuoPurePrime roles.
 */
export interface PureKeypairRecord {
  id: string;
  label?: string;
  /** 64-char hex — the DERIVED, validated public key. */
  publicKey: string;
  /** Opaque V2 envelope from `smartEncrypt(privateKey, password, "2")`. */
  encryptedPrivateKey: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/**
 * Validate a pasted private key against the public keys the codex expects.
 *
 * 1. FORMAT gate — must be exactly 64 or 128 hex chars, else `bad-format`.
 * 2. DERIVE — `tryDerivePublicKey` handles both lengths and returns null for
 *    any invalid key (it catches its own derivation throws); null → `invalid-key`.
 *    The input is NOT truncated or normalized before derivation.
 * 3. MEMBERSHIP — the derived pub must be one of `expectedKeys`, else
 *    `key-mismatch`.
 *
 * Never throws on a bad key; never logs the input.
 */
export function validatePastedKey(
  privateKey: string,
  expectedKeys: string[],
): ValidatePastedKeyResult {
  if (!KEY_FORMAT.test(privateKey)) {
    return { ok: false, reason: 'bad-format' };
  }

  const derivedPublicKey = tryDerivePublicKey(privateKey);
  if (derivedPublicKey === null) {
    return { ok: false, reason: 'invalid-key' };
  }

  if (!expectedKeys.includes(derivedPublicKey)) {
    return { ok: false, reason: 'key-mismatch' };
  }

  return { ok: true, publicKey: derivedPublicKey };
}

/**
 * Encrypt a validated pure keypair into a persistable record.
 *
 * `publicKey` MUST be the derived/validated public key from
 * {@link validatePastedKey} (callers pass the value they already confirmed).
 * The private key is encrypted to a V2 envelope and is never retained in
 * plaintext on the returned record.
 */
export async function encryptPureKeypair(
  privateKey: string,
  publicKey: string,
  walletPassword: string,
  label?: string,
): Promise<PureKeypairRecord> {
  const encryptedPrivateKey = await smartEncrypt(
    privateKey,
    walletPassword,
    V2_SCHEMA_VERSION,
  );

  const record: PureKeypairRecord = {
    id: crypto.randomUUID(),
    publicKey,
    encryptedPrivateKey,
    createdAt: new Date().toISOString(),
  };

  if (label !== undefined) {
    record.label = label;
  }

  return record;
}
