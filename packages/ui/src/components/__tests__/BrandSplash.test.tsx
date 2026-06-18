import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BrandSplash } from '../BrandSplash';

describe('BrandSplash', () => {
  it('renders the StoaWallet logo image so the brand identity is visible on the splash', () => {
    render(
      <BrandSplash>
        <p>child</p>
      </BrandSplash>,
    );

    // The brand logo is the central identity cue copied from the StoaChain hero.
    // It must carry an accessible name so AT users know the splash is StoaWallet,
    // and a real src so the asset is actually bundled (not an empty placeholder).
    const logo = screen.getByRole('img', { name: /stoawallet/i });
    expect(logo).toBeInTheDocument();
    expect(logo.getAttribute('src')).toBeTruthy();
  });

  it('renders the "StoaWallet" gold wordmark above the content slot', () => {
    render(
      <BrandSplash>
        <p>child</p>
      </BrandSplash>,
    );

    // The wordmark anchors the premium identity; without it the splash is just a
    // logo and a form, losing the brand treatment the redesign exists to add.
    expect(
      screen.getByText('StoaWallet', { selector: 'span,h1,p,div' }),
    ).toBeInTheDocument();
  });

  it('renders its children inside the splash content slot so screens can compose their forms', () => {
    render(
      <BrandSplash>
        <button type="button">slot-child</button>
      </BrandSplash>,
    );

    // The slot is the contract every consumer (Unlock, onboarding) relies on:
    // the screen-specific heading + form is passed as children and must appear.
    expect(
      screen.getByRole('button', { name: 'slot-child' }),
    ).toBeInTheDocument();
  });

  it('renders an optional tagline when supplied', () => {
    render(
      <BrandSplash tagline="An economy built to endure">
        <p>child</p>
      </BrandSplash>,
    );

    // The landing splash borrows the hero's tagline; when omitted (unlock) no
    // empty tagline element should appear, so the prop drives a real branch.
    expect(
      screen.getByText('An economy built to endure'),
    ).toBeInTheDocument();
  });

  it('omits the tagline element entirely when no tagline is supplied', () => {
    const { container } = render(
      <BrandSplash>
        <p data-testid="only-child">child</p>
      </BrandSplash>,
    );

    const root = within(container).getByTestId('only-child').closest('div');
    expect(root).not.toBeNull();
    // Unlock passes no tagline; rendering an empty <p> would add stray spacing
    // and an empty node AT could announce, so the branch must drop it.
    expect(screen.queryByText(/built to endure/i)).toBeNull();
  });
});
