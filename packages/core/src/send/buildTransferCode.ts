import { KADENA_NAMESPACE } from '@stoachain/ouronet-core/constants';

const MAX_FRACTION_DIGITS = 12;

/**
 * Normalize a decimal amount string into a valid Pact decimal literal.
 *
 * The amount is a STRING end-to-end on purpose: `Number(amount).toFixed(12)`
 * round-trips through a float and silently drifts the exact value, and the
 * reference `.replace(/0+$/, "")` regex strips a trailing-zero integer's
 * magnitude ("10" -> "1", a 10x fund-corruption bug). This is pure string
 * arithmetic instead — it never changes the magnitude of an integer.
 *
 * @throws if the input is empty, non-numeric, negative, or carries more than
 *         12 fractional digits.
 */
export function formatStoaAmount(amount: string): string {
  if (typeof amount !== 'string' || amount.trim() === '') {
    throw new Error('formatStoaAmount: amount must be a non-empty string');
  }

  const trimmed = amount.trim();

  // Plain decimal only: optional integer part, optional single dot, fraction.
  // Rejects scientific notation, signs, and stray characters loudly.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`formatStoaAmount: not a non-negative decimal: "${amount}"`);
  }

  const dotIndex = trimmed.indexOf('.');
  const intPart = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
  const rawFraction = dotIndex === -1 ? '' : trimmed.slice(dotIndex + 1);

  if (rawFraction.length > MAX_FRACTION_DIGITS) {
    throw new Error(
      `formatStoaAmount: more than ${MAX_FRACTION_DIGITS} fractional digits: "${amount}"`,
    );
  }

  // Trim redundant trailing zeros from the FRACTION only, never the integer
  // part, and always keep at least one fractional digit.
  const fraction = rawFraction.replace(/0+$/, '') || '0';

  // Strip leading zeros from the integer part while keeping a single zero.
  const normalizedInt = intPart.replace(/^0+(?=\d)/, '');

  return `${normalizedInt}.${fraction}`;
}

export interface BuildTransferCodeInput {
  sender: string;
  recipient: string;
  /** Amount as a decimal string; normalized internally via formatStoaAmount. */
  amount: string;
  isNewAccount: boolean;
}

export interface BuildTransferCodeResult {
  pactCode: string;
  payloadJson: string;
  /** Exactly two Pact-code capability strings, returned as an array. */
  caps: [string, string];
}

function stripKPrefix(address: string): string {
  if (!address.startsWith('k:')) {
    throw new Error(`buildTransferCode: address must be a k: account, got "${address}"`);
  }
  return address.slice(2);
}

/**
 * Build the same-chain transfer pact code, payload, and capabilities for a
 * StoaChain "Stoa Coin" transfer. Pure — performs no I/O.
 *
 * Uses the customized `coin.C_Transfer` / `coin.C_TransferAnew` verbs (never
 * the vanilla `coin.transfer` / `coin.transfer-create`). The cap amount and
 * the pact-code amount are the SAME normalized string.
 */
export function buildTransferCode(input: BuildTransferCodeInput): BuildTransferCodeResult {
  const { sender, recipient, amount, isNewAccount } = input;
  const decimalStr = formatStoaAmount(amount);

  let pactCode: string;
  let payloadJson: string;

  if (isNewAccount) {
    // The receiver keyset must guard the RECEIVER's pubkey, not the sender's,
    // otherwise the new account is controlled by the wrong party.
    const recipientPubkey = stripKPrefix(recipient);
    pactCode = `(coin.C_TransferAnew "${sender}" "${recipient}" (read-keyset "ks") ${decimalStr})`;
    payloadJson = JSON.stringify({ ks: { keys: [recipientPubkey], pred: 'keys-all' } });
  } else {
    pactCode = `(coin.C_Transfer "${sender}" "${recipient}" ${decimalStr})`;
    payloadJson = '{}';
  }

  const caps: [string, string] = [
    `(${KADENA_NAMESPACE}.DALOS.GAS_PAYER "" 0 0.0)`,
    `(coin.TRANSFER "${sender}" "${recipient}" ${decimalStr})`,
  ];

  return { pactCode, payloadJson, caps };
}
