import type {
  ResumeParams,
  ResumeCrossChainResult,
} from '@stoawallet/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContinuationRecoveryView } from '../ContinuationRecoveryView';

/**
 * The view composes `useContinuationResume`. Tests drive it through a STUBBED
 * resume op injected via `hookOptions.resumeCrossChain`, so the real state
 * machine (the load-bearing RESUME-never-RESTART reason mapping) runs while the
 * network stays out. A deferred op lets a test hold the in-flight `checking`
 * stage open.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ContinuationRecoveryView', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders SOURCE and TARGET selectors each with all 10 StoaChain options', () => {
    render(<ContinuationRecoveryView />);

    const source = screen.getByTestId('recovery-source') as HTMLSelectElement;
    const target = screen.getByTestId('recovery-target') as HTMLSelectElement;

    // Both chain selectors must offer the full braided chain set — a missing
    // chain would make some stalled transfers unrecoverable from this screen.
    expect(within(source).getAllByRole('option')).toHaveLength(10);
    expect(within(target).getAllByRole('option')).toHaveLength(10);
  });

  it('selecting source chain "2" DISABLES the matching target option so source !== target', () => {
    render(<ContinuationRecoveryView />);

    const source = screen.getByTestId('recovery-source') as HTMLSelectElement;
    fireEvent.change(source, { target: { value: '2' } });

    const target = screen.getByTestId('recovery-target') as HTMLSelectElement;
    // A cross-chain resume to the SAME chain is nonsensical; the option that
    // would let the user pick it must be disabled, enforcing source !== target.
    const targetOption2 = within(target)
      .getAllByRole('option')
      .find((o) => (o as HTMLOptionElement).value === '2') as HTMLOptionElement;
    expect(targetOption2.disabled).toBe(true);
  });

  it('"Check & Resume" is DISABLED with an empty request key (binds to the hook canResume)', () => {
    render(<ContinuationRecoveryView />);

    // With no request key typed the hook reports canResume=false; the button
    // must reflect that so the user cannot fire a resume with no identity.
    expect(
      screen.getByRole('button', { name: /check & resume/i }),
    ).toBeDisabled();
  });

  it('"Check & Resume" is DISABLED when source === target even with a request key', () => {
    render(<ContinuationRecoveryView />);

    fireEvent.change(screen.getByTestId('recovery-request-key'), {
      target: { value: 'rk-abc' },
    });
    // Force both selectors to chain "0" — a same-chain pair must keep the
    // control disabled (driven by the hook, not re-derived inline).
    fireEvent.change(screen.getByTestId('recovery-source'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByTestId('recovery-target'), {
      target: { value: '0' },
    });

    expect(
      screen.getByRole('button', { name: /check & resume/i }),
    ).toBeDisabled();
  });

  it('"Check & Resume" calls resume with the typed request key + distinct chains', async () => {
    const resumeCrossChain = vi.fn(
      async (_params: ResumeParams): Promise<ResumeCrossChainResult> => ({
        ok: true,
        continuationKey: 'cont-key-1',
      }),
    );

    render(
      <ContinuationRecoveryView hookOptions={{ resumeCrossChain }} />,
    );

    fireEvent.change(screen.getByTestId('recovery-request-key'), {
      target: { value: 'rk-burn-7' },
    });
    fireEvent.change(screen.getByTestId('recovery-source'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByTestId('recovery-target'), {
      target: { value: '4' },
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /check & resume/i }),
      );
    });

    // The resume must carry the EXACT identity the user supplied — a dropped or
    // swapped chain would resume the wrong transfer.
    expect(resumeCrossChain).toHaveBeenCalledWith({
      requestKey: 'rk-burn-7',
      sourceChain: '1',
      targetChain: '4',
    });
  });

  it('step0-pending renders the PENDING message — NOT the success panel — with no resubmit control', async () => {
    const pending = deferred<ResumeCrossChainResult>();
    const resumeCrossChain = vi.fn(() => pending.promise);

    render(
      <ContinuationRecoveryView hookOptions={{ resumeCrossChain }} />,
    );

    fireEvent.change(screen.getByTestId('recovery-request-key'), {
      target: { value: 'rk-pending' },
    });
    fireEvent.change(screen.getByTestId('recovery-source'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByTestId('recovery-target'), {
      target: { value: '5' },
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /check & resume/i }),
      );
    });

    await act(async () => {
      pending.resolve({ ok: false, reason: 'step0-pending' });
    });

    // Step 0 is still confirming — the user sees a "check again later" surface,
    // distinct from success, so they never believe the transfer completed.
    await waitFor(() =>
      expect(screen.getByTestId('recovery-pending')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('recovery-pending')).toHaveTextContent(
      /step 0 still pending/i,
    );
    expect(screen.queryByTestId('recovery-success')).not.toBeInTheDocument();

    // RESUME-ONLY: there must be NO affordance that re-submits the original
    // Step-0 transfer. The view holds no key material and must never offer one.
    expect(
      screen.queryByRole('button', { name: /resubmit|restart|re-send|send step 0/i }),
    ).not.toBeInTheDocument();
  });

  it('no-continuation renders its DISTINCT "not a cross-chain transfer" message', async () => {
    const resumeCrossChain = vi.fn(
      async (): Promise<ResumeCrossChainResult> => ({
        ok: false,
        reason: 'no-continuation',
      }),
    );

    render(
      <ContinuationRecoveryView hookOptions={{ resumeCrossChain }} />,
    );

    fireEvent.change(screen.getByTestId('recovery-request-key'), {
      target: { value: 'rk-plain-transfer' },
    });
    fireEvent.change(screen.getByTestId('recovery-source'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByTestId('recovery-target'), {
      target: { value: '2' },
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /check & resume/i }),
      );
    });

    // A plain same-chain transfer has no continuation to drive — the surface
    // must say so, distinct from both pending and hard error.
    await waitFor(() =>
      expect(
        screen.getByTestId('recovery-no-continuation'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('recovery-no-continuation'),
    ).toHaveTextContent(/not a cross-chain transfer/i);
  });

  it('spv-unavailable renders a RETRYABLE "proof not yet available" message', async () => {
    const resumeCrossChain = vi.fn(
      async (): Promise<ResumeCrossChainResult> => ({
        ok: false,
        reason: 'spv-unavailable',
      }),
    );

    render(
      <ContinuationRecoveryView hookOptions={{ resumeCrossChain }} />,
    );

    fireEvent.change(screen.getByTestId('recovery-request-key'), {
      target: { value: 'rk-no-proof' },
    });
    fireEvent.change(screen.getByTestId('recovery-source'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByTestId('recovery-target'), {
      target: { value: '6' },
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /check & resume/i }),
      );
    });

    // The SPV proof simply isn't braided yet — a retryable surface tells the
    // user to try again shortly, never an error and never auto-resubmit.
    await waitFor(() =>
      expect(screen.getByTestId('recovery-pending')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('recovery-pending')).toHaveTextContent(
      /proof not yet available/i,
    );
  });

  it('success surfaces the continuation key with a copy control + explorer link + "Resume Another"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const resumeCrossChain = vi.fn(
      async (): Promise<ResumeCrossChainResult> => ({
        ok: true,
        continuationKey: 'cont-key-abc123',
      }),
    );

    render(
      <ContinuationRecoveryView hookOptions={{ resumeCrossChain }} />,
    );

    fireEvent.change(screen.getByTestId('recovery-request-key'), {
      target: { value: 'rk-ok' },
    });
    fireEvent.change(screen.getByTestId('recovery-source'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByTestId('recovery-target'), {
      target: { value: '3' },
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /check & resume/i }),
      );
    });

    await waitFor(() =>
      expect(screen.getByTestId('recovery-success')).toBeInTheDocument(),
    );

    // The continuation request key must be shown so the user can track it.
    expect(screen.getByTestId('recovery-continuation-key')).toHaveTextContent(
      'cont-key-abc123',
    );

    // Explorer deep-link points at the exact continuation key.
    expect(
      screen.getByRole('link', { name: /explorer/i }),
    ).toHaveAttribute(
      'href',
      'https://explorer.stoachain.com/transactions/cont-key-abc123',
    );

    // Copy control writes the EXACT continuation key, not a derived string.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    });
    expect(writeText).toHaveBeenCalledWith('cont-key-abc123');

    // "Resume Another" resets back to the form so the user can recover the next.
    expect(
      screen.getByRole('button', { name: /resume another/i }),
    ).toBeInTheDocument();
  });

  it('prefill prop POPULATES the request-key + both chain inputs', () => {
    render(
      <ContinuationRecoveryView
        prefill={{ requestKey: 'rk-routed-9', sourceChain: '7', targetChain: '2' }}
      />,
    );

    // When routed from the pending-transfer affordance the user must not retype:
    // the request key and both chains arrive pre-filled.
    expect(
      (screen.getByTestId('recovery-request-key') as HTMLInputElement).value,
    ).toBe('rk-routed-9');
    expect(
      (screen.getByTestId('recovery-source') as HTMLSelectElement).value,
    ).toBe('7');
    expect(
      (screen.getByTestId('recovery-target') as HTMLSelectElement).value,
    ).toBe('2');
  });
});
