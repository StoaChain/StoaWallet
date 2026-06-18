import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `useTxToast` is the ONE transaction-feedback mechanism: a submitted request key
 * opens a pending toast, the generic confirmation seam is polled, and the SAME
 * toast flips to a terminal status with an auto-dismiss cooldown. The wallet
 * context is mocked so only the toast lifecycle is exercised (no node, no keys).
 */
const awaitSendConfirmation = vi.fn();
vi.mock('../../context/WalletContext', () => ({
  useOptionalWallet: () => ({ awaitSendConfirmation }),
}));

const { ToastProvider } = await import('../ToastContext');
const { ToastViewport } = await import('../ToastViewport');
const { useTxToast } = await import('../useTxToast');

function Probe({ requestKey }: { requestKey: string }): null {
  const track = useTxToast();
  useEffect(() => {
    track({ requestKey, chainId: '0', label: 'Stake' });
  }, [track, requestKey]);
  return null;
}

function renderTracked(requestKey: string): void {
  render(
    <ToastProvider>
      <Probe requestKey={requestKey} />
      <ToastViewport />
    </ToastProvider>,
  );
}

afterEach(() => vi.clearAllMocks());

describe('useTxToast', () => {
  it('opens a PENDING toast on submit, then flips the SAME toast to ✓ confirmed', async () => {
    let resolveConfirm: (v: unknown) => void = () => {};
    awaitSendConfirmation.mockReturnValue(
      new Promise((r) => {
        resolveConfirm = r;
      }),
    );
    renderTracked('rk-1');

    // Pending first — submitted, confirming on-chain.
    const toast = screen.getByTestId('toast');
    expect(toast).toHaveAttribute('data-status', 'pending');
    expect(toast).toHaveTextContent('Stake submitted');

    await act(async () => {
      resolveConfirm({ ok: true, status: 'confirmed', blockHeight: 4815162 });
    });

    await waitFor(() =>
      expect(screen.getByTestId('toast')).toHaveAttribute('data-status', 'success'),
    );
    const confirmed = screen.getByTestId('toast');
    expect(confirmed).toHaveTextContent('Stake confirmed');
    // It says WHERE: the chain it was submitted on + the mined block.
    expect(confirmed).toHaveTextContent('On chain #0 · block 4815162');
    // A confirmed toast carries an explorer link.
    expect(screen.getByTestId('toast-explorer-link')).toBeInTheDocument();
  });

  it('flips to ✗ error with the on-chain reason on a mined failure', async () => {
    awaitSendConfirmation.mockResolvedValue({
      ok: true,
      status: 'failed',
      detail: 'row not found',
    });
    renderTracked('rk-2');
    await waitFor(() =>
      expect(screen.getByTestId('toast')).toHaveAttribute('data-status', 'error'),
    );
    expect(screen.getByTestId('toast')).toHaveTextContent('row not found');
  });

  it('flips to ℹ "couldn\'t confirm" on a timeout (never a false success / re-send)', async () => {
    awaitSendConfirmation.mockResolvedValue({ ok: false, reason: 'timeout' });
    renderTracked('rk-3');
    await waitFor(() =>
      expect(screen.getByTestId('toast')).toHaveAttribute('data-status', 'info'),
    );
    expect(screen.getByTestId('toast')).toHaveTextContent(/couldn’t confirm|couldn't confirm/i);
  });
});
