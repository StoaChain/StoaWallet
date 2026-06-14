import type { ReactNode } from 'react';

import { TokenGlyph, type TokenGlyphProps } from '../theme/TokenGlyph';

/**
 * UrStoa-namespace token marks — thin, named convenience wrappers over the
 * shared `<TokenGlyph>` primitive (REUSED, not re-implemented; it already
 * carries the canonical glyphs ✦ silver / ❖ gold).
 *
 *   UrStoaMark → ✦ silver (#c7cdd4) — an UrStoa-denominated figure.
 *   StoaMark   → ❖ gold   (#d4af37) — a STOA-denominated figure.
 *
 * Per DESIGN.md a STOA-denominated figure (vault earnings) ALWAYS uses the gold
 * ❖ even on a UrStoa card, so the vault-earnings number renders `<StoaMark />`
 * while the holdings/stake numbers render `<UrStoaMark />`.
 */
type MarkProps = Omit<TokenGlyphProps, 'token'>;

/** The silver UrStoa unit mark (✦). */
export function UrStoaMark(props: MarkProps): ReactNode {
  return <TokenGlyph token="UrStoa" {...props} />;
}

/** The gold STOA unit mark (❖) — used for STOA-denominated vault earnings. */
export function StoaMark(props: MarkProps): ReactNode {
  return <TokenGlyph token="STOA" {...props} />;
}
