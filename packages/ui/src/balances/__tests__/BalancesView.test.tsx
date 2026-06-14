import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import type { Balances, ChainBalance } from '@stoawallet/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { BalancesView } from '../BalancesView';

const ACCOUNT = 'k:aaa';

/** Build a 10-chain Record keyed "0".."9", letting individual chains override. */
function makeBalances(
  overrides: Record<string, ChainBalance> = {},
  base: ChainBalance = { balance: '0.0', exists: false },
): Balances {
  const out: Balances = {};
  for (let i = 0; i < 10; i += 1) {
    out[String(i)] = overrides[String(i)] ?? base;
  }
  return out;
}

function renderView(props: {
  account?: string | null;
  getBalances: (account: string) => Promise<Balances>;
}): void {
  // `null` is a meaningful idle signal, so only fall back to the default
  // account when `account` is entirely absent — never collapse `null`.
  const account = 'account' in props ? props.account : ACCOUNT;
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider storage={storage} keyVault={keyVault}>
      {children}
    </WalletProvider>
  );
  render(
    <Wrapper>
      <BalancesView account={account} getBalances={props.getBalances} />
    </Wrapper>,
  );
}

describe('BalancesView', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders exactly 10 per-chain rows and a prominent aggregate total with the gold STOA glyph', async () => {
    // Two funded chains (10 + 2.5 = 12.5) prove the total sums real per-chain reads.
    const getBalances = vi.fn(async () =>
      makeBalances({
        '0': { balance: '10.0', exists: true },
        '5': { balance: '2.5', exists: true },
      }),
    );
    renderView({ getBalances });

    await waitFor(() =>
      expect(screen.getAllByTestId('chain-balance-row')).toHaveLength(10),
    );

    // The hero total is the summed cross-chain figure, not a per-row value, and
    // it carries the gold STOA unit marker so it reads as STOA-denominated.
    const hero = screen.getByTestId('balances-total');
    expect(within(hero).getByText(/12\.5/)).toBeInTheDocument();
    expect(within(hero).getByRole('img', { name: 'STOA' })).toBeInTheDocument();
  });

  it('shows a loading affordance while loading and no misleading zero total, then rows + total after resolve', async () => {
    let resolveFetch: (b: Balances) => void = () => {};
    const getBalances = vi.fn(
      () =>
        new Promise<Balances>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    renderView({ getBalances });

    // While loading: a loading affordance is shown and the hero total does NOT
    // display a "0" that a user would misread as "no funds".
    expect(screen.getByTestId('balances-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('balances-total')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chain-balance-row')).not.toBeInTheDocument();

    await act(async () => {
      resolveFetch(makeBalances({ '0': { balance: '4.0', exists: true } }));
    });

    // After resolve: the loader is gone and the rows + total are shown.
    await waitFor(() =>
      expect(screen.getAllByTestId('chain-balance-row')).toHaveLength(10),
    );
    expect(screen.queryByTestId('balances-loading')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('balances-total')).getByText(/4/),
    ).toBeInTheDocument();
  });

  it('keeps the other nine rows and the total visible when one chain errors, and labels the total PARTIAL', async () => {
    // Nine chains funded with 1.0 each (total 9), chain 2 errored — the errored
    // chain must not blank the view, and the total must be flagged as partial.
    const getBalances = vi.fn(async () =>
      makeBalances(
        { '2': { balance: '0.0', exists: false, error: 'rpc timeout' } },
        { balance: '1.0', exists: true },
      ),
    );
    renderView({ getBalances });

    await waitFor(() =>
      expect(screen.getAllByTestId('chain-balance-row')).toHaveLength(10),
    );

    // The errored chain renders its inline per-chain indicator...
    expect(screen.getByTestId('chain-balance-error')).toBeInTheDocument();
    // ...while the total still shows the summed figure (9) AND is labelled
    // partial: it spans 9 of 10 chains, so it is not presented as a trustworthy
    // whole-account sum. The hero amount sits in the element holding the STOA
    // glyph; its leading text is the abbreviated summed value "9".
    const total = screen.getByTestId('balances-total');
    const heroAmount = within(total).getByRole('img', { name: 'STOA' })
      .parentElement;
    expect(heroAmount?.textContent?.replace(/[^\d.]/g, '')).toBe('9');
    expect(screen.getByTestId('balances-total-partial')).toHaveTextContent(
      /9 of 10/,
    );
    // A retry affordance re-reads the balances: clicking it re-issues the read,
    // mirroring the whole-view-error retry contract.
    const retry = screen.getByRole('button', { name: /retry/i });
    expect(retry).toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() => expect(getBalances).toHaveBeenCalledTimes(2));
  });

  it('refresh control calls the read again and keeps data visible (no blank) while refreshing', async () => {
    let resolveFetch: (b: Balances) => void = () => {};
    const getBalances = vi.fn(() => {
      if (getBalances.mock.calls.length === 1) {
        // First call resolves immediately so data is on screen.
        return Promise.resolve(
          makeBalances({ '0': { balance: '3.0', exists: true } }),
        );
      }
      // Second call (the refresh) is held open so we can observe isRefreshing.
      return new Promise<Balances>((resolve) => {
        resolveFetch = resolve;
      });
    });
    renderView({ getBalances });

    await waitFor(() =>
      expect(screen.getAllByTestId('chain-balance-row')).toHaveLength(10),
    );

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    // The read was re-issued.
    await waitFor(() => expect(getBalances).toHaveBeenCalledTimes(2));

    // While the refresh is in flight: existing rows + total stay on screen (NOT
    // blanked) and a refresh-in-progress indicator is shown.
    expect(screen.getAllByTestId('chain-balance-row')).toHaveLength(10);
    expect(screen.getByTestId('balances-total')).toBeInTheDocument();
    expect(screen.getByTestId('balances-refreshing')).toBeInTheDocument();

    await act(async () => {
      resolveFetch(makeBalances({ '0': { balance: '3.0', exists: true } }));
    });
    await waitFor(() =>
      expect(screen.queryByTestId('balances-refreshing')).not.toBeInTheDocument(),
    );
  });

  it('keeps the rows + total visible (no blank error view) when a refresh fails, showing an inline retry', async () => {
    // First read succeeds (data on screen); the refresh REJECTS. A failed
    // refresh must NOT discard the still-valid populated balances — the rows and
    // total stay, and only a small inline refresh-error/retry affordance appears.
    const getBalances = vi.fn(() => {
      if (getBalances.mock.calls.length === 1) {
        return Promise.resolve(
          makeBalances({ '0': { balance: '3.0', exists: true } }),
        );
      }
      return Promise.reject(new Error('refresh network down'));
    });
    renderView({ getBalances });

    await waitFor(() =>
      expect(screen.getAllByTestId('chain-balance-row')).toHaveLength(10),
    );

    fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }));
    await waitFor(() => expect(getBalances).toHaveBeenCalledTimes(2));

    // After the refresh rejection: the whole-view blank error is NOT shown, the
    // rows + total are STILL on screen, and an inline refresh-failed/retry
    // affordance surfaces the failure without blanking.
    await waitFor(() =>
      expect(
        screen.getByTestId('balances-refresh-failed'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('balances-error')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('chain-balance-row')).toHaveLength(10);
    const total = screen.getByTestId('balances-total');
    expect(within(total).getByText(/3/)).toBeInTheDocument();

    // The inline affordance re-issues the read.
    fireEvent.click(
      within(screen.getByTestId('balances-refresh-failed')).getByRole(
        'button',
        { name: /retry/i },
      ),
    );
    await waitFor(() => expect(getBalances).toHaveBeenCalledTimes(3));
  });

  it('renders an "unable to load" hero (never a plain 0) when every existing chain errored', async () => {
    // All ten chains errored: includedChains 0, erroredChains 10. A "0" here
    // would read as "no funds", so the hero must show a distinct unknown state.
    const getBalances = vi.fn(async () =>
      makeBalances({}, { balance: '0.0', exists: false, error: 'down' }),
    );
    renderView({ getBalances });

    await waitFor(() =>
      expect(screen.getByTestId('balances-total')).toBeInTheDocument(),
    );

    const total = screen.getByTestId('balances-total');
    expect(total).toHaveTextContent(/unable to load|unknown/i);
    // The hero must NOT present a bare zero that reads as an empty account.
    expect(within(total).queryByText(/^0(\.0+)?$/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /retry/i }),
    ).toBeInTheDocument();
  });

  it('shows a neutral idle/locked state (not a loader, not a 0) when there is no active account', async () => {
    const getBalances = vi.fn(async () => makeBalances());
    renderView({ account: null, getBalances });

    await waitFor(() =>
      expect(screen.getByTestId('balances-idle')).toBeInTheDocument(),
    );

    // Idle is distinct from loading and from a zero total — it never fetches.
    expect(screen.queryByTestId('balances-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('balances-total')).not.toBeInTheDocument();
    expect(getBalances).not.toHaveBeenCalled();
  });

  it('shows a distinct whole-view error with retry when the read totally fails (hook error)', async () => {
    const getBalances = vi.fn(async () => {
      throw new Error('network unreachable');
    });
    renderView({ getBalances });

    await waitFor(() =>
      expect(screen.getByTestId('balances-error')).toBeInTheDocument(),
    );

    // A total failure is the whole-view error state, NOT per-chain errored rows.
    expect(screen.queryByTestId('chain-balance-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('balances-total')).not.toBeInTheDocument();

    // Retry re-issues the read.
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(getBalances).toHaveBeenCalledTimes(2));
  });
});
