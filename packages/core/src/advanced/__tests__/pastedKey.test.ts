import { afterEach, describe, expect, it, vi } from 'vitest';

import { smartDecrypt } from '@stoachain/stoa-core/crypto';
import { tryDerivePublicKey } from '@stoachain/stoa-core/guard';

import { encryptPureKeypair, validatePastedKey } from '../pastedKey';

// Fixed 64-char Ed25519 seed (any 32 bytes is a valid seed). Its derived pubkey
// is computed at runtime via the REAL SDK so the test pins derivation behavior,
// not a guessed constant.
const KEY_64 = '1'.repeat(64);
const PUB_64 = tryDerivePublicKey(KEY_64) as string;

// Fixed 128-char extended (BIP32-Ed25519) foreign key. The kL portion must be a
// valid scalar; 'ab'.repeat(64) derives cleanly. Pub computed via REAL SDK.
const KEY_128 = 'ab'.repeat(64);
const PUB_128 = tryDerivePublicKey(KEY_128) as string;

const OTHER_PUB = 'f'.repeat(64);

const PASSWORD = 'correct horse battery staple';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validatePastedKey — FORMAT gate', () => {
  it('rejects a 63-char (too short) input as bad-format before any derivation', () => {
    // 63 hex chars matches neither the 64- nor 128-char arm of the format regex,
    // so it must be rejected at the gate without attempting key derivation.
    expect(validatePastedKey('1'.repeat(63), [PUB_64])).toEqual({
      ok: false,
      reason: 'bad-format',
    });
  });

  it('rejects a 130-char input as bad-format (between the two valid lengths)', () => {
    expect(validatePastedKey('a'.repeat(130), [PUB_128])).toEqual({
      ok: false,
      reason: 'bad-format',
    });
  });

  it('rejects a 64-length non-hex input as bad-format', () => {
    // Right length, wrong alphabet ('z' is not hex) — the format gate, not the
    // derivation step, is what rejects this.
    expect(validatePastedKey('z'.repeat(64), [PUB_64])).toEqual({
      ok: false,
      reason: 'bad-format',
    });
  });
});

describe('validatePastedKey — derivation + membership', () => {
  it('returns ok:true with the derived pubkey when a 64-char key derives into expectedKeys', () => {
    // Happy path: the derived pubkey is the one the codex already knows about,
    // so the paste is accepted and the DERIVED pub (not the input) is returned.
    expect(validatePastedKey(KEY_64, [OTHER_PUB, PUB_64])).toEqual({
      ok: true,
      publicKey: PUB_64,
    });
  });

  it('returns key-mismatch when a valid 64-char key derives to a pub NOT in expectedKeys', () => {
    // Key derives fine but is not one of the codex pubkeys — this is the
    // "right format, wrong account" case and must be distinct from invalid-key.
    expect(validatePastedKey(KEY_64, [OTHER_PUB])).toEqual({
      ok: false,
      reason: 'key-mismatch',
    });
  });

  it('derives a 128-char extended key via the extended path and accepts it when in expectedKeys', () => {
    // The extended (BIP32) arm must use the extended-key derivation, not the
    // 64-char seed derivation; a wrong path would yield a different pubkey and
    // fail membership.
    expect(validatePastedKey(KEY_128, [PUB_128])).toEqual({
      ok: true,
      publicKey: PUB_128,
    });
  });

  it('returns key-mismatch for a 128-char key whose derived pub is not in expectedKeys', () => {
    // Per the extended-key requirement: a 128-char input that derives correctly
    // but to an unexpected pub is a mismatch, not a format/invalid error.
    expect(validatePastedKey(KEY_128, [OTHER_PUB])).toEqual({
      ok: false,
      reason: 'key-mismatch',
    });
  });
});

describe('encryptPureKeypair', () => {
  it('produces an IPureKeypair whose encryptedPrivateKey round-trips back to the original key under the same password', async () => {
    const record = await encryptPureKeypair(KEY_64, PUB_64, PASSWORD, 'My key');

    // The contract is decryptability, not envelope shape: encrypting then
    // decrypting under the same password must recover the exact private key.
    await expect(smartDecrypt(record.encryptedPrivateKey, PASSWORD)).resolves.toBe(
      KEY_64,
    );
  });

  it('stores the validated public key, the label, an id, and an ISO createdAt — and NEVER the plaintext key as a field', async () => {
    const record = await encryptPureKeypair(KEY_64, PUB_64, PASSWORD, 'My key');

    expect(record.publicKey).toBe(PUB_64);
    expect(record.label).toBe('My key');
    expect(typeof record.id).toBe('string');
    expect(record.id.length).toBeGreaterThan(0);
    // createdAt must be a valid ISO-8601 timestamp that re-serializes identically.
    expect(new Date(record.createdAt).toISOString()).toBe(record.createdAt);

    // The plaintext private key must not appear in ANY field of the record.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(KEY_64);
  });

  it('omits the label when none is provided', async () => {
    const record = await encryptPureKeypair(KEY_64, PUB_64, PASSWORD);

    expect(record.label).toBeUndefined();
  });

  it('generates a fresh unique id for each call', async () => {
    const a = await encryptPureKeypair(KEY_64, PUB_64, PASSWORD);
    const b = await encryptPureKeypair(KEY_64, PUB_64, PASSWORD);

    expect(a.id).not.toBe(b.id);
  });
});

describe('never-log-secrets', () => {
  it('emits no console output containing the whole private-key token across validate + encrypt', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];

    validatePastedKey(KEY_64, [OTHER_PUB]); // mismatch path (most likely to log)
    validatePastedKey('z'.repeat(64), [PUB_64]); // bad-format path
    const ok = validatePastedKey(KEY_64, [PUB_64]);
    expect(ok.ok).toBe(true);
    await encryptPureKeypair(KEY_64, PUB_64, PASSWORD, 'My key');

    const allOutput = spies
      .flatMap((s) => s.mock.calls)
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join('\n');

    expect(allOutput).not.toContain(KEY_64);
    expect(allOutput).not.toContain(PASSWORD);
  });
});
