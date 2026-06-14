/**
 * StoaWallet design tokens — single source of truth for the palette + token glyphs.
 * Mirrors DESIGN.md (extracted from the StoaWebsite Tailwind v4 @theme). Dark-only theme.
 * Consumed by `theme.css` (as CSS custom properties) and by components needing inline color values.
 */

export const palette = {
  /** app background (base) */
  dark: '#0a0a0a',
  /** cards / panels */
  surface: '#1a1a1a',
  /** borders / dividers */
  border: '#2d2d2d',
  /** primary text */
  light: '#f5f5f5',
  /** secondary / muted text */
  slate: '#9aa6b2',
  /** PRIMARY accent · brand · STOA */
  gold: '#d4af37',
  /** UrStoa accent (cool light) */
  silver: '#c7cdd4',
  /** info / links (blue) */
  accent: '#3b82f6',
} as const;

/** Semantic / status colors (Tailwind 400-weight), used as translucent pills. */
export const status = {
  success: '#4ade80', // green — success / live
  info: '#3b82f6', // blue — in-progress / info
  active: '#d4af37', // gold — active
  disabled: '#9aa6b2', // gray — disabled / planned
  danger: '#ef4444', // red — error / danger
} as const;

/** The wallet's canonical token marks. The glyph denotes the denomination and is rendered in the token's color. */
export const tokenGlyphs = {
  STOA: { glyph: '❖', color: palette.gold }, // ❖ — native Stoa Coin (gold)
  UrStoa: { glyph: '✦', color: palette.silver }, // ✦ — UrStoa holdings (silver)
} as const;

export type TokenSymbol = keyof typeof tokenGlyphs;

export const fontSans = 'Inter, sans-serif';
