import { describe, expect, it } from 'vitest';

import {
  CorruptEnvelopeError,
  UnsupportedFormatError,
  WrongPasswordError,
} from '@stoachain/stoa-core/crypto';

import { decryptPhrase, encryptPhrase } from '../encryptAtRest';

/**
 * A real (non-secret) 24-word BIP39 phrase used purely as round-trip
 * plaintext. It never derives a wallet here — the test only exercises the
 * encrypt/decrypt envelope, not key material.
 */
const PHRASE =
  'legal winner thank year wave sausage worth useful legal winner thank year ' +
  'wave sausage worth useful legal winner thank year wave sausage worth title';
const PASSWORD = 'correct horse battery staple';

describe('encryptPhrase / decryptPhrase', () => {
  it('round-trips a 24-word phrase: decrypt(encrypt(phrase)) === phrase', async () => {
    const blob = await encryptPhrase(PHRASE, PASSWORD);
    const back = await decryptPhrase(blob, PASSWORD);
    expect(back).toBe(PHRASE);
  });

  it('produces a V2 envelope (not the weaker legacy V1 format)', async () => {
    const blob = await encryptPhrase(PHRASE, PASSWORD);
    // The envelope must decode to a `{ v: 2, ... }` JSON object. A V1 blob
    // round-trips identically, so the round-trip test alone cannot prove V2.
    const decoded = JSON.parse(
      Buffer.from(blob, 'base64').toString('utf8'),
    ) as { v?: number };
    expect(decoded.v).toBe(2);
  });

  it('throws WrongPasswordError when the password is wrong (auth-tag failure)', async () => {
    const blob = await encryptPhrase(PHRASE, PASSWORD);
    await expect(decryptPhrase(blob, 'not the password')).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it('throws CorruptEnvelopeError for a structurally mangled / truncated blob', async () => {
    const blob = await encryptPhrase(PHRASE, PASSWORD);
    // Truncate the base64 envelope so it can no longer atob/JSON.parse into an
    // object — the canonical "this is not a readable envelope at all" case.
    const mangled = blob.slice(0, Math.floor(blob.length / 2));
    await expect(decryptPhrase(mangled, PASSWORD)).rejects.toBeInstanceOf(
      CorruptEnvelopeError,
    );
  });

  it('throws UnsupportedFormatError for a well-formed envelope of an unsupported version', async () => {
    // A blob that parses cleanly to a JSON object but whose schema version is
    // NOT 2. encryptPhrase only ever emits V2, so a v:1 (or any non-2) envelope
    // handed to decryptPhrase is an unsupported format for this wallet — it
    // must be distinguishable from both a wrong password and a corrupt blob.
    const v1Like = Buffer.from(
      JSON.stringify({ v: 1, ciphertext: 'AA==', iv: 'AA==', salt: 'AA==' }),
      'utf8',
    ).toString('base64');
    await expect(decryptPhrase(v1Like, PASSWORD)).rejects.toBeInstanceOf(
      UnsupportedFormatError,
    );
  });

  it('classifies non-string / empty input as CorruptEnvelopeError', async () => {
    await expect(decryptPhrase('', PASSWORD)).rejects.toBeInstanceOf(
      CorruptEnvelopeError,
    );
  });
});
