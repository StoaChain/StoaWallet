import {
  formatDecimalForPact,
  mayComeWithDeimal,
  type ValidatedDecimal,
} from '@stoachain/stoa-core/pact';

/**
 * UrStoa on-chain decimal scale.
 *
 * UrStoa is a 3-DECIMAL token on-chain, so every amount the wallet formats,
 * validates, or displays for UrStoa uses 3 fractional digits. We pass this scale
 * EXPLICITLY to the SDK `formatDecimalForPact(amount, 3)` so a typed amount is
 * truncated (never rounded) to the chain's 3-decimal precision — rather than
 * relying on the formatter's 24-digit default, which would emit a literal with
 * more precision than UrStoa actually carries.
 */
export const URSTOA_DECIMALS = 3;

/**
 * Format an UrStoa amount as an injection-safe Pact decimal literal that ALWAYS
 * carries a decimal point, at UrStoa's 3-decimal scale.
 *
 * Delegates to the SDK `formatDecimalForPact` (NOT a hand-rolled
 * `.replace(/0+$/,...)` regex — that is the Phase-4 fund-corruption bug that
 * turned "10" into "1"). The SDK formatter validates the input against a
 * digits-only pattern (rejecting smuggled Pact code / shell metacharacters),
 * appends ".0" to integers so Pact lexes them as decimals, and truncates
 * (never rounds) beyond the 3-decimal scale.
 *
 * @throws if the input is not a non-negative plain decimal string.
 */
export function formatUrStoaAmount(amount: string): ValidatedDecimal {
  return formatDecimalForPact(amount, URSTOA_DECIMALS);
}

/**
 * Collapse a Pact decimal envelope to a display value.
 *
 * Pact reads return decimal values wrapped as `{ decimal: "…" }` (and integers
 * as plain numbers). This routes the value through the SDK `mayComeWithDeimal`
 * — the same path `supplyHoverVal` uses for the `urstoa-vault-earning-hover`
 * figure — instead of `String(obj)` (which would yield "[object Object]").
 *
 * The value is returned UNCHANGED when it is not a `{ decimal }` envelope: a
 * plain number `0` stays the number `0` (never stringified to "0"), a plain
 * string passes through, and `{ decimal: "1.5" }` unwraps to `"1.5"`.
 */
export function unwrapDecimal(v: unknown): string | number {
  return mayComeWithDeimal(v) as string | number;
}
