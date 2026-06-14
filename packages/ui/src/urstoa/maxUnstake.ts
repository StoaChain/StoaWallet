/**
 * Last-staker-floor `maxUnstake` for the UrStoa vault.
 *
 * The vault cannot be drained to empty by its last staker: when the user's
 * stake is the whole vault (`userStaked >= vaultTotal`) the maximum they may
 * unstake is `userStaked - 1.0`; otherwise they may unstake their full stake.
 *
 * Two hard correctness requirements, both implemented with PURE string-decimal
 * arithmetic (the codebase/SDK ships no BigNumber/Decimal dependency, and we do
 * not add one):
 *
 *   - Comparison is decimal-magnitude, NOT JS lexicographic: `"9" >= "100"`
 *     compares as `false` (9 < 100), where a string compare would wrongly
 *     return `true`.
 *   - Subtraction is decimal-safe, NOT JS float: `"10" - "1.0"` is "9", never
 *     reintroducing the "10" -> "1" magnitude bug.
 *
 * Fail-closed: if either input is missing, non-finite, or otherwise not a
 * non-negative plain decimal (e.g. a failed `getUrStoaBalance(VAULT_ADDRESS)`
 * read surfacing as null / "null" / "NaN"), unstake is BLOCKED. The floor is
 * never lifted and nothing is coerced to 0 — that would permit a full-drain
 * unstake.
 */

/** Discriminated result the consuming hook branches on. */
export type MaxUnstakeResult =
  | { readonly ok: true; readonly max: string }
  | { readonly ok: false; readonly reason: 'vault-total-unknown' };

const FAIL_CLOSED: MaxUnstakeResult = { ok: false, reason: 'vault-total-unknown' };

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** Split a validated non-negative decimal string into integer + fraction parts. */
function split(value: string): { int: string; frac: string } {
  const dot = value.indexOf('.');
  if (dot === -1) return { int: stripLeadingZeros(value), frac: '' };
  return { int: stripLeadingZeros(value.slice(0, dot)), frac: value.slice(dot + 1) };
}

function stripLeadingZeros(int: string): string {
  const stripped = int.replace(/^0+(?=\d)/, '');
  return stripped === '' ? '0' : stripped;
}

function stripTrailingZeros(frac: string): string {
  return frac.replace(/0+$/, '');
}

/** Canonicalize a validated decimal: stripped leading-zero int + stripped trailing-zero frac. */
function canonical(value: string): string {
  const { int, frac } = split(value);
  const trimmed = stripTrailingZeros(frac);
  return trimmed === '' ? int : `${int}.${trimmed}`;
}

/**
 * Decimal-magnitude compare of two non-negative decimal strings.
 * Returns -1 (a<b), 0 (a==b), or 1 (a>b). No float, no lexicographic compare.
 */
function compareDecimal(a: string, b: string): number {
  const pa = split(a);
  const pb = split(b);

  if (pa.int.length !== pb.int.length) return pa.int.length < pb.int.length ? -1 : 1;
  if (pa.int !== pb.int) return pa.int < pb.int ? -1 : 1;

  const fa = stripTrailingZeros(pa.frac);
  const fb = stripTrailingZeros(pb.frac);
  const len = Math.max(fa.length, fb.length);
  const fap = fa.padEnd(len, '0');
  const fbp = fb.padEnd(len, '0');
  if (fap === fbp) return 0;
  return fap < fbp ? -1 : 1;
}

/**
 * Subtract 1.0 from a non-negative decimal string, decimal-safely.
 * Caller guarantees `value >= 1` (only called when userStaked >= vaultTotal
 * and the floor applies). Preserves the fractional part exactly.
 */
function subtractOne(value: string): string {
  const { int, frac } = split(value);

  // Subtract 1 from the integer part via string digit arithmetic (no float).
  const digits = int.split('');
  let i = digits.length - 1;
  while (i >= 0) {
    if (digits[i] !== '0') {
      digits[i] = String(Number(digits[i]) - 1);
      break;
    }
    digits[i] = '9';
    i -= 1;
  }
  const newInt = stripLeadingZeros(digits.join(''));

  const trimmedFrac = stripTrailingZeros(frac);
  return trimmedFrac === '' ? newInt : `${newInt}.${trimmedFrac}`;
}

/** True when `value` is a usable non-negative plain decimal string. */
function isUsable(value: string | null | undefined): value is string {
  return typeof value === 'string' && DECIMAL_RE.test(value.trim());
}

export function maxUnstake(
  userStaked: string | null | undefined,
  vaultTotal: string | null | undefined,
): MaxUnstakeResult {
  if (!isUsable(userStaked) || !isUsable(vaultTotal)) {
    return FAIL_CLOSED;
  }

  const staked = userStaked.trim();
  const total = vaultTotal.trim();

  // Last-staker floor applies only when the user's stake is the whole vault.
  if (compareDecimal(staked, total) >= 0) {
    // A sole staker of a SUB-1.0 vault cannot satisfy the 1.0 floor: there is
    // no `userStaked - 1.0 >= 0` answer, and `subtractOne` would borrow past
    // the integer part (e.g. "0.5" -> "9.5"), lifting the floor and permitting
    // a full-drain of the vault to empty. Fail closed instead — the unstake is
    // BLOCKED. `subtractOne` is only ever reached with `staked >= 1`.
    if (compareDecimal(staked, '1') < 0) {
      return FAIL_CLOSED;
    }
    return { ok: true, max: subtractOne(staked) };
  }

  return { ok: true, max: canonical(staked) };
}
