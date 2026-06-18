import { type Balances } from '@stoawallet/core';
import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { StoaTab } from '../StoaTab';

/**
 * The Stoa tab: a 10-chain selector, the active-account line, the dual balance
 * (all-chain SUM hero + selected-chain sub), and the Send/Receive/Cross-chain/
 * Miner action row that opens the existing views as routed sub-views. The
 * balances are injected off-network via the `getBalances` seam so the tab renders
 * deterministically without the live RPC.
 */

const ACCOUNT = 'k:625a1234567890abcdef1234567890abcdef1234567890abcdef1234567890df74';

/** A stub balances read: chain 0 funded, chain 3 a distinct amount, rest zero. */
function stubBalances(): Promise<Balances> {
  const chains: Balances = {};
  for (let i = 0; i < 10; i += 1) {
    chains[String(i)] = { balance: '0.000000000000', exists: true };
  }
  chains['0'] = { balance: '1027589.224000000000', exists: true };
  chains['3'] = { balance: '42.500000000000', exists: true };
  return Promise.resolve(chains);
}

function renderStoaTab(
  opts: { onBackChange?: (back: (() => void) | null) => void } = {},
) {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  return render(
    <WalletProvider storage={storage} keyVault={keyVault}>
      <StoaTab
        account={ACCOUNT}
        getBalances={stubBalances}
        onBackChange={opts.onBackChange}
      />
    </WalletProvider>,
  );
}

/** The latest non-null back handler the tab registered via onBackChange. */
function latestBack(spy: ReturnType<typeof vi.fn>): (() => void) | undefined {
  return spy.mock.calls
    .map((c) => c[0] as (() => void) | null)
    .filter((b): b is () => void => typeof b === 'function')
    .at(-1);
}

