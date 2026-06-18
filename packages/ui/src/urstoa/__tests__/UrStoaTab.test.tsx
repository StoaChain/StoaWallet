import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The UrStoa tab routes the four actions as FULL-PAGE sub-views (not modals),
 * registering a BACK handler with the shell so the back button lives in the app
 * header — the SAME pattern the Stoa tab uses. Here the holdings hook + the flow
 * pages are stubbed so the test asserts ONLY the routing + back wiring.
 */
vi.mock('../useUrStoaHoldings', () => ({
  useUrStoaHoldings: () => ({
    walletBalance: '10',
    vaultBalance: '5',
    vaultTotal: '50',
    vaultEarnings: '1',
    isLoading: false,
    isRefreshing: false,
    isUnknown: false,
    error: null,
    isIdle: false,
    refresh: vi.fn(),
  }),
}));
vi.mock('../StakeUnstakeUrStoaModal', () => ({
  StakeUnstakeUrStoaModal: () => <div data-testid="stake-page" />,
}));
vi.mock('../CollectUrStoa', () => ({
  CollectUrStoa: () => <div data-testid="collect-page" />,
}));
vi.mock('../TransferUrStoaModal', () => ({
  TransferUrStoaModal: () => <div data-testid="transfer-page" />,
}));

const { UrStoaTab } = await import('../UrStoaTab');

afterEach(() => vi.clearAllMocks());

describe('UrStoaTab — action routing', () => {
  it('opens an action as a sub-view page and registers a header BACK handler', () => {
    const onBackChange = vi.fn();
    render(<UrStoaTab onBackChange={onBackChange} />);

    // Overview first: the card actions, no sub-view, back handler cleared (null).
    expect(screen.queryByTestId('urstoa-subview')).toBeNull();
    expect(onBackChange).toHaveBeenLastCalledWith(null);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Stake' }));
    });

    // Now on the Stake page, and the shell got a back FUNCTION (not null).
    expect(screen.getByTestId('urstoa-subview')).toBeInTheDocument();
    expect(screen.getByTestId('stake-page')).toBeInTheDocument();
    const back = onBackChange.mock.calls.at(-1)?.[0];
    expect(typeof back).toBe('function');

    // Invoking the registered back handler returns to the overview.
    act(() => back());
    expect(screen.queryByTestId('urstoa-subview')).toBeNull();
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeInTheDocument();
  });

  it('routes each chip to its own page', () => {
    render(<UrStoaTab />);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Transfer' })));
    expect(screen.getByTestId('transfer-page')).toBeInTheDocument();
  });
});
