import { render, screen, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { palette } from '../../theme/tokens';
import { UrStoaCard } from '../UrStoaCard';
import * as holdingsModule from '../useUrStoaHoldings';
import type { UseUrStoaHoldingsResult } from '../useUrStoaHoldings';

/**
 * The UrStoa AssetItem card composes the T12.6 `useUrStoaHoldings` hook (stubbed
 * here so the network is off-band) into a chain-0 holdings panel: a WALLET row
 * and a VAULT (staked) row in silver UrStoa ✦, plus a VAULT EARNINGS row in gold
 * STOA ❖. The wrapped-balance / wrapped-id rows are EXCLUDED entirely. The card
 * is pure presentation — it never imports core and never signs; the Stake /
 * Unstake / Collect / Transfer affordances fire the handler props the Wave-4
 * modals (T12.11/T12.12/T12.13) plug into.
 */

const REFRESH = vi.fn(async () => undefined);

function stubHoldings(
  overrides: Partial<UseUrStoaHoldingsResult> = {},
): UseUrStoaHoldingsResult {
  return {
    walletBalance: null,
    vaultBalance: null,
    vaultEarnings: null,
    vaultTotal: null,
    isLoading: false,
    isRefreshing: false,
    isUnknown: false,
    error: null,
    isIdle: false,
    refresh: REFRESH,
    ...overrides,
  };
}

function mockHoldings(overrides: Partial<UseUrStoaHoldingsResult> = {}): void {
  vi.spyOn(holdingsModule, 'useUrStoaHoldings').mockReturnValue(
    stubHoldings(overrides),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  REFRESH.mockClear();
});

describe('UrStoaCard', () => {
  it('renders the wallet + vault rows in silver UrStoa ✦ and the earnings row in gold STOA ❖', () => {
    mockHoldings({
      walletBalance: '62.5',
      vaultBalance: '1000.0',
      vaultEarnings: '12.34',
    });

    render(<UrStoaCard />);

    // The two UrStoa-denominated holdings rows carry the silver ✦ mark; the
    // STOA-denominated earnings row carries the gold ❖ — even on a UrStoa card.
    const wallet = screen.getByTestId('urstoa-wallet-row');
    const vault = screen.getByTestId('urstoa-vault-row');
    const earnings = screen.getByTestId('urstoa-earnings-row');

    const walletMark = within(wallet).getByRole('img');
    const vaultMark = within(vault).getByRole('img');
    const earningsMark = within(earnings).getByRole('img');

    expect(walletMark).toHaveTextContent('✦');
    expect(walletMark).toHaveStyle({ color: palette.silver });
    expect(vaultMark).toHaveTextContent('✦');
    expect(vaultMark).toHaveStyle({ color: palette.silver });
    expect(earningsMark).toHaveTextContent('❖');
    expect(earningsMark).toHaveStyle({ color: palette.gold });
  });

  it('NEVER renders a wrapped-balance or wrapped-id row', () => {
    mockHoldings({
      walletBalance: '62.5',
      vaultBalance: '1000.0',
      vaultEarnings: '12.34',
    });

    render(<UrStoaCard />);

    expect(screen.queryByTestId('urstoa-wrapped-balance')).toBeNull();
    expect(screen.queryByTestId('urstoa-wrapped-id')).toBeNull();
    expect(screen.queryByText(/wrapped/i)).toBeNull();
  });

  it('formats amounts via the European formatter while preserving the full-precision value', () => {
    mockHoldings({
      walletBalance: '6081.3874',
      vaultBalance: '1000.0',
      vaultEarnings: '12.34',
    });

    render(<UrStoaCard />);

    const value = screen.getByTestId('urstoa-wallet-value');
    // formatEU: "6081.3874" → "6.081,3874" (dot thousands, comma decimal).
    expect(value).toHaveTextContent('6.081,3874');
    // The exact on-chain value is never lost: it lives on title/data-full-value.
    expect(value).toHaveAttribute('data-full-value', '6081.3874');
    expect(value).toHaveAttribute('title', '6081.3874');
  });

  it('renders a {decimal}-shaped earnings as a real number, never "[object Object]"', () => {
    // T12.6 unwraps the `{decimal}` envelope to a string before the card sees it;
    // the card must render that as a real figure, never String(obj).
    mockHoldings({
      walletBalance: '62.5',
      vaultBalance: '1000.0',
      vaultEarnings: '1234.5',
    });

    render(<UrStoaCard />);

    const earnings = screen.getByTestId('urstoa-earnings-value');
    expect(earnings).not.toHaveTextContent('[object Object]');
    expect(earnings).toHaveTextContent('1.234,5');
    expect(earnings).toHaveAttribute('data-full-value', '1234.5');
  });

  it('shows a loader on isLoading (not a misleading "0"), then the rows once loaded', () => {
    mockHoldings({ isLoading: true });
    const { rerender } = render(<UrStoaCard />);

    expect(screen.getByTestId('urstoa-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('urstoa-wallet-row')).toBeNull();
    // A loading card must NOT render a "0" balance that reads as empty funds.
    expect(screen.queryByTestId('urstoa-wallet-value')).toBeNull();

    mockHoldings({
      walletBalance: '62.5',
      vaultBalance: '1000.0',
      vaultEarnings: '12.34',
    });
    rerender(<UrStoaCard />);

    expect(screen.queryByTestId('urstoa-loading')).toBeNull();
    expect(screen.getByTestId('urstoa-wallet-row')).toBeInTheDocument();
  });

  it('keeps existing rows visible while isRefreshing', () => {
    mockHoldings({
      walletBalance: '62.5',
      vaultBalance: '1000.0',
      vaultEarnings: '12.34',
      isRefreshing: true,
    });

    render(<UrStoaCard />);

    // Refreshing keeps the figures on screen rather than dropping to a loader.
    expect(screen.getByTestId('urstoa-wallet-row')).toBeInTheDocument();
    expect(screen.getByTestId('urstoa-refreshing')).toBeInTheDocument();
  });

  it('shows a distinct "unable to load" + retry on the unknown state, never a "0"', () => {
    mockHoldings({ isUnknown: true });

    render(<UrStoaCard />);

    const unknown = screen.getByTestId('urstoa-unknown');
    expect(unknown).toBeInTheDocument();
    // Unknown is NOT zero: a failed read must never read as an empty balance.
    expect(screen.queryByTestId('urstoa-wallet-value')).toBeNull();
    expect(unknown).not.toHaveTextContent(/^0$/);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(REFRESH).toHaveBeenCalledTimes(1);
  });

  it('shows a distinct error + retry on a hard read failure, never a "0"', () => {
    mockHoldings({ error: new Error('UrStoa vault total read failed') });

    render(<UrStoaCard />);

    expect(screen.getByTestId('urstoa-error')).toBeInTheDocument();
    expect(screen.queryByTestId('urstoa-wallet-value')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(REFRESH).toHaveBeenCalledTimes(1);
  });

  it('shows a distinct idle affordance when locked / no account, with no garbage rows', () => {
    mockHoldings({ isIdle: true });

    render(<UrStoaCard />);

    expect(screen.getByTestId('urstoa-idle')).toBeInTheDocument();
    expect(screen.queryByTestId('urstoa-wallet-row')).toBeNull();
    expect(screen.queryByTestId('urstoa-wallet-value')).toBeNull();
  });

  it('fires the refresh action', () => {
    mockHoldings({
      walletBalance: '62.5',
      vaultBalance: '1000.0',
      vaultEarnings: '12.34',
    });

    render(<UrStoaCard />);

    fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }));
    expect(REFRESH).toHaveBeenCalledTimes(1);
  });

  it('exposes Stake / Unstake / Collect / Transfer affordances that open their modals', () => {
    mockHoldings({
      walletBalance: '62.5',
      vaultBalance: '1000.0',
      vaultEarnings: '12.34',
    });

    const onStake = vi.fn();
    const onUnstake = vi.fn();
    const onCollect = vi.fn();
    const onTransfer = vi.fn();

    render(
      <UrStoaCard
        onStake={onStake}
        onUnstake={onUnstake}
        onCollect={onCollect}
        onTransfer={onTransfer}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^stake$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^unstake$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^collect$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^transfer$/i }));

    expect(onStake).toHaveBeenCalledTimes(1);
    expect(onUnstake).toHaveBeenCalledTimes(1);
    expect(onCollect).toHaveBeenCalledTimes(1);
    expect(onTransfer).toHaveBeenCalledTimes(1);
  });

  it('does not log balances or account as telemetry', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    mockHoldings({
      walletBalance: '62.5',
      vaultBalance: '1000.0',
      vaultEarnings: '12.34',
    });

    render(<UrStoaCard />);

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
