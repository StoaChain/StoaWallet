import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { coreInfo } from '@stoawallet/core';
import type { GaslessGating, QrScanner, QrScanResult } from '@stoawallet/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { SendForm } from '../SendForm';
import type { ContextSendParams, ContextSendResult } from '../../context/WalletContext';

const RECIPIENT =
  'k:1111111111111111111111111111111111111111111111111111111111111111';

/** A deferred promise whose resolve is exposed for manual staged-state control. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const OK_RESULT: ContextSendResult = {
  ok: true,
  requestKey: 'rk-abc',
  status: 'success',
};

/**
 * Render SendForm inside a real WalletProvider, injecting the hook's options so
 * the form drives a STUBBED send op + gating without touching key material.
 */
function renderForm(opts: {
  sendSameChain?: (params: ContextSendParams) => Promise<ContextSendResult>;
  gasless?: GaslessGating | ((chainId: string) => GaslessGating);
  onSuccess?: () => void;
  qrScanner?: QrScanner;
} = {}): void {
  const gasless =
    typeof opts.gasless === 'string'
      ? () => opts.gasless as GaslessGating
      : opts.gasless;
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider
      storage={storage}
      keyVault={keyVault}
      qrScanner={opts.qrScanner}
    >
      {children}
    </WalletProvider>
  );
  render(
    <Wrapper>
      <SendForm
        hookOptions={{
          sendSameChain: opts.sendSameChain,
          gasless,
          onSuccess: opts.onSuccess,
        }}
      />
    </Wrapper>,
  );
}

/** Fill the recipient + amount + chain inputs and submit the (preview) form. */
function fillAndSend(params: {
  recipient?: string;
  amount: string;
  chainId?: string;
}): void {
  fireEvent.change(screen.getByTestId('send-recipient'), {
    target: { value: params.recipient ?? RECIPIENT },
  });
  fireEvent.change(screen.getByTestId('send-amount'), {
    target: { value: params.amount },
  });
  if (params.chainId !== undefined) {
    fireEvent.change(screen.getByTestId('send-chain'), {
      target: { value: params.chainId },
    });
  }
  fireEvent.click(screen.getByTestId('send-submit'));
}

