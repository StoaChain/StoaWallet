import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CollectState,
  UseCollectUrStoaResult,
} from '../useCollectUrStoa';

/**
 * The Collect UI composes `useCollectUrStoa` and renders its staged state machine
 * + the claimable-earnings figure. The hook itself is exercised by its own suite
 * (T12.8); here it is STUBBED so the view's earnings display, the `canCollect`-bound
 * disabled gate, the in-flight double-submit lock, the gasless badge, the staged
 * progress, and the distinct terminal panels can be asserted in isolation — with no
 * core import, no signing, no network.
 */
const hookSpy = vi.fn<() => UseCollectUrStoaResult>();

vi.mock('../useCollectUrStoa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../useCollectUrStoa')>();
  return {
    ...actual,
    useCollectUrStoa: () => hookSpy(),
  };
});

// Imported AFTER the mock factory is registered so the view binds the stub.
const { CollectUrStoa } = await import('../CollectUrStoa');

/** Build a stub hook result, overriding only the fields a test cares about. */
function stubHook(
  over: Partial<UseCollectUrStoaResult> = {},
): UseCollectUrStoaResult {
  return {
    state: { status: 'idle' } as CollectState,
    canCollect: true,
    collect: vi.fn(async () => undefined),
    ...over,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CollectUrStoa', () => {
  it('renders the claimable earnings unwrapped from a {decimal} envelope with the gold ❖ STOA mark', () => {
    hookSpy.mockReturnValue(stubHook());
    render(<CollectUrStoa earnings={{ decimal: '5.0' }} />);

    // The figure must be the UNWRAPPED decimal "5.0" — never the "[object Object]"
    // String() of the raw envelope — so the user sees their real claimable amount.
    const amount = screen.getByTestId('collect-earnings');
    expect(amount).toHaveTextContent('5.0');
    expect(amount).not.toHaveTextContent('[object Object]');

    // The earnings are STOA-denominated, so the unit mark is the gold ❖ (STOA),
    // not the silver ✦ (UrStoa) — per DESIGN.md vault earnings always read in STOA.
    const mark = screen.getByRole('img', { name: 'STOA' });
    expect(mark).toHaveTextContent('❖');
  });

  it('DISABLES Collect when the hook reports canCollect:false (zero earnings)', () => {
    // {decimal:"0"} earnings → the hook's unwrap+numeric>0 gate yields canCollect:false.
    // Binding to that flag (NOT a view-side String()/truthiness on the envelope) is
    // what keeps a zero-earnings Collect from being clickable (RR#7).
    hookSpy.mockReturnValue(stubHook({ canCollect: false }));
    render(<CollectUrStoa earnings={{ decimal: '0' }} />);

    expect(screen.getByTestId('collect-submit')).toBeDisabled();
  });

  it('ENABLES Collect when the hook reports canCollect:true (non-zero earnings)', () => {
    hookSpy.mockReturnValue(stubHook({ canCollect: true }));
    render(<CollectUrStoa earnings={{ decimal: '5.0' }} />);

    expect(screen.getByTestId('collect-submit')).toBeEnabled();
  });

  it('calls the hook collect() when an enabled Collect is clicked', () => {
    const collect = vi.fn(async () => undefined);
    hookSpy.mockReturnValue(stubHook({ canCollect: true, collect }));
    render(<CollectUrStoa earnings={{ decimal: '5.0' }} />);

    fireEvent.click(screen.getByTestId('collect-submit'));
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('disables Collect while building to block a double-submit', () => {
    hookSpy.mockReturnValue(
      stubHook({ canCollect: true, state: { status: 'building' } }),
    );
    render(<CollectUrStoa earnings={{ decimal: '5.0' }} />);

    expect(screen.getByTestId('collect-submit')).toBeDisabled();
  });

  it('disables Collect while submitting to block a double-submit', () => {
    hookSpy.mockReturnValue(
      stubHook({ canCollect: true, state: { status: 'submitting' } }),
    );
    render(<CollectUrStoa earnings={{ decimal: '5.0' }} />);

    expect(screen.getByTestId('collect-submit')).toBeDisabled();
  });

  it('shows a gasless badge indicating the gas station pays', () => {
    hookSpy.mockReturnValue(stubHook());
    render(<CollectUrStoa earnings={{ decimal: '5.0' }} />);

    expect(screen.getByTestId('gasless-badge')).toBeInTheDocument();
  });

  it('shows the staged progress while in flight', () => {
    hookSpy.mockReturnValue(
      stubHook({ canCollect: true, state: { status: 'submitting' } }),
    );
    render(<CollectUrStoa earnings={{ decimal: '5.0' }} />);

    expect(screen.getByTestId('collect-stage')).toBeInTheDocument();
  });

  it('on a SUBMITTED success, returns to overview (onClose) and shows NO inline rectangle', () => {
    // The submitted outcome is handed to the floating tx toast; the page closes.
    hookSpy.mockReturnValue(
      stubHook({
        canCollect: true,
        state: { status: 'success', requestKey: 'reqkey-123' },
      }),
    );
    const onClose = vi.fn();
    render(<CollectUrStoa earnings={{ decimal: '5.0' }} onClose={onClose} />);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('collect-success')).not.toBeInTheDocument();
  });

  it('routes a locked error to the unlock affordance, never a false success', () => {
    const onRequireUnlock = vi.fn();
    hookSpy.mockReturnValue(
      stubHook({ state: { status: 'error', reason: 'locked' } }),
    );
    render(
      <CollectUrStoa
        earnings={{ decimal: '5.0' }}
        onRequireUnlock={onRequireUnlock}
      />,
    );

    // A locked vault routes to unlock, not a generic error and not a success.
    expect(screen.queryByTestId('collect-success')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('collect-unlock'));
    expect(onRequireUnlock).toHaveBeenCalledTimes(1);
  });

  it('shows a distinct error reason that is not a false success', () => {
    hookSpy.mockReturnValue(
      stubHook({
        state: { status: 'error', reason: 'gas-payer-rejected' },
      }),
    );
    render(<CollectUrStoa earnings={{ decimal: '5.0' }} />);

    expect(screen.getByTestId('collect-error')).toBeInTheDocument();
    expect(screen.queryByTestId('collect-success')).not.toBeInTheDocument();
  });

  it('on a PENDING outcome, also returns to overview (the toast carries the unknown state)', () => {
    hookSpy.mockReturnValue(stubHook({ state: { status: 'pending' } }));
    const onClose = vi.fn();
    render(<CollectUrStoa earnings={{ decimal: '5.0' }} onClose={onClose} />);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('collect-pending')).not.toBeInTheDocument();
  });

  it('forwards the earnings prop verbatim to the hook so the hook owns the gate', () => {
    hookSpy.mockReturnValue(stubHook());
    const earnings = { decimal: '5.0' };
    render(<CollectUrStoa earnings={earnings} hookOptions={{ account: 'k:x' }} />);

    // The view must NOT re-implement the gate; it forwards the raw envelope and the
    // caller options to the hook, which unwraps + compares >0 (RR#7).
    expect(hookSpy).toHaveBeenCalled();
  });

  it('returns to overview exactly ONCE per submitted collect', () => {
    hookSpy.mockReturnValue(
      stubHook({ state: { status: 'success', requestKey: 'rk-1' } as CollectState }),
    );
    const onClose = vi.fn();
    const { rerender } = render(
      <CollectUrStoa earnings={{ decimal: '5.0' }} onClose={onClose} />,
    );
    rerender(<CollectUrStoa earnings={{ decimal: '5.0' }} onClose={onClose} />);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
