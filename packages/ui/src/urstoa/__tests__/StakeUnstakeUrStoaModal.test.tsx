import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  StakeUnstakeState,
  UseStakeUnstakeUrStoaResult,
} from '../useStakeUnstakeUrStoa';

// Stub the T12.7 hook entirely: the modal is presentation over the hook, so the
// test drives the staged state machine + asserts on the exact stake/unstake calls
// the modal makes. No WalletProvider, no core, no signing.
const stake = vi.fn((_params: { amount: string }) => Promise.resolve());
const unstake = vi.fn((_params: { amount: string }) => Promise.resolve());
const reset = vi.fn();
let mockState: StakeUnstakeState = { status: 'idle' };

vi.mock('../useStakeUnstakeUrStoa', () => ({
  useStakeUnstakeUrStoa: (): UseStakeUnstakeUrStoaResult => ({
    state: mockState,
    stake,
    unstake,
    reset,
  }),
}));

// Imported AFTER the mock is registered so the modal binds the stubbed hook.
const { StakeUnstakeUrStoaModal } = await import('../StakeUnstakeUrStoaModal');

beforeEach(() => {
  stake.mockClear();
  unstake.mockClear();
  reset.mockClear();
  mockState = { status: 'idle' };
});

afterEach(() => {
  vi.clearAllMocks();
});

/** A 24-decimal value that MUST survive intact (no Number round-trip would). */
const HIGH_PRECISION = '1.123456789012345678901234';

function typeAmount(value: string): void {
  fireEvent.change(screen.getByTestId('stake-amount'), {
    target: { value },
  });
}

describe('StakeUnstakeUrStoaModal — stake/unstake dispatch', () => {
  it('in stake mode, confirming calls stake({amount}) with the typed amount string', () => {
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
      />,
    );
    // Stake is the default mode.
    typeAmount('12.5');
    fireEvent.click(screen.getByTestId('stake-confirm'));

    expect(stake).toHaveBeenCalledTimes(1);
    expect(stake).toHaveBeenCalledWith({ amount: '12.5' });
    expect(unstake).not.toHaveBeenCalled();
  });

  it('toggling to unstake then confirming calls unstake({amount}), not stake', () => {
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
      />,
    );
    fireEvent.click(screen.getByTestId('stake-mode-unstake'));
    typeAmount('4');
    fireEvent.click(screen.getByTestId('stake-confirm'));

    expect(unstake).toHaveBeenCalledTimes(1);
    expect(unstake).toHaveBeenCalledWith({ amount: '4' });
    expect(stake).not.toHaveBeenCalled();
  });

  it('passes a 24-decimal amount through to the hook intact (no Number round-trip)', () => {
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
      />,
    );
    typeAmount(HIGH_PRECISION);
    fireEvent.click(screen.getByTestId('stake-confirm'));

    expect(stake).toHaveBeenCalledWith({ amount: HIGH_PRECISION });
    // A Number() round-trip would have collapsed this to 1.1234567890123457.
    expect(stake.mock.calls[0]?.[0]?.amount).toBe(HIGH_PRECISION);
  });
});

describe('StakeUnstakeUrStoaModal — last-staker floor (REQ-21)', () => {
  it('unstake max is userStaked - 1.0 when the user is the sole staker', () => {
    render(
      <StakeUnstakeUrStoaModal
        // Sole staker: userStaked >= vaultTotal, so the floor applies.
        holdings={{ walletBalance: '0', userStaked: '40', vaultTotal: '40' }}
      />,
    );
    fireEvent.click(screen.getByTestId('stake-mode-unstake'));
    fireEvent.click(screen.getByTestId('stake-max'));

    expect((screen.getByTestId('stake-amount') as HTMLInputElement).value).toBe(
      '39',
    );
    // The 1.0-must-remain note is surfaced, not silent.
    expect(screen.getByTestId('stake-floor-note')).toBeInTheDocument();
  });

  it('unstake max is the full userStaked when the user is NOT the last staker', () => {
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '0', userStaked: '40', vaultTotal: '100' }}
      />,
    );
    fireEvent.click(screen.getByTestId('stake-mode-unstake'));
    fireEvent.click(screen.getByTestId('stake-max'));

    expect((screen.getByTestId('stake-amount') as HTMLInputElement).value).toBe(
      '40',
    );
    // No last-staker floor note when the user is not the sole staker.
    expect(screen.queryByTestId('stake-floor-note')).not.toBeInTheDocument();
  });

  it('when the vault total is unknown, surfaces a distinct unavailable affordance, NOT a max of 0/full', () => {
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '0', userStaked: '40', vaultTotal: null }}
      />,
    );
    fireEvent.click(screen.getByTestId('stake-mode-unstake'));

    expect(screen.getByTestId('stake-max-unavailable')).toBeInTheDocument();
    // The max button is NOT offered (it would otherwise imply a 0/full max).
    expect(screen.queryByTestId('stake-max')).not.toBeInTheDocument();
  });
});

