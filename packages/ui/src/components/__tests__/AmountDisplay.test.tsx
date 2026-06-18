import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AmountDisplay } from '../AmountDisplay';

/**
 * AmountDisplay renders a 12-decimal STOA/UrStoa balance per the European money
 * format the redesign mandates: `.` groups thousands, `,` separates the decimal,
 * the first 3 fractional digits render full-size and the remaining 9 render
 * half-size. It operates on the decimal STRING end-to-end — never `Number` — so a
 * 12-decimal value never drifts. A null/unknown amount is a distinct dash, never a
 * misleading "0".
 */

/** The on-screen integer+fraction text, ignoring the glyph node. */
function amountText(): string {
  return screen.getByTestId('amount-display').textContent ?? '';
}

describe('AmountDisplay', () => {
  it('groups the integer part with "." thousands separators', () => {
    // 1027589 with no funds in the fraction must read 1.027.589 — proving the
    // grouping is by-3 from the right and uses a point, not a comma.
    render(<AmountDisplay amount="1027589.000000000000" />);
    expect(amountText()).toContain('1.027.589');
  });

  it('separates the integer and fraction with a "," (comma)', () => {
    // The European decimal mark is a comma; a value with a non-zero fraction must
    // carry exactly one comma between the grouped integer and the fraction.
    render(<AmountDisplay amount="1027589.224000000000" />);
    const text = amountText();
    expect(text).toContain('1.027.589,224');
    expect(text.match(/,/g)).toHaveLength(1);
  });

  it('shows all 12 fractional digits', () => {
    // The full precision is always displayed (no rounding/abbreviation): the 3
    // full-size digits plus the 9 half-size digits must total 12.
    render(<AmountDisplay amount="1027589.224123456789" />);
    expect(amountText()).toContain(',224123456789');
  });

  it('sub: renders all 12 decimals at a UNIFORM size (no 3/9 half-size split)', () => {
    // The per-chain (sub) line shows every decimal at the same size — no half-size
    // split. The full fraction lives in one uniform value span.
    render(<AmountDisplay amount="1027589.224123456789" />);
    expect(screen.queryByTestId('amount-small-fraction')).toBeNull();
    expect(screen.getByTestId('amount-sub-value')).toHaveTextContent(
      '1.027.589,224123456789',
    );
  });

  it('keeps the sub size on ONE line (no hero-style beneath split)', () => {
    // The sub line is compact — the whole figure (integer, all 12 decimals,
    // glyph) reads on one line. There is no beneath line and no half-size span.
    render(<AmountDisplay amount="1027589.224123456789" size="sub" glyph="stoa" />);
    const root = screen.getByTestId('amount-display');
    expect(screen.queryByTestId('amount-beneath-fraction')).toBeNull();
    expect(screen.queryByTestId('amount-small-fraction')).toBeNull();
    expect(within(root).getByTestId('amount-sub-value')).toHaveTextContent(
      '1.027.589,224123456789',
    );
  });

  it('hero: renders only the first 3 decimals + glyph on the MAIN line, the trailing 9 BENEATH', () => {
    // The hero line must stay bounded so the glyph never overflows the card: the
    // main line shows {grouped-integer},{first3} + the glyph; the remaining 9
    // decimals drop to a dimmed beneath line. Driven by the input's 12 decimals.
    render(<AmountDisplay amount="1027589.224123456789" size="hero" glyph="stoa" />);
    const main = screen.getByTestId('amount-hero-main');
    const beneath = screen.getByTestId('amount-beneath-fraction');
    // Main line carries the integer + first 3 decimals, but NOT the trailing 9.
    expect(main.textContent).toContain('1.027.589,224');
    expect(main.textContent).not.toContain('123456789');
    // The trailing 9 decimals live on the beneath line, gold + grouped 3-by-3
    // (whitespace-agnostic so the exact space glyph doesn't make the test brittle).
    expect(beneath.textContent?.replace(/\s/g, '')).toBe('123456789');
    expect(beneath.textContent).toMatch(/\d{3}\s\d{3}\s\d{3}/);
  });

  it('hero: the trailing glyph sits on the MAIN line (inside it), not on the beneath line', () => {
    // The glyph must stay on the bounded main line so it never drops below or
    // exits the card. The beneath line carries digits only — no glyph.
    render(<AmountDisplay amount="1027589.224123456789" size="hero" glyph="stoa" />);
    const main = screen.getByTestId('amount-hero-main');
    const beneath = screen.getByTestId('amount-beneath-fraction');
    expect(within(main).getByRole('img')).toHaveAttribute('data-token', 'STOA');
    expect(within(beneath).queryByRole('img')).toBeNull();
  });

  it('hero: exposes the FULL 12-decimal value as the element title so precision is hover-recoverable', () => {
    // Splitting the 9 decimals beneath must not lose precision: the full grouped
    // 12-decimal figure is the title attribute, recoverable on hover.
    render(<AmountDisplay amount="1027589.224123456789" size="hero" glyph="stoa" />);
    const root = screen.getByTestId('amount-display');
    expect(root.getAttribute('title')).toContain('1.027.589,224123456789');
  });

  it('right-aligns the whole display when align="right"', () => {
    // The StoaTab right-aligns the balance column; AmountDisplay must support a
    // right-aligned variant so the main line, beneath decimals and glyph all sit
    // flush-right. Exposed via data-align for the layout class.
    render(
      <AmountDisplay
        amount="1027589.224123456789"
        size="hero"
        glyph="stoa"
        align="right"
      />,
    );
    const root = screen.getByTestId('amount-display');
    expect(root.getAttribute('data-align')).toBe('right');
  });

  it('defaults to left alignment when align is omitted', () => {
    render(<AmountDisplay amount="1.0" size="hero" />);
    const root = screen.getByTestId('amount-display');
    expect(root.getAttribute('data-align')).toBe('left');
  });

  it('renders a zero balance as 0,000000000000 (never a dash)', () => {
    // A genuine zero balance is a real reading — it must format per the rules,
    // distinct from the null/unknown dash.
    render(<AmountDisplay amount="0.000000000000" />);
    const text = amountText();
    expect(screen.getByTestId('amount-sub-value')).toHaveTextContent(
      '0,000000000000',
    );
    expect(text).not.toContain('—');
  });

  it('renders null as a distinct dash, never "0"', () => {
    // An unknown/failed read must NOT read as an empty wallet. The dash is the
    // explicit unknown affordance.
    render(<AmountDisplay amount={null} />);
    const text = amountText();
    expect(text).toContain('—');
    expect(screen.queryByTestId('amount-small-fraction')).toBeNull();
  });

  it('pads a short fraction out to the full 12 digits', () => {
    // A balance the source reports with fewer than 12 fractional digits is still
    // displayed at full 12-digit precision (zero-padded), keeping the 3/9 split.
    render(<AmountDisplay amount="5.5" />);
    expect(screen.getByTestId('amount-sub-value')).toHaveTextContent(
      '5,500000000000',
    );
  });

  it('renders the STOA gold glyph by default', () => {
    render(<AmountDisplay amount="1.000000000000" />);
    const root = screen.getByTestId('amount-display');
    expect(within(root).getByRole('img')).toHaveAttribute('data-token', 'STOA');
  });

  it('renders the UrStoa silver glyph when glyph="urstoa"', () => {
    render(<AmountDisplay amount="1.000000000000" glyph="urstoa" />);
    const root = screen.getByTestId('amount-display');
    expect(within(root).getByRole('img')).toHaveAttribute(
      'data-token',
      'UrStoa',
    );
  });

  it('displays UrStoa at 3 decimals (not the 12-decimal STOA scale)', () => {
    // UrStoa is a 3-decimal token: 12-decimal precision in MUST display as 3.
    render(<AmountDisplay amount="1.234567890123" glyph="urstoa" size="sub" />);
    expect(screen.getByTestId('amount-sub-value')).toHaveTextContent('1,234');
  });

  it('still displays STOA at the full 12 decimals', () => {
    render(<AmountDisplay amount="1.234567890123" glyph="stoa" size="sub" />);
    expect(screen.getByTestId('amount-sub-value')).toHaveTextContent(
      '1,234567890123',
    );
  });

  it('color-codes a STOA amount gold (the brand token color)', () => {
    // The STOA denomination reads in gold so the user distinguishes it from the
    // silver UrStoa amounts at a glance. The value span carries the gold token color.
    render(<AmountDisplay amount="1.000000000000" glyph="stoa" />);
    const root = screen.getByTestId('amount-display');
    expect(root.getAttribute('data-token-color')).toBe('stoa');
  });

  it('color-codes an UrStoa amount silver (distinct from STOA gold)', () => {
    // Driven by glyph="urstoa": the value span reads silver, never the STOA gold.
    render(<AmountDisplay amount="1.000000000000" glyph="urstoa" />);
    const root = screen.getByTestId('amount-display');
    expect(root.getAttribute('data-token-color')).toBe('urstoa');
  });

  it('renders the trailing glyph at the number height (hero glyph for a hero amount)', () => {
    // The ❖/✦ mark must be as TALL as the balance number, not a subordinate 0.8em
    // mark. For the hero size the glyph carries the hero glyph-size class, so it
    // matches the large integer height.
    render(<AmountDisplay amount="1.000000000000" size="hero" glyph="stoa" />);
    const glyph = within(screen.getByTestId('amount-display')).getByRole('img');
    expect(glyph.getAttribute('data-glyph-size')).toBe('hero');
  });

  it('renders the trailing glyph at the sub number height for a sub amount', () => {
    render(<AmountDisplay amount="1.000000000000" size="sub" glyph="stoa" />);
    const glyph = within(screen.getByTestId('amount-display')).getByRole('img');
    expect(glyph.getAttribute('data-glyph-size')).toBe('sub');
  });

  it('marks the hero size distinctly from the sub size', () => {
    // The hero (all-chain sum) and sub (per-chain) sizes must be visually
    // distinguishable so the dual-balance hierarchy reads correctly.
    const { rerender } = render(<AmountDisplay amount="1.0" size="hero" />);
    const heroClass = screen.getByTestId('amount-display').className;
    rerender(<AmountDisplay amount="1.0" size="sub" />);
    const subClass = screen.getByTestId('amount-display').className;
    expect(heroClass).not.toBe(subClass);
  });
});
