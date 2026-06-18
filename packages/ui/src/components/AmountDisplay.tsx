import { type CSSProperties, type ReactNode } from 'react';

import { TokenGlyph } from '../theme/TokenGlyph';
import styles from './AmountDisplay.module.css';

/**
 * The trailing glyph's font-size, matched to the number height for its size so
 * the ❖/✦ mark is as tall as the balance digits (hero glyph for a hero amount,
 * sub glyph for a sub amount) rather than a subordinate fraction-size mark. The
 * sizes mirror the `.hero .value` / `.sub .value` font-sizes in the module CSS.
 */
function glyphSizeStyle(_size: 'hero' | 'sub'): CSSProperties {
  // Both the hero and the per-chain (sub) glyph render at the SAME (hero) height,
  // so the per-chain ❖/✦ mark matches the total's mark rather than shrinking.
  void _size;
  return { fontSize: '32px', lineHeight: 1.1 };
}

/**
 * Group a run of digits into 3-by-3 blocks separated by a thin space, e.g.
 * "234244172" → "234 244 172", so the trailing decimal digits read clearly.
 */
function groupBy3(digits: string): string {
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ');
}

/** STOA is displayed at 12 fractional digits; UrStoa is a 3-decimal token. */
const STOA_DECIMALS = 12;
const URSTOA_DECIMALS = 3;
/** The leading fractional digits shown at full size; the rest render half-size. */
const FULL_FRACTION_DIGITS = 3;

export interface AmountDisplayProps {
  /**
   * The decimal amount as a STRING (12-decimal precision). Operated on as a
   * string end-to-end — never parsed through `Number`, so no rounding/drift. A
   * `null` (or `undefined`) amount is an unknown/failed read and renders a
   * distinct dash, NOT a misleading "0".
   */
  readonly amount: string | null | undefined;
  /** Which token mark to render alongside: gold ❖ STOA (default) or silver ✦ UrStoa. */
  readonly glyph?: 'stoa' | 'urstoa';
  /** `hero` = the large all-chain sum; `sub` = the smaller per-chain/wallet line. */
  readonly size?: 'hero' | 'sub';
  /**
   * Horizontal alignment of the whole figure (main line, beneath decimals, and
   * glyph). `right` flushes everything to the right edge so a balance column
   * reads as a right-aligned money column; defaults to `left`.
   */
  readonly align?: 'left' | 'right';
}

/**
 * Format a non-negative decimal string into European money form WITHOUT any
 * float round-trip: `.` groups the integer by thousands, `,` is the decimal
 * mark, and the fraction is padded/clamped to exactly `decimals` digits (12 for
 * STOA, 3 for the UrStoa token).
 *
 * Returns the grouped integer, the leading full-size fraction digits, and the
 * trailing half-size fraction digits as separate strings so the caller can
 * render the size split.
 */
function formatParts(
  amount: string,
  decimals: number,
): {
  integer: string;
  fullFraction: string;
  smallFraction: string;
} {
  const dotIndex = amount.indexOf('.');
  const rawInt = dotIndex === -1 ? amount : amount.slice(0, dotIndex);
  const rawFraction = dotIndex === -1 ? '' : amount.slice(dotIndex + 1);

  // Strip leading zeros but keep a single zero, then group by 3 from the right.
  const normalizedInt = rawInt.replace(/^0+(?=\d)/, '') || '0';
  const integer = normalizedInt.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  // Pad/clamp the fraction to exactly `decimals` (12 for STOA, 3 for UrStoa) so
  // the full/half split is always exact for the denomination.
  const fraction = rawFraction.slice(0, decimals).padEnd(decimals, '0');
  const full = Math.min(FULL_FRACTION_DIGITS, decimals);

  return {
    integer,
    fullFraction: fraction.slice(0, full),
    smallFraction: fraction.slice(full),
  };
}