describe('StakeUnstakeUrStoaModal — staged progress + double-submit', () => {
  it('disables the confirm control while building', () => {
    mockState = { status: 'building' };
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
      />,
    );
    expect(screen.getByTestId('stake-confirm')).toBeDisabled();
  });

  it('disables the confirm control while submitting and shows the stage (not blank)', () => {
    mockState = { status: 'submitting' };
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
      />,
    );
    expect(screen.getByTestId('stake-confirm')).toBeDisabled();
    expect(screen.getByTestId('stake-stage')).toBeInTheDocument();
  });

  it('renders the gasless badge', () => {
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
      />,
    );
    expect(screen.getByTestId('stake-gasless-badge')).toHaveTextContent(
      /gasless/i,
    );
  });
});

describe('StakeUnstakeUrStoaModal — result panel', () => {
  it('on a SUBMITTED success, returns to overview (onClose) and shows NO inline rectangle', () => {
    // The submitted outcome is now handed to the floating tx toast; the page
    // closes back to the overview instead of rendering a static success panel.
    mockState = { status: 'success', requestKey: 'rk-stake-9' };
    const onClose = vi.fn();
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
        onClose={onClose}
      />,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('stake-success')).not.toBeInTheDocument();
  });

  it('shows a distinct error reason and does NOT render a false success', () => {
    mockState = { status: 'error', reason: 'insufficient-funds' };
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
      />,
    );
    expect(screen.getByTestId('stake-error')).toBeInTheDocument();
    expect(screen.queryByTestId('stake-success')).not.toBeInTheDocument();
  });

  it('routes a locked outcome to onRequireUnlock rather than a generic error', () => {
    const onRequireUnlock = vi.fn();
    mockState = { status: 'error', reason: 'locked' };
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
        onRequireUnlock={onRequireUnlock}
      />,
    );
    const unlock = screen.getByTestId('stake-unlock');
    expect(unlock).toBeInTheDocument();
    expect(screen.queryByTestId('stake-error')).not.toBeInTheDocument();
    fireEvent.click(unlock);
    expect(onRequireUnlock).toHaveBeenCalledTimes(1);
  });

  it('on a PENDING outcome, also returns to overview (the toast carries the unknown state)', () => {
    mockState = { status: 'pending', requestKey: 'rk-maybe-7' };
    const onClose = vi.fn();
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
        onClose={onClose}
      />,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('stake-pending')).not.toBeInTheDocument();
  });

  it('STAKE mode shows the wallet balance; UNSTAKE mode shows the vault stake', () => {
    render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
      />,
    );
    // Stake is the default — the balance row labels the WALLET balance.
    expect(screen.getByTestId('stake-balance')).toHaveTextContent(/Wallet balance/i);
    // Switching to unstake flips it to the user's VAULT stake.
    fireEvent.click(screen.getByTestId('stake-mode-unstake'));
    expect(screen.getByTestId('stake-balance')).toHaveTextContent(/Vault \(staked\)/i);
  });

  it('fires the return-to-overview exactly ONCE per submitted request key', () => {
    mockState = { status: 'success', requestKey: 'rk-dedupe' };
    const onClose = vi.fn();
    const { rerender } = render(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
        onClose={onClose}
      />,
    );
    // A re-render at the same success state must NOT re-fire the close (deduped).
    rerender(
      <StakeUnstakeUrStoaModal
        holdings={{ walletBalance: '100', userStaked: '10', vaultTotal: '50' }}
        onClose={onClose}
      />,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
