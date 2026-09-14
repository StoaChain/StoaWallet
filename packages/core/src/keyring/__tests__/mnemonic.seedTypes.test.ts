import { KadenaWalletBuilder } from '@stoachain/stoa-core/wallet';
import { describe, expect, it, vi } from 'vitest';

import {
  generateMnemonicFor,
  previewSeedPublicKey,
  validateMnemonicFor,
} from '../mnemonic';

// Chainweaver/EckoWallet derivation runs through WASM — slower than koala.
vi.setConfig({ testTimeout: 120_000 });

describe('seed-type-aware mnemonic helpers', () => {
  it.each([
    ['koala', 24],
    ['chainweaver', 12],
    ['eckowallet', 12],
  ] as const)(
    'generates a %s phrase of %i words that validates for its own type',
    async (seedType, words) => {
      const phrase = await generateMnemonicFor(seedType);

      expect(phrase.split(' ')).toHaveLength(words);
      expect(await validateMnemonicFor(phrase, seedType)).toEqual({ valid: true });
    },
  );

  it('REJECTS a valid 24-word koala phrase submitted as chainweaver, on word count', async () => {
    // The SDK's isValidMnemonic(phrase, 'chainweaver') ACCEPTS a 24-word phrase
    // (probed). Trusting it alone would store a koala seed under the chainweaver
    // derivation and silently produce the wrong keys.
    const koala = await generateMnemonicFor('koala');

    expect(await validateMnemonicFor(koala, 'chainweaver')).toEqual({
      valid: false,
      reason: 'word-count',
    });
  });

  it('REJECTS a 12-word chainweaver phrase submitted as koala, on word count', async () => {
    const chainweaver = await generateMnemonicFor('chainweaver');

    expect(await validateMnemonicFor(chainweaver, 'koala')).toEqual({
      valid: false,
      reason: 'word-count',
    });
  });

  it.each(['koala', 'chainweaver', 'eckowallet'] as const)(
    'rejects words outside the wordlist for %s as invalid-words rather than throwing',
    async (seedType) => {
      const count = seedType === 'koala' ? 24 : 12;
      const garbage = Array.from({ length: count }, () => 'notaword').join(' ');

      expect(await validateMnemonicFor(garbage, seedType)).toEqual({
        valid: false,
        reason: 'invalid-words',
      });
    },
  );

  it('normalizes case, newlines and runs of whitespace before validating', async () => {
    const phrase = await generateMnemonicFor('eckowallet');
    // A phrase pasted from a notes app arrives uppercased and line-broken.
    const messy = `  ${phrase.toUpperCase().split(' ').join(' \n\t ')}  `;

    expect(await validateMnemonicFor(messy, 'eckowallet')).toEqual({ valid: true });
  });

  it.each(['koala', 'chainweaver', 'eckowallet'] as const)(
    'previews Key #0 for a %s phrase exactly as the real derivation produces it',
    async (seedType) => {
      const phrase = await generateMnemonicFor(seedType);
      const derived = await KadenaWalletBuilder.createWalletPairFromMnemonic(
        'any wallet password',
        phrase,
        0,
        seedType,
      );

      // The public key does not depend on the password, so the preview is the
      // exact k: address the seed will produce once saved.
      expect(await previewSeedPublicKey(phrase, seedType)).toBe(derived.publicKey);
    },
  );

  it('previews nothing for a phrase that is invalid for the chosen type', async () => {
    const koala = await generateMnemonicFor('koala');

    expect(await previewSeedPublicKey(koala, 'chainweaver')).toBeNull();
  });

  it.each([
    ['koala', 24],
    ['chainweaver', 12],
  ] as const)(
    'previews nothing for a %s phrase of real words with a bad checksum',
    async (seedType, count) => {
      // All-"abandon" fails the checksum at both lengths (the valid phrases end
      // in "art" and "about"), so only the derivation's own check can catch it.
      const badChecksum = Array.from({ length: count }, () => 'abandon').join(' ');

      expect(await previewSeedPublicKey(badChecksum, seedType)).toBeNull();
    },
  );

  it('previews with an EMPTY password, exactly as Codex does', async () => {
    // The public key is password-independent but the cost is not: a non-empty
    // password made each 12-word preview ~1.5-3s instead of ~0.3s, freezing the
    // popup on every "Generate new phrase".
    const phrase = await generateMnemonicFor('chainweaver');
    const derive = vi.spyOn(KadenaWalletBuilder, 'createWalletPairFromMnemonic');
    try {
      await previewSeedPublicKey(phrase, 'chainweaver');
      expect(derive).toHaveBeenCalledWith('', phrase, 0, 'chainweaver');
    } finally {
      derive.mockRestore();
    }
  });
});