describe('SendForm', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders exactly one chain option per StoaChain braided chain', () => {
    // The selector is the single driver of which chain a transfer lands on; it
    // must enumerate every chain (10) and never a hardcoded subset.
    renderForm();
    const select = screen.getByTestId('send-chain') as HTMLSelectElement;
    expect(select.options).toHaveLength(coreInfo.chainCount);
    expect(coreInfo.chainCount).toBe(10);
  });

  it('sends with the chain the user selected, not the default', async () => {
    // A user who picks chain "7" must move funds on chain 7 — selecting then
    // submitting must forward THAT chainId to the hook's send op.
    const send = vi.fn(async () => OK_RESULT);
    renderForm({ sendSameChain: send });
    await act(async () => {
      fillAndSend({ amount: '5', chainId: '7' });
    });
    expect(send).not.toHaveBeenCalled(); // preview only, no submit yet
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: '7', recipient: RECIPIENT }),
    );
  });

  it('forwards a 12-decimal amount string to the send op intact', async () => {
    // 12-decimal precision is money: the form must pass the typed string
    // verbatim — no Number()/round/truncate that would silently alter the value.
    const send = vi.fn(async () => OK_RESULT);
    renderForm({ sendSameChain: send });
    await act(async () => {
      fillAndSend({ amount: '0.000000000001', chainId: '0' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '0.000000000001' }),
    );
  });

  it('shows the preview before confirm and only submits on confirm', async () => {
    // The preview→confirm gate is the user's last review of recipient/amount/
    // chain before money moves; the preview must render and submit must wait.
    const send = vi.fn(async () => OK_RESULT);
    renderForm({ sendSameChain: send });
    await act(async () => {
      fillAndSend({ amount: '10', chainId: '0' });
    });
    const preview = screen.getByTestId('send-preview');
    expect(preview).toHaveTextContent(RECIPIENT);
    expect(preview).toHaveTextContent('10');
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('shows different gasless badge text for verified vs simulate-only', () => {
    // A 'verified' chain may advertise unconditional gasless; a 'simulate-only'
    // chain must hedge — the badge text must DIFFER so the user is not misled.
    renderForm({ gasless: 'verified' });
    const verifiedText = screen.getByTestId('gasless-badge').textContent ?? '';
    expect(verifiedText.toLowerCase()).toContain('gasless');

    vi.restoreAllMocks();
    renderForm({ gasless: 'simulate-only' });
    const simText = screen.getAllByTestId('gasless-badge').at(-1)?.textContent ?? '';
    expect(simText.toLowerCase()).toContain('gasless');
    expect(simText).not.toBe(verifiedText);
    expect(simText.toLowerCase()).toContain('simulation');
  });

  it('disables the confirm control while a submit is in flight', async () => {
    // Re-clicking confirm mid-submit risks a double-spend; the control must be
    // disabled across the simulating/submitting stages.
    const gate = deferred<ContextSendResult>();
    const send = vi.fn(() => gate.promise);
    renderForm({ sendSameChain: send });
    await act(async () => {
      fillAndSend({ amount: '5', chainId: '0' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    expect(screen.getByTestId('send-confirm')).toBeDisabled();
    await act(async () => {
      gate.resolve(OK_RESULT);
      await gate.promise;
    });
  });

  it('shows the request key and a success affordance on success', async () => {
    const send = vi.fn(async () => OK_RESULT);
    const onSuccess = vi.fn();
    renderForm({ sendSameChain: send, onSuccess });
    await act(async () => {
      fillAndSend({ amount: '5', chainId: '0' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-success')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('send-success')).toHaveTextContent('rk-abc');
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('renders the distinct gas-payer-rejected message with the self-paid fallback affordance, not success', async () => {
    // A sponsor rejection is NOT a failure-to-send and NOT a success; it must
    // get its own message + an informational self-paid fallback when flagged.
    const send = vi.fn(
      async (): Promise<ContextSendResult> => ({
        ok: false,
        reason: 'gas-payer-rejected',
        detail: 'rate-limited',
        selfPaidFallbackPossible: true,
      }),
    );
    renderForm({ sendSameChain: send });
    await act(async () => {
      fillAndSend({ amount: '5', chainId: '0' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-gas-payer-rejected')).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('send-gas-payer-rejected'),
    ).toHaveTextContent(/gas-payer/i);
    expect(screen.getByTestId('send-self-paid-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('send-success')).not.toBeInTheDocument();
  });

  it('omits the self-paid fallback affordance when not flagged possible', async () => {
    const send = vi.fn(
      async (): Promise<ContextSendResult> => ({
        ok: false,
        reason: 'gas-payer-rejected',
        detail: 'ineligible',
        selfPaidFallbackPossible: false,
      }),
    );
    renderForm({ sendSameChain: send });
    await act(async () => {
      fillAndSend({ amount: '5', chainId: '0' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-gas-payer-rejected')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('send-self-paid-fallback'),
    ).not.toBeInTheDocument();
  });

  it('shows a distinct submitted-confirmation-unknown message (not success) on pending', async () => {
    // A lost response after submit is ambiguous (tx may be on-chain); pending
    // must read as "submitted, unknown" — never success, never a re-send button.
    const send = vi.fn(() => Promise.reject(new Error('socket hangup')));
    renderForm({ sendSameChain: send });
    await act(async () => {
      fillAndSend({ amount: '5', chainId: '0' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-pending')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('send-success')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-pending')).toHaveTextContent(/submitted/i);
  });

  it('does not log the recipient or amount as telemetry', async () => {
    const send = vi.fn(async () => OK_RESULT);
    renderForm({ sendSameChain: send });
    await act(async () => {
      fillAndSend({ amount: '0.000000000001', chainId: '0' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    const logged = [errorSpy, logSpy, warnSpy].flatMap((s) =>
      s.mock.calls.flat().map((a: unknown) => String(a)),
    );
    expect(logged.some((m) => m.includes(RECIPIENT))).toBe(false);
    expect(logged.some((m) => m.includes('0.000000000001'))).toBe(false);
  });

  /**
   * A platform scanner double. `available` gates whether the affordance renders;
   * `result` is what a tap on it resolves to. Mirrors the real `QrScanner`
   * contract exactly: both methods always RESOLVE (never reject).
   */
  function mockScanner(opts: {
    available: boolean;
    result?: QrScanResult;
  }): QrScanner {
    return {
      isAvailable: () => Promise.resolve(opts.available),
      scan: () =>
        Promise.resolve(
          opts.result ?? { ok: false, reason: 'unavailable' },
        ),
    };
  }

  it('hides the scan affordance when no camera-backed scanner is available (web/extension)', async () => {
    // On web/extension the injected scanner is UnsupportedQrScanner (isAvailable
    // false). The Send form must degrade to manual-entry-only — no scan button —
    // so the shared form renders identically there with no platform fork.
    renderForm({ qrScanner: mockScanner({ available: false }) });
    // The capability probe resolves in an effect; assert the button stays absent
    // even after that microtask settles.
    await waitFor(() =>
      expect(screen.getByTestId('send-recipient')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('send-scan-qr')).not.toBeInTheDocument();
  });

  it('shows the scan affordance only after the injected scanner reports available (mobile)', async () => {
    // The mobile app injects a camera-backed scanner; the affordance appears so
    // the user can scan a recipient QR instead of typing a 66-char address.
    renderForm({ qrScanner: mockScanner({ available: true }) });
    await waitFor(() =>
      expect(screen.getByTestId('send-scan-qr')).toBeInTheDocument(),
    );
  });

  it('pre-fills the recipient from a valid scanned k: address WITHOUT touching the chain selection', async () => {
    // A scanned value is untrusted input: a VALID k:+64-hex pre-fills the
    // recipient (the same gate typed input passes) but must NOT auto-select a
    // chain — chain stays an explicit user choice (RR#11).
    const SCANNED =
      'k:2222222222222222222222222222222222222222222222222222222222222222';
    renderForm({
      qrScanner: mockScanner({
        available: true,
        result: { ok: true, value: SCANNED },
      }),
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-scan-qr')).toBeInTheDocument(),
    );
    // Move the chain off its default so a stray "set chain on scan" would show.
    fireEvent.change(screen.getByTestId('send-chain'), {
      target: { value: '4' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-scan-qr'));
    });
    expect(screen.getByTestId('send-recipient')).toHaveValue(SCANNED);
    // The scanned address carries no chain — the explicit selection is untouched.
    expect(screen.getByTestId('send-chain')).toHaveValue('4');
    expect(
      screen.queryByTestId('send-scan-invalid'),
    ).not.toBeInTheDocument();
  });

  it('shows a distinct invalid-address message and does NOT pre-fill on a garbage scan', async () => {
    // A QR can encode anything; a non-k: payload must surface a distinct "not a
    // valid StoaChain address" message and leave the recipient field empty —
    // never silently pre-fill garbage that would later fail at send.
    renderForm({
      qrScanner: mockScanner({
        available: true,
        result: { ok: true, value: 'https://evil.example/not-an-address' },
      }),
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-scan-qr')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-scan-qr'));
    });
    expect(screen.getByTestId('send-scan-invalid')).toHaveTextContent(
      /valid StoaChain address/i,
    );
    expect(screen.getByTestId('send-recipient')).toHaveValue('');
  });

  it('shows the distinct invalid-address message on an oversized/adversarial QR (invalid-payload, not a silent no-op)', async () => {
    // T8.7/M-1: the scanner bounds an oversized/non-ASCII QR to `invalid-payload`
    // (distinct from `unavailable`). The form must map it to the SAME "not a valid
    // StoaChain address" feedback the garbage-k: path shows — never a silent
    // no-op that would leave the user wondering why the scan did nothing.
    renderForm({
      qrScanner: mockScanner({
        available: true,
        result: { ok: false, reason: 'invalid-payload' },
      }),
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-scan-qr')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-scan-qr'));
    });
    expect(screen.getByTestId('send-scan-invalid')).toHaveTextContent(
      /valid StoaChain address/i,
    );
    expect(screen.getByTestId('send-recipient')).toHaveValue('');
  });

  it('shows the distinct camera-permission message and keeps manual entry on permission-denied', async () => {
    // A denied camera permission is not a crash and not a silent no-op: the user
    // gets an honest "enable it in Settings, or enter manually" message AND the
    // recipient input stays usable for manual entry.
    renderForm({
      qrScanner: mockScanner({
        available: true,
        result: { ok: false, reason: 'permission-denied' },
      }),
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-scan-qr')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-scan-qr'));
    });
    expect(screen.getByTestId('send-scan-permission')).toHaveTextContent(
      /camera access/i,
    );
    // Manual entry remains the fallback path.
    const recipient = screen.getByTestId('send-recipient');
    fireEvent.change(recipient, { target: { value: RECIPIENT } });
    expect(recipient).toHaveValue(RECIPIENT);
  });

  it('returns silently to manual entry on a cancelled scan (no message, no pre-fill)', async () => {
    // Cancelling the scanner is a deliberate user action, not an error — the form
    // must show NO message and leave the recipient untouched.
    renderForm({
      qrScanner: mockScanner({
        available: true,
        result: { ok: false, reason: 'cancelled' },
      }),
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-scan-qr')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-scan-qr'));
    });
    expect(screen.queryByTestId('send-scan-invalid')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('send-scan-permission'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('send-recipient')).toHaveValue('');
  });
});