/**
 * Render a STOA/UrStoa decimal amount per the redesign's money spec: European
 * separators (`.` thousands, `,` decimal), the full 12 decimals, and a token
 * glyph alongside, color-coded by denomination (STOA gold / UrStoa silver).
 *
 * Layout by size:
 *   - `hero`: the MAIN line is bounded — `{grouped-integer},{first3}` + the glyph
 *     at the number height — so the glyph always stays inside the card. The
 *     remaining 9 decimals render on a small dimmed line BENEATH. The full
 *     12-decimal grouped value is the element `title` (hover) so no precision is
 *     lost.
 *   - `sub`: compact one line — `{integer},{first3}` at normal size, the trailing
 *     9 at half size inline, then the glyph (small enough not to overflow).
 *
 * `align="right"` flushes the whole figure (main line, beneath decimals, glyph)
 * to the right so it reads as a right-aligned money column.
 *
 * Pure presentation over a STRING input — the value is never coerced through
 * `Number`, so a 12-decimal balance keeps every digit. A `null`/`undefined`
 * amount is a distinct unknown dash, never a coerced "0".
 */
export function AmountDisplay({
  amount,
  glyph = 'stoa',
  size = 'sub',
  align = 'left',
}: AmountDisplayProps): ReactNode {
  const sizeClass = size === 'hero' ? styles.hero : styles.sub;
  const alignClass = align === 'right' ? styles.alignRight : styles.alignLeft;
  const token = glyph === 'urstoa' ? 'UrStoa' : 'STOA';
  // The amount text is color-coded by denomination: STOA in gold, UrStoa in
  // silver. Both the value class (and its dimmed fractions) and the trailing
  // glyph inherit this hue. `data-token-color` exposes the choice for tests/styling.
  const colorClass = glyph === 'urstoa' ? styles.urstoaColor : styles.stoaColor;
  // The trailing ❖/✦ mark renders at the NUMBER's height (hero or sub), not a
  // subordinate fraction size, so it reads as part of the balance figure.
  const glyphSizeClass = size === 'hero' ? styles.glyphHero : styles.glyphSub;

  const glyphNode = (
    <TokenGlyph
      token={token}
      className={`${styles.glyph} ${glyphSizeClass}`}
      style={glyphSizeStyle(size)}
      data-glyph-size={size}
    />
  );

  if (amount === null || amount === undefined) {
    return (
      <span
        className={`${styles.amount} ${sizeClass} ${colorClass} ${alignClass}`}
        data-testid="amount-display"
        data-token-color={glyph}
        data-align={align}
      >
        <span className={styles.unknown}>—</span>
        {glyphNode}
      </span>
    );
  }

  // STOA shows 12 decimals; UrStoa is a 3-decimal token.
  const decimals = glyph === 'urstoa' ? URSTOA_DECIMALS : STOA_DECIMALS;
  const { integer, fullFraction, smallFraction } = formatParts(amount, decimals);
  // The full grouped 12-decimal figure, recoverable on hover even when the hero
  // split moves the trailing 9 decimals onto a separate line.
  const fullTitle = `${integer},${fullFraction}${smallFraction}`;

  if (size === 'hero') {
    return (
      <span
        className={`${styles.amount} ${sizeClass} ${colorClass} ${alignClass}`}
        data-testid="amount-display"
        data-token-color={glyph}
        data-align={align}
        title={fullTitle}
      >
        {/*
         * The trailing 9 decimals render ABOVE the main figure (gold, grouped
         * 3-by-3) — a fine-precision header line over the bounded main number.
         */}
        <span
          className={styles.beneathFraction}
          data-testid="amount-beneath-fraction"
        >
          {groupBy3(smallFraction)}
        </span>
        <span className={styles.heroMain} data-testid="amount-hero-main">
          <span className={styles.value}>
            {integer},{fullFraction}
          </span>
          {glyphNode}
        </span>
      </span>
    );
  }

  return (
    <span
      className={`${styles.amount} ${sizeClass} ${colorClass} ${alignClass}`}
      data-testid="amount-display"
      data-token-color={glyph}
      data-align={align}
      title={fullTitle}
    >
      <span className={styles.value} data-testid="amount-sub-value">
        {`${integer},${fullFraction}${smallFraction}`}
      </span>
      {glyphNode}
    </span>
  );
}
