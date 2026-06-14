import {
  formatDecimalForPact,
  mayComeWithDeimal,
  type ValidatedDecimal,
} from '@stoachain/stoa-core/pact';

/**
 * UrStoa on-chain decimal scale.
 *
 * Confirmed = 24: the UrStoa executors (`executeNativeUrStoaTransfer`,
 * stake/unstake) call the SDK `formatDecimalForPact(amount)` with NO scale
 * override, so they use the formatter's default of 24 fractional digits. The
 * stake/unstake executors accept `amount` as a pre-formatted decimal string at
 * this same scale. Naming/comments here reflect "24-decimal" to stay aligned
 * with the chain contract.
 */
export const URSTOA_DECIMALS = 24;

/**
 * Format an UrStoa amount as an injection-safe Pact decimal literal that ALWAYS
 * carries a decimal point.
 *
 * Delegates to the SDK `formatDecimalForPact` (NOT a hand-rolled
 * `.replace(/0+$/,...)` regex — that is the Phase-4 fund-corruption bug that
 * turned "10" into "1"). The SDK formatter validates the input against a
 * digits-only pattern (rejecting smuggled Pact code / shell metacharacters),
 * appends ".0" to integers so Pact lexes them as decimals, and truncates
 * (never rounds) beyond the 24-decimal scale.
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
