import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { describe, expect, it } from 'vitest';

import { generateMnemonic, validateMnemonic } from '../mnemonic';

/**
 * A known-good 24-word koala (BIP39) recovery phrase with a valid checksum.
 * Reused as the canonical "accepts a real phrase" vector. NEVER logged.
 */
const KNOWN_GOOD =
  'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown';

describe('generateMnemonic', () => {
  it('produces a fresh 24-word phrase that its own validator accepts', async () => {
    const phrase = await generateMnemonic();

    // A 24-word phrase is the only length the import gate accepts, so a
    // generated phrase that fails the gate would be unusable on import.
    expect(phrase.split(' ')).toHaveLength(24);
    expect(validateMnemonic(phrase)).toEqual({ valid: true });
  });

  it('produces a different phrase on each call (fresh entropy, not a constant)', async () => {
    const [a, b] = await Promise.all([generateMnemonic(), generateMnemonic()]);

    // A hardcoded/constant phrase would be a catastrophic key-reuse bug;
    // distinct entropy must yield distinct phrases.
    expect(a).not.toBe(b);
  });
});

describe('validateMnemonic', () => {
  it('accepts a known-good 24-word phrase', () => {
    expect(validateMnemonic(KNOWN_GOOD)).toEqual({ valid: true });
  });

  it('accepts the same phrase passed as a string[] of words', () => {
    expect(validateMnemonic(KNOWN_GOOD.split(' '))).toEqual({ valid: true });
  });

  it('rejects a 12-word phrase with reason "word-count" before any checksum work', () => {
    const twelve = KNOWN_GOOD.split(' ').slice(0, 12).join(' ');

    // The import flow only supports the 24-word koala path; a 12-word phrase
    // must be turned away on length, not silently checksum-failed.
    expect(validateMnemonic(twelve)).toEqual({
      valid: false,
      reason: 'word-count',
    });
  });

  it('rejects 24 words containing a non-wordlist word with reason "invalid-words"', () => {
    const words = KNOWN_GOOD.split(' ');
    words[23] = 'notawordxyz';

    // A typo'd word that is not in the BIP39 wordlist would derive a wrong key
    // silently; it must be rejected at the gate.
    expect(validateMnemonic(words.join(' '))).toEqual({
      valid: false,
      reason: 'invalid-words',
    });
  });

  it('rejects 24 valid wordlist words with a broken checksum as "invalid-words"', () => {
    const words = KNOWN_GOOD.split(' ');
    // 'zoo' is a real BIP39 word, so this passes word-count and wordlist
    // membership but breaks the checksum — the gate must still reject it.
    words[23] = 'zoo';
    const broken = words.join(' ');
    expect(bip39.validateMnemonic(broken, wordlist)).toBe(false);

    expect(validateMnemonic(broken)).toEqual({
      valid: false,
      reason: 'invalid-words',
    });
  });

  it('tolerates leading/trailing whitespace around an otherwise valid phrase', () => {
    // Pasted phrases routinely carry stray edge whitespace; normalizing it away
    // must not turn a valid phrase into a rejection.
    expect(validateMnemonic(`   ${KNOWN_GOOD}\n`)).toEqual({ valid: true });
  });

  it('collapses internal multi-space runs rather than counting empty tokens', () => {
    // A double space between words must not inflate the word count; after
    // normalization a valid 24-word phrase stays valid.
    const doubled = KNOWN_GOOD.split(' ').join('  ');
    expect(validateMnemonic(doubled)).toEqual({ valid: true });
  });

  it('rejects a string[] containing an empty/whitespace token as "word-count"', () => {
    const words = KNOWN_GOOD.split(' ');
    words.splice(5, 0, '   ');

    // An empty token in the array is an entry error — after dropping it the
    // remaining 24 words would falsely validate, so the empty token must be
    // surfaced as a count problem, not silently swallowed.
    expect(validateMnemonic(words)).toEqual({
      valid: false,
      reason: 'word-count',
    });
  });

  it('rejects an empty / whitespace-only input as "word-count"', () => {
    expect(validateMnemonic('   ')).toEqual({
      valid: false,
      reason: 'word-count',
    });
    expect(validateMnemonic([])).toEqual({
      valid: false,
      reason: 'word-count',
    });
  });
});
