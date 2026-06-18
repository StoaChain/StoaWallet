import type { CSSProperties, ReactNode } from 'react';

import { tokenGlyphs, type TokenSymbol } from './tokens';

/**
 * Shared design-token primitive (XP-18c) — the wallet's canonical token marks.
 * The glyph denotes the denomination and is rendered in the token's color:
 *   STOA   → ❖ gold   (#d4af37)
 *   UrStoa → ✦ silver (#c7cdd4)
 *
 * Reused by balances (Phase 3), send (Phase 4), miner aggregation (Phase 11 — STOA ❖),
 * and UrStoa holdings/vault (Phase 12 — UrStoa ✦, vault earnings in STOA ❖). Per DESIGN.md,
 * an amount denominated in STOA always uses the gold ❖ even on a UrStoa card.
 */
export interface TokenGlyphProps {
  /** Which token's mark to render. */
  readonly token: TokenSymbol;
  /** Optional accessible label; defaults to the token symbol (e.g. "STOA"). */
  readonly 'aria-label'?: string;
  /** Optional extra class for layout. */
  readonly className?: string;
  /** Optional style override (color is set from the token by default). */
  readonly style?: CSSProperties;
  /**
   * Optional size marker forwarded as a `data-glyph-size` attribute. Lets a
   * consumer (e.g. AmountDisplay) tag the rendered mark with the number size it
   * was matched to, without leaking layout-size logic into this primitive.
   */
  readonly 'data-glyph-size'?: string;
  /**
   * Render the mark as PURELY decorative — `aria-hidden`, no `role="img"`/label —
   * for places where adjacent text already names the token (e.g. a "Collect ❖"
   * modal title). Avoids a duplicate accessible "STOA"/"UrStoa" image next to the
   * meaningful figure. Defaults to false (the labeled unit-mark behavior).
   */
  readonly decorative?: boolean;
}

/**
 * Inline unit marker: the colored glyph for a token. Use after an amount —
 * `1,940.2366 <TokenGlyph token="STOA" />` (gold), `62.500 <TokenGlyph token="UrStoa" />` (silver).
 */
export function TokenGlyph({
  token,
  'aria-label': ariaLabel,
  className,
  style,
  'data-glyph-size': dataGlyphSize,
  decorative = false,
}: TokenGlyphProps): ReactNode {
  const { glyph, color } = tokenGlyphs[token];
  // Decorative marks carry no accessible role/name — adjacent text names the token.
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': ariaLabel ?? token };
  return (
    <span
      {...a11y}
      data-token={token}
      data-glyph-size={dataGlyphSize}
      className={className}
      style={{ color, ...style }}
    >
      {glyph}
    </span>
  );
}
