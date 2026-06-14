import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { type ChainBalanceStatus } from '../balanceModel';
import { ChainBalanceRow } from '../ChainBalanceRow';

describe('ChainBalanceRow', () => {
  it('labels the row with its chain id so the user can tell the 10 braided chains apart', () => {
    const status: ChainBalanceStatus = { kind: 'absent', chainId: 7 };
    render(<ChainBalanceRow status={status} />);

    // The chain identity must be visible regardless of state — chain 7 of 0..9.
    expect(screen.getByText(/chain\s*7\b/i)).toBeInTheDocument();
  });

  it('renders a funded balance with the gold STOA glyph and keeps the full 12-decimal value available', () => {
    const status: ChainBalanceStatus = {
      kind: 'funded',
      chainId: 3,
      balance: '1234.567890123456',
    };
    render(<ChainBalanceRow status={status} />);

    const row = screen.getByTestId('chain-balance-row');

    // The amount is shown (display may abbreviate, but the leading digits stay).
    expect(within(row).getByText(/1234\.5678/)).toBeInTheDocument();

    // The gold STOA unit marker accompanies the amount — denominates it as STOA.
    expect(within(row).getByRole('img', { name: 'STOA' })).toBeInTheDocument();

    // Stoa Coin's full 12-decimal precision must survive even if the visible
    // text is abbreviated for layout — exposed via a full-value affordance.
    expect(within(row).getByTestId('chain-balance-value')).toHaveAttribute(
      'data-full-value',
      '1234.567890123456',
    );
  });

  it('renders a zero balance as an explicit "0" the user can read as an existing empty account', () => {
    const status: ChainBalanceStatus = {
      kind: 'zero',
      chainId: 1,
      balance: '0.000000000000',
    };
    render(<ChainBalanceRow status={status} />);

    const row = screen.getByTestId('chain-balance-row');
    // A zero account exists and holds nothing — shown as a real "0" amount,
    // accompanied by the STOA unit marker, NOT an absent affordance.
    expect(within(row).getByTestId('chain-balance-value')).toHaveTextContent(
      '0',
    );
    expect(within(row).getByRole('img', { name: 'STOA' })).toBeInTheDocument();
    expect(
      within(row).queryByTestId('chain-balance-absent'),
    ).not.toBeInTheDocument();
  });

  it('renders an absent chain distinctly from a zero balance — never a "0" the user could mistake for an empty account', () => {
    const absent: ChainBalanceStatus = { kind: 'absent', chainId: 4 };
    const { unmount } = render(<ChainBalanceRow status={absent} />);

    const absentRow = screen.getByTestId('chain-balance-row');
    // Absent renders a dedicated "no account" affordance, NOT a balance value.
    const absentMarker = within(absentRow).getByTestId('chain-balance-absent');
    expect(absentMarker).toBeInTheDocument();
    expect(
      within(absentRow).queryByTestId('chain-balance-value'),
    ).not.toBeInTheDocument();

    const absentText = absentMarker.textContent ?? '';
    unmount();

    // Same chain id, but a ZERO balance — its visible text must differ from the
    // absent affordance so the two states can never be confused.
    const zero: ChainBalanceStatus = {
      kind: 'zero',
      chainId: 4,
      balance: '0.000000000000',
    };
    render(<ChainBalanceRow status={zero} />);
    const zeroValue = screen.getByTestId('chain-balance-value');
    expect(zeroValue.textContent).not.toBe(absentText);
    // The absent affordance is not the digit "0".
    expect(absentText.trim()).not.toBe('0');
  });

  it('renders a per-chain error indicator for an errored read — not a balance and not an absent label', () => {
    const status: ChainBalanceStatus = {
      kind: 'errored',
      chainId: 9,
      error: 'RPC timeout',
    };
    render(<ChainBalanceRow status={status} />);

    const row = screen.getByTestId('chain-balance-row');
    // A failed read surfaces a per-chain error indicator (with the message),
    // never a balance value and never the absent "no account" affordance.
    const errorMarker = within(row).getByTestId('chain-balance-error');
    expect(errorMarker).toBeInTheDocument();
    expect(errorMarker).toHaveTextContent(/RPC timeout/i);

    expect(
      within(row).queryByTestId('chain-balance-value'),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByTestId('chain-balance-absent'),
    ).not.toBeInTheDocument();
    // The STOA unit marker belongs to amounts only — an error is not an amount.
    expect(within(row).queryByRole('img', { name: 'STOA' })).not.toBeInTheDocument();
  });
});
