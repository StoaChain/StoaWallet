import { act, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider, useToast, type ToastSpec } from '../ToastContext';
import { ToastViewport } from '../ToastViewport';

/**
 * A tiny harness exposing the toast API to the test via a ref-like callback, so
 * the test drives show/update/dismiss directly and asserts the viewport render.
 */
function Harness({ onReady }: { onReady: (api: ReturnType<typeof useToast>) => void }): ReactNode {
  const api = useToast();
  onReady(api);
  return <ToastViewport />;
}

function renderToasts(): { show: (s: ToastSpec) => string; update: (id: string, p: Partial<ToastSpec>) => void } {
  let api!: ReturnType<typeof useToast>;
  render(
    <ToastProvider>
      <Harness onReady={(a) => (api = a)} />
    </ToastProvider>,
  );
  return { show: (s) => api.show(s), update: (id, p) => api.update(id, p) };
}

describe('ToastViewport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders nothing when there are no toasts', () => {
    renderToasts();
    expect(screen.queryByTestId('toast-viewport')).not.toBeInTheDocument();
  });

  it('shows a PENDING toast (spinner) that persists with no auto-dismiss timer', () => {
    const { show } = renderToasts();
    act(() => {
      show({ status: 'pending', title: 'Transaction submitted', detail: 'Confirming…' });
    });
    const toast = screen.getByTestId('toast');
    expect(toast).toHaveAttribute('data-status', 'pending');
    expect(toast).toHaveTextContent('Transaction submitted');
    // A pending toast does NOT auto-dismiss: advancing time leaves it on screen.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('toast')).toBeInTheDocument();
  });

  it('flips a pending toast to CONFIRMED ✓ with an explorer link and then SELF-DISMISSES after its timer', () => {
    const { show, update } = renderToasts();
    let id = '';
    act(() => {
      id = show({ status: 'pending', title: 'Transaction submitted' });
    });
    act(() => {
      update(id, {
        status: 'success',
        title: 'Transaction confirmed',
        explorerUrl: 'https://explorer.stoachain.com/transactions/rk-1',
        autoDismissMs: 6000,
      });
    });
    const toast = screen.getByTestId('toast');
    expect(toast).toHaveAttribute('data-status', 'success');
    expect(toast).toHaveTextContent('Transaction confirmed');
    expect(screen.getByTestId('toast-explorer-link')).toHaveAttribute(
      'href',
      'https://explorer.stoachain.com/transactions/rk-1',
    );
    // The depleting timer removes it once elapsed.
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  it('dismisses a toast immediately on the close affordance', () => {
    const { show } = renderToasts();
    act(() => {
      show({ status: 'error', title: 'Transaction failed', autoDismissMs: 9000 });
    });
    expect(screen.getByTestId('toast')).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    });
    expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
  });

  it('renders a MULTI-STEP toast (the aggregate) with one status sub-row per step', () => {
    const { show, update } = renderToasts();
    let id = '';
    act(() => {
      id = show({
        status: 'pending',
        title: 'Aggregating into Chain 0',
        steps: [
          { label: 'Chain 3', status: 'pending', note: 'SPV 2/40' },
          { label: 'Chain 5', status: 'success', note: 'done' },
        ],
      });
    });
    const steps = screen.getByTestId('toast-steps');
    expect(steps).toHaveTextContent('Chain 3');
    expect(steps).toHaveTextContent('SPV 2/40');
    expect(steps).toHaveTextContent('Chain 5');

    // A step advancing updates its sub-row independently of the parent toast.
    act(() => {
      update(id, {
        status: 'success',
        title: 'Aggregation complete',
        steps: [
          { label: 'Chain 3', status: 'success', note: 'done' },
          { label: 'Chain 5', status: 'success', note: 'done' },
        ],
        autoDismissMs: 9000,
      });
    });
    expect(screen.getByTestId('toast')).toHaveAttribute('data-status', 'success');
    expect(screen.getByTestId('toast-steps')).toHaveTextContent('Chain 3');
  });
});
