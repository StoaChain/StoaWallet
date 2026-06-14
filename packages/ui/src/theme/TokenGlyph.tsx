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
}: TokenGlyphProps): ReactNode {
  const { glyph, color } = tokenGlyphs[token];
  return (
    <span
      role="img"
      aria-label={ariaLabel ?? token}
      data-token={token}
      className={className}
      style={{ color, ...style }}
    >
      {glyph}
    </span>
  );
}