describe('StoaTab', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the active account line: index + full-width k: address with gold first-3/last-3, middle-truncated by CSS', async () => {
    await act(async () => {
      renderStoaTab();
    });
    // The account line shows the HD index (#0) and the FULL k: address (CSS
    // middle-truncates visually — the full key stays in the DOM, recoverable via
    // the title), with the recognizable ends highlighted gold: the first 3 hex
    // after `k:` and the last 3 hex live in dedicated spans. Plus a copy affordance.
    const acct = await screen.findByTestId('card-account');
    expect(acct.textContent).toMatch(/#0/);
    expect(screen.getByTestId('addr-head').textContent).toBe('625');
    expect(screen.getByTestId('addr-tail').textContent).toBe('f74');
    // The whole address (not a hard-truncated stub) is present + recoverable.
    expect(acct.querySelector('[title^="k:"]')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: /copy address/i }),
    ).toBeInTheDocument();
  });

  it('wraps the account + chain selector + balance + actions in a single bordered card', async () => {
    await act(async () => {
      renderStoaTab();
    });
    // One rectangle: the card contains the account line, the chain selector, the
    // dual balance, and the action row — the MultiversX-style single card.
    const card = await screen.findByTestId('stoa-balance-card');
    expect(within(card).getByTestId('card-account')).toBeInTheDocument();
    expect(within(card).getByTestId('stoa-balance-hero')).toBeInTheDocument();
    expect(within(card).getByTestId('stoa-actions')).toBeInTheDocument();
  });

  it('keeps the chain selector COLLAPSED as a single line until clicked', async () => {
    await act(async () => {
      renderStoaTab();
    });
    await screen.findByTestId('stoa-balance-hero');
    // Closed state: a single-line field showing the selected chain, and NO
    // option list rendered (the future-proof collapsed combobox, not a grid).
    const toggle = screen.getByRole('button', { name: /chain 0/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('opens the chain dropdown with a search input and a scrollable option list on click', async () => {
    await act(async () => {
      renderStoaTab();
    });
    await screen.findByTestId('stoa-balance-hero');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /chain 0/i }));
    });
    // Opened: a search input at top + the full list of chains as options.
    expect(
      screen.getByRole('searchbox', { name: /chain/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
  });

  it('shows the all-chain SUM as the hero balance', async () => {
    await act(async () => {
      renderStoaTab();
    });
    // SUM = 1027589.224 + 42.5 = 1027631.724 → hero formats the grouped integer.
    const hero = await screen.findByTestId('stoa-balance-hero');
    expect(hero.textContent).toContain('1.027.631,724');
  });

  it('defaults the selected chain to Chain 0 and shows its balance below the hero', async () => {
    await act(async () => {
      renderStoaTab();
    });
    // No chain is typed yet → the default selection (Chain 0) drives the
    // per-chain sub figure (1027589.224...).
    const sub = await screen.findByTestId('stoa-balance-chain');
    expect(sub.textContent).toContain('1.027.589,224');
    expect(sub.textContent).toContain('Chain 0');
  });

  it('filters the chain list as a number is typed and selects the matching chain', async () => {
    await act(async () => {
      renderStoaTab();
    });
    await screen.findByTestId('stoa-balance-hero');
    // Open the collapsed dropdown, then type into its search box.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /chain 0/i }));
    });
    const search = screen.getByRole('searchbox', {
      name: /chain/i,
    }) as HTMLInputElement;

    // Typing "3" filters the dropdown to chains whose number contains 3 — the
    // user can find a chain by number without scrolling a fixed list (future-
    // proof for many chains).
    await act(async () => {
      fireEvent.change(search, { target: { value: '3' } });
    });
    const options = screen.getAllByRole('option');
    const optionLabels = options.map((o) => o.textContent ?? '');
    expect(optionLabels).toContain('Chain 3');
    expect(optionLabels).not.toContain('Chain 0');

    // Picking Chain 3 from the filtered list shows ITS balance (42.5), not
    // chain 0's — proving the typed-number selection drives the per-chain read.
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /chain 3/i }));
    });
    expect(screen.getByTestId('stoa-balance-chain').textContent).toContain(
      '42,5',
    );
  });

  it('opens the Send view when Send is clicked, REGISTERING a back handler with the shell (header)', async () => {
    const onBackChange = vi.fn();
    await act(async () => {
      renderStoaTab({ onBackChange });
    });
    await screen.findByTestId('stoa-balance-hero');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    });

    // The Send form mounts as a sub-view; the back affordance now lives in the
    // app header — the tab registers its handler via onBackChange (no in-body row).
    expect(screen.getByTestId('stoa-subview')).toBeInTheDocument();
    expect(latestBack(onBackChange)).toBeTypeOf('function');
  });

  it('returns to the overview when the registered back handler fires', async () => {
    const onBackChange = vi.fn();
    await act(async () => {
      renderStoaTab({ onBackChange });
    });
    await screen.findByTestId('stoa-balance-hero');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^receive$/i }));
    });
    expect(screen.getByTestId('stoa-subview')).toBeInTheDocument();

    // Fire the back handler the tab registered (the header back button invokes it).
    const back = latestBack(onBackChange);
    await act(async () => {
      back?.();
    });
    // Back to the overview: the balance hero is shown again, the sub-view is gone.
    expect(screen.queryByTestId('stoa-subview')).toBeNull();
    expect(screen.getByTestId('stoa-balance-hero')).toBeInTheDocument();
  });

  it('exposes Send, Receive, Cross-chain and Miner actions', async () => {
    await act(async () => {
      renderStoaTab();
    });
    await screen.findByTestId('stoa-balance-hero');
    expect(screen.getByRole('button', { name: /^send$/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^receive$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /cross-chain/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^miner$/i })).toBeInTheDocument();
  });

  it('renders the four actions as an icon-button row (icon glyph + label beneath)', async () => {
    await act(async () => {
      renderStoaTab();
    });
    await screen.findByTestId('stoa-balance-hero');
    // The compact icon-chip row replaces the four large rectangular buttons:
    // each action carries an inline SVG icon plus its label, so the row reads as
    // a MultiversX-style chip strip rather than full-width blocks.
    const row = screen.getByTestId('stoa-actions');
    expect(row.querySelectorAll('svg').length).toBe(4);
    expect(
      row.querySelectorAll('button[aria-label], button').length,
    ).toBe(4);
  });

  it('opens the Cross-chain view when Cross-chain is clicked', async () => {
    await act(async () => {
      renderStoaTab();
    });
    await screen.findByTestId('stoa-balance-hero');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /cross-chain/i }));
    });
    // The cross-chain action opens the existing form as a routed sub-view.
    expect(screen.getByTestId('stoa-subview')).toBeInTheDocument();
  });

  it('opens the Miner view when Miner is clicked', async () => {
    await act(async () => {
      renderStoaTab();
    });
    await screen.findByTestId('stoa-balance-hero');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^miner$/i }));
    });
    expect(screen.getByTestId('stoa-subview')).toBeInTheDocument();
  });
});
