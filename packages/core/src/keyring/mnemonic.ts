import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { KadenaWalletBuilder } from '@stoachain/stoa-core/wallet';

/** The single mnemonic length the koala (BIP39) import path accepts. */
const REQUIRED_WORD_COUNT = 24;

/** Why a candidate phrase was turned away by the import gate. */
export type MnemonicRejection = 'word-count' | 'invalid-words';

export type MnemonicValidation =
  | { valid: true }
  | { valid: false; reason: MnemonicRejection };

/**
 * Generate a fresh 24-word koala (BIP39) recovery phrase.
 *
 * Delegates to the SDK's CSPRNG-backed generator rather than reimplementing
 * entropy collection. The returned phrase is the raw secret — callers must
 * never log it.
 */
export async function generateMnemonic(): Promise<string> {
  return KadenaWalletBuilder.generateMnemonic(REQUIRED_WORD_COUNT);
}

/**
 * Normalize a candidate phrase into lowercase words.
 *
 * For a `string`, edge whitespace is trimmed and internal whitespace runs
 * collapse to single word boundaries — neither produces empty tokens.
 *
 * For a `string[]`, each element is trimmed and lowercased; an element that is
 * empty or whitespace-only is reported via `hadEmptyToken` rather than silently
 * dropped, because a blank array slot is a mis-entered word, not noise.
 */
function tokenize(words: string[] | string): {
  kept: string[];
  hadEmptyToken: boolean;
} {
  if (typeof words === 'string') {
    const trimmed = words.trim().toLowerCase();
    const kept = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
    return { kept, hadEmptyToken: false };
  }

  const kept: string[] = [];
  let hadEmptyToken = false;

  for (const raw of words) {
    const word = raw.trim().toLowerCase();
    if (word.length === 0) {
      hadEmptyToken = true;
      continue;
    }
    // A single array element may itself contain spaces (e.g. a pasted run);
    // split it so the word count reflects actual words.
    kept.push(...word.split(/\s+/));
  }

  return { kept, hadEmptyToken };
}

/**
 * Validate a candidate recovery phrase BEFORE any derivation or encryption.
 *
 * Normalizes first (trim, lowercase, collapse whitespace, drop empty tokens),
 * then applies two ordered gates:
 *   1. exactly 24 words, else `reason: "word-count"`;
 *   2. a valid BIP39 phrase (every word in the wordlist AND a correct
 *      checksum), else `reason: "invalid-words"`.
 *
 * An empty/whitespace-only token in a `string[]` input counts against the word
 * count: it signals a mis-entered word, so the phrase is rejected on count
 * rather than silently dropping the blank and validating the remainder.
 */
export function validateMnemonic(
  words: string[] | string,
): MnemonicValidation {
  const { kept, hadEmptyToken } = tokenize(words);

  if (hadEmptyToken || kept.length !== REQUIRED_WORD_COUNT) {
    return { valid: false, reason: 'word-count' };
  }

  const phrase = kept.join(' ');
  if (!bip39.validateMnemonic(phrase, wordlist)) {
    return { valid: false, reason: 'invalid-words' };
  }

  return { valid: true };
}
