import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { palette } from '../../theme/tokens';
import { UrStoaMark, StoaMark } from '../glyph';

describe('UrStoa / STOA token marks', () => {
  it('renders the UrStoa mark as the silver ✦ (U+2726)', () => {
    render(<UrStoaMark />);
    const mark = screen.getByRole('img', { name: 'UrStoa' });
    expect(mark).toHaveTextContent('✦'); // ✦
    expect(mark).toHaveStyle({ color: palette.silver }); // #c7cdd4
  });

  it('renders the STOA mark as the gold ❖ (U+2756), used for STOA-denominated vault earnings', () => {
    // Per DESIGN.md a STOA-denominated figure (vault earnings) always uses the
    // gold ❖ even on a UrStoa card.
    render(<StoaMark />);
    const mark = screen.getByRole('img', { name: 'STOA' });
    expect(mark).toHaveTextContent('❖'); // ❖
    expect(mark).toHaveStyle({ color: palette.gold }); // #d4af37
  });
});
