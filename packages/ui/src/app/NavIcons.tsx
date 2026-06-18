import { type ReactNode } from 'react';

import { tokenGlyphs } from '../theme/tokens';

/**
 * Inline SVG icons for the floating bottom nav — no icon dependency (mirrors the
 * inline-icon approach already used elsewhere in the package). Each is a 22px
 * stroke icon that inherits the nav button's `currentColor` (gold when active).
 */

interface IconProps {
  readonly className?: string;
}

function svgProps(className?: string) {
  return {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className,
  };
}

/**
 * A token glyph used as a nav icon. It is `aria-hidden` (the nav button's label
 * span supplies the accessible name) and rendered in the token's single-source
 * palette color — the brand identity carries into the nav. STOA → ❖ gold,
 * UrStoa → ✦ silver.
 */
function GlyphIcon({
  token,
  className,
}: IconProps & { readonly token: keyof typeof tokenGlyphs }): ReactNode {
  const { glyph, color } = tokenGlyphs[token];
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{ color, fontSize: 20, lineHeight: 1 }}
    >
      {glyph}
    </span>
  );
}

/** Stoa: the canonical ❖ gold token mark. */
export function StoaIcon({ className }: IconProps): ReactNode {
  return <GlyphIcon token="STOA" className={className} />;
}

/** UrStoa: the canonical ✦ silver token mark. */
export function UrStoaIcon({ className }: IconProps): ReactNode {
  return <GlyphIcon token="UrStoa" className={className} />;
}

/** Send: an up-arrow leaving the wallet. */
export function SendIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

/** Receive: a down-arrow into the wallet. */
export function ReceiveIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  );
}

/** Cross-chain: a two-way shuffle between chains. */
export function CrossChainIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <path d="M7 4 3 8l4 4" />
      <path d="M3 8h13" />
      <path d="m17 20 4-4-4-4" />
      <path d="M21 16H8" />
    </svg>
  );
}

/** Miner: a pickaxe over a gem, the sweep/aggregation mark. */
export function MinerIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <path d="M6 3 3 6l4.5 4.5" />
      <path d="M3 6c4-2 9-2 13 1" />
      <path d="m11 9 10 10" />
      <path d="m18 16 3 3-2 2-3-3Z" />
    </svg>
  );
}

/** Fiat-Ramp: a banknote / buy-sell mark. */
export function FiatRampIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 9v.01" />
      <path d="M18 15v.01" />
    </svg>
  );
}

/** Advanced: sliders / controls. */
export function AdvancedIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <path d="M4 21v-7" />
      <path d="M4 10V3" />
      <path d="M12 21v-9" />
      <path d="M12 8V3" />
      <path d="M20 21v-5" />
      <path d="M20 12V3" />
      <path d="M2 14h4" />
      <path d="M10 8h4" />
      <path d="M18 16h4" />
    </svg>
  );
}

/** Side panel: a framed rectangle with a docked right column (the Chrome side panel). */
export function SidePanelIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </svg>
  );
}

/** Expand: arrows pushing out to opposite corners (open in a full tab). */
export function ExpandIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  );
}

/** Lock: a closed padlock. */
export function LockIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** Settings: a gear. */
export function SettingsIcon({ className }: IconProps): ReactNode {
  return (
    <svg {...svgProps(className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}
