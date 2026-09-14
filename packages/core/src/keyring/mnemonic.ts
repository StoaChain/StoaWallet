import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { KadenaWalletBuilder } from '@stoachain/stoa-core/wallet';

import type { SeedType } from './vault';

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

/**
 * Words per seed type: koala is 24-word BIP39; Chainweaver and EckoWallet are
 * 12-word Kadena mnemonics. The count is enforced HERE, before any SDK check,
 * because the SDK's `isValidMnemonic(phrase, seedType)` does not enforce it — it
 * accepts a 24-word phrase as chainweaver, which would store a koala seed under
 * the chainweaver derivation and silently produce the wrong keys.
 */
export const WORD_COUNT_BY_SEED_TYPE: Readonly<Record<SeedType, 12 | 24>> = {
  koala: 24,
  chainweaver: 12,
  eckowallet: 12,
};

const ENGLISH_WORDS: ReadonlySet<string> = new Set(wordlist);

/** Generate a fresh phrase of the right length for `seedType` via the SDK's CSPRNG. */
export async function generateMnemonicFor(seedType: SeedType): Promise<string> {
  return KadenaWalletBuilder.generateMnemonic(WORD_COUNT_BY_SEED_TYPE[seedType]);
}

/**
 * Validate a candidate phrase for a SPECIFIC seed type, BEFORE any derivation or
 * encryption. Normalizes like {@link validateMnemonic}, then:
 *   1. exactly the type's word count, else `word-count`;
 *   2. koala: a valid BIP39 phrase; chainweaver/eckowallet: every word in the
 *      English wordlist AND the SDK's Kadena checksum — else `invalid-words`.
 * Never throws: an SDK error on a malformed phrase is reported as invalid-words.
 */
export async function validateMnemonicFor(
  words: string[] | string,
  seedType: SeedType,
): Promise<MnemonicValidation> {
  const { kept, hadEmptyToken } = tokenize(words);
  if (hadEmptyToken || kept.length !== WORD_COUNT_BY_SEED_TYPE[seedType]) {
    return { valid: false, reason: 'word-count' };
  }

  const phrase = kept.join(' ');
  if (seedType === 'koala') {
    return bip39.validateMnemonic(phrase, wordlist)
      ? { valid: true }
      : { valid: false, reason: 'invalid-words' };
  }

  if (!kept.every((word) => ENGLISH_WORDS.has(word))) {
    return { valid: false, reason: 'invalid-words' };
  }
  try {
    return (await KadenaWalletBuilder.isValidMnemonic(phrase, seedType))
      ? { valid: true }
      : { valid: false, reason: 'invalid-words' };
  } catch {
    return { valid: false, reason: 'invalid-words' };
  }
}

/**
 * Key #0's public key for a phrase, or `null` if the phrase is not valid for
 * `seedType`. Drives the live preview in the add-seed flow.
 *
 * Derives with an EMPTY password, exactly as Ouronet Codex does. The public key
 * does not depend on the password (only the sealed secret does, and the preview
 * discards it), but the cost does: with a non-empty password a 12-word
 * Chainweaver/EckoWallet preview measured ~1.5-3s against ~0.3s, freezing the
 * popup on every "Generate new phrase".
 *
 * Only the cheap checks (word count, wordlist) run first. The SDK verifies the
 * checksum itself while deriving, so it is not checked twice.
 */
export async function previewSeedPublicKey(
  mnemonic: string,
  seedType: SeedType,
): Promise<string | null> {
  const { kept, hadEmptyToken } = tokenize(mnemonic);
  if (hadEmptyToken || kept.length !== WORD_COUNT_BY_SEED_TYPE[seedType]) return null;
  if (!kept.every((word) => ENGLISH_WORDS.has(word))) return null;
  try {
    const { publicKey } = await KadenaWalletBuilder.createWalletPairFromMnemonic(
      '',
      kept.join(' '),
      0,
      seedType,
    );
    return publicKey;
  } catch {
    // A bad checksum: the SDK rejects the phrase for this seed type.
    return null;
  }
}
