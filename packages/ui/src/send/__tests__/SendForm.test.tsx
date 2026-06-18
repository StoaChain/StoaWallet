import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import {
  listAddressBook,
  saveAddressBookEntry,
  type StorageAdapter,
} from '@stoawallet/core';
import { coreInfo } from '@stoawallet/core';
import type {
  ConfirmSendResult,
  GaslessGating,
  PollProofAndContinueResult,
  QrScanner,
  QrScanResult,
} from '@stoawallet/core';
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
import { ToastProvider } from '../../toast/ToastContext';
import { ToastViewport } from '../../toast/ToastViewport';
import { SendForm } from '../SendForm';
import type {
  ContextSendParams,
  ContextSendResult,
} from '../../context/WalletContext';
import type {
  ContextCrossChainStep0Result,
  UseCrossChainTransferOptions,
} from '../../crosschain/useCrossChainTransfer';

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
  /**
   * The on-chain confirmation op. Defaults to a NEVER-resolving stub so a
   * submitted send sits in `confirming` for the duration of the test without an
   * async post-resolution setState (and never the live network). The
   * confirmation-lifecycle tests inject a controllable stub.
   */
  awaitConfirmation?: (
    requestKey: string,
    chainId: string,
  ) => Promise<ConfirmSendResult>;
  /** Cross-chain hook stubs (step-0 op + SPV poll) for the cross-chain path. */
  crossChainHookOptions?: UseCrossChainTransferOptions;
  /** The FIXED source chain (the selected chain Send leaves from). Defaults to '0'. */
  sourceChain?: string;
  /** Spendable balance for the source chain (for the Balance line + Max button). */
  getAvailableBalance?: (chainId: string) => string | null;
  /** A pre-seeded storage adapter (e.g. with address-book entries) to inspect. */
  storage?: StorageAdapter;
  /** Wrap in a ToastProvider + render the ToastViewport so toasts are assertable. */
  withToast?: boolean;
  /** Unlock the source chain selector (the Cross-chain action passes false). */
  lockSource?: boolean;
} = {}): StorageAdapter {
  const gasless =
    typeof opts.gasless === 'string'
      ? () => opts.gasless as GaslessGating
      : opts.gasless;
  const storage = opts.storage ?? new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider
      storage={storage}
      keyVault={keyVault}
      qrScanner={opts.qrScanner}
    >
      {opts.withToast ? (
        <ToastProvider>
          {children}
          <ToastViewport />
        </ToastProvider>
      ) : (
        children
      )}
    </WalletProvider>
  );
  render(
    <Wrapper>
      <SendForm
        hookOptions={{
          sendSameChain: opts.sendSameChain,
          gasless,
          onSuccess: opts.onSuccess,
          getAvailableBalance: opts.getAvailableBalance,
          awaitConfirmation:
            opts.awaitConfirmation ?? (() => new Promise<ConfirmSendResult>(() => {})),
        }}
        sourceChain={opts.sourceChain}
        lockSource={opts.lockSource}
        crossChainHookOptions={opts.crossChainHookOptions}
      />
    </Wrapper>,
  );
  return storage;
}

/** Pick the DESTINATION chain (the only chain selector in Send). */
function setDestination(to: string): void {
  fireEvent.change(screen.getByTestId('send-chain'), { target: { value: to } });
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

  it('sends on the FIXED source chain (the selected chain), forwarding it to the send op', async () => {
    // Send locks the source to the selected chain (Chain 7 here); with the
    // destination defaulting to it, the same-chain send op must receive chain 7.
    const send = vi.fn(async () => OK_RESULT);
    renderForm({ sendSameChain: send, sourceChain: '7' });
    await act(async () => {
      fillAndSend({ amount: '5' }); // destination stays = source (7) → same-chain
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

  // ── Review-send gating ──

  it('disables Review send when the amount is zero (0 / 0.0)', () => {
    renderForm();
    fireEvent.change(screen.getByTestId('send-recipient'), {
      target: { value: RECIPIENT },
    });
    fireEvent.change(screen.getByTestId('send-amount'), {
      target: { value: '0.0' },
    });
    expect(screen.getByTestId('send-submit')).toBeDisabled();
    // A real positive amount enables it.
    fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '1' } });
    expect(screen.getByTestId('send-submit')).toBeEnabled();
  });

  it('disables Review send when no recipient is entered', () => {
    renderForm();
    fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '5' } });
    // No recipient yet → gated.
    expect(screen.getByTestId('send-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('send-recipient'), {
      target: { value: RECIPIENT },
    });
    expect(screen.getByTestId('send-submit')).toBeEnabled();
  });

  it('keeps Review send disabled for a malformed (non-k:) recipient', () => {
    renderForm();
    fireEvent.change(screen.getByTestId('send-recipient'), {
      target: { value: 'not-a-k-account' },
    });
    fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '5' } });
    expect(screen.getByTestId('send-submit')).toBeDisabled();
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

  it('shows a "confirming on-chain" indicator after submit while the outcome is unresolved', async () => {
    // The gap the user hit: after submit there was no feedback. The form must now
    // show a live "confirming on-chain" indicator until the mined result lands.
    const send = vi.fn(async () => OK_RESULT);
    renderForm({ sendSameChain: send }); // default never-resolving confirmation
    await act(async () => {
      fillAndSend({ amount: '5', chainId: '0' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-confirming')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('send-confirming')).toHaveTextContent(/confirming/i);
  });

  it('resolves to a CONFIRMED state with an explorer link once the tx is mined', async () => {
    const send = vi.fn(async () => OK_RESULT);
    const confirm = vi.fn(
      async (): Promise<ConfirmSendResult> => ({ ok: true, status: 'confirmed' }),
    );
    renderForm({ sendSameChain: send, awaitConfirmation: confirm });
    await act(async () => {
      fillAndSend({ amount: '5', chainId: '0' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-confirmed')).toBeInTheDocument(),
    );
    expect(confirm).toHaveBeenCalledWith('rk-abc', '0');
    const link = screen.getByTestId('send-explorer-link');
    expect(link).toHaveAttribute(
      'href',
      'https://explorer.stoachain.com/transactions/rk-abc',
    );
  });

  it('shows a distinct on-chain FAILED state with the reason when the tx fails on chain', async () => {
    const send = vi.fn(async () => OK_RESULT);
    const confirm = vi.fn(
      async (): Promise<ConfirmSendResult> => ({
        ok: true,
        status: 'failed',
        detail: 'insufficient funds',
      }),
    );
    renderForm({ sendSameChain: send, awaitConfirmation: confirm });
    await act(async () => {
      fillAndSend({ amount: '5', chainId: '0' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-failed-onchain')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('send-failed-onchain')).toHaveTextContent(
      /insufficient funds/i,
    );
  });

  it('shows an honest "couldn\'t confirm" state (not failure) when the listen times out', async () => {
    // A confirmation timeout is NOT an on-chain failure — the tx may still be
    // processing. The form must say so and point to the explorer, never resubmit.
    const send = vi.fn(async () => OK_RESULT);
    const confirm = vi.fn(
      async (): Promise<ConfirmSendResult> => ({ ok: false, reason: 'timeout' }),
    );
    renderForm({ sendSameChain: send, awaitConfirmation: confirm });
    await act(async () => {
      fillAndSend({ amount: '5', chainId: '0' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-unconfirmed')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('send-failed-onchain')).not.toBeInTheDocument();
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

  // ── Cross-chain from the Send button ──

  it('shows the FIXED source chain and stays same-chain when the destination equals it', async () => {
    // The source is fixed to the selected chain (Chain 4) and shown read-only; the
    // destination defaults to it, so the resting state is a same-chain send — the
    // gasless badge shows, not the cross-chain note. There is no source selector.
    const send = vi.fn(async () => OK_RESULT);
    renderForm({ sendSameChain: send, gasless: 'verified', sourceChain: '4' });
    expect(screen.getByTestId('send-source-chain')).toHaveTextContent('Chain 4');
    expect(screen.getByTestId('send-chain')).toHaveValue('4');
    expect(screen.queryByTestId('send-crosschain-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('gasless-badge')).toBeInTheDocument();
  });

  it('switches to a fully-sponsored cross-chain transfer when the destination differs, and drives it to completion', async () => {
    // Picking a destination different from the (fixed) source routes the Send
    // button through the cross-chain flow (step-0 burn → SPV → continuation) — the
    // SAME sponsored core path the dedicated Cross-chain action uses.
    const step0 = vi.fn(
      async (): Promise<ContextCrossChainStep0Result> => ({
        ok: true,
        requestKey: 'rk-step0',
        sourceChain: '0',
        targetChain: '1',
      }),
    );
    const poll = vi.fn(
      async (): Promise<PollProofAndContinueResult> => ({
        ok: true,
        continuationKey: 'ck-done',
      }),
    );
    const sameChainSend = vi.fn(async () => OK_RESULT);
    renderForm({
      sendSameChain: sameChainSend,
      sourceChain: '0',
      crossChainHookOptions: {
        sendCrossChainStep0: step0,
        pollProofAndContinue: poll,
      },
    });

    // Destination 1 (source fixed at 0) reveals the cross-chain disclosure.
    await act(async () => {
      setDestination('1');
    });
    expect(screen.getByTestId('send-crosschain-note')).toBeInTheDocument();
    expect(screen.queryByTestId('gasless-badge')).not.toBeInTheDocument();

    // Review → the cross-chain preview shows the route, then confirm fires step-0.
    await act(async () => {
      fillAndSend({ amount: '3.25' });
    });
    const preview = screen.getByTestId('send-xchain-preview');
    expect(preview).toHaveTextContent('Chain 0 → Chain 1');
    expect(sameChainSend).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('send-xchain-confirm'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('send-xchain-success')).toBeInTheDocument(),
    );
    expect(step0).toHaveBeenCalledWith(
      expect.objectContaining({ sourceChain: '0', targetChain: '1', amount: '3.25' }),
    );
    expect(screen.getByTestId('send-xchain-success')).toHaveTextContent('ck-done');
  });

  // ── Gas sponsorship disclosure ──

  it('discloses same-chain gas is sponsored by the Ouronet Gas Station (full balance sendable)', () => {
    renderForm({ sourceChain: '0', gasless: 'verified' });
    const sponsorship = screen.getByTestId('send-sponsorship');
    expect(sponsorship).toHaveTextContent(/Ouronet Gas Station/i);
    expect(sponsorship).toHaveTextContent(/full balance/i);
    const link = within(sponsorship).getByRole('link', {
      name: /Ouronet Gas Station/i,
    });
    expect(link).toHaveAttribute(
      'href',
      'https://explorer.stoachain.com/accounts/c:iQQFWj6gWtpGEzhM_O5ekW1QtnQQy55R8BRPGhj_0FU',
    );
  });

  it('discloses the cross-chain 2-step gas model from chain 0: Step 0 GasStation, Step 1 kadena-xchain-gas', async () => {
    renderForm({ sourceChain: '0' });
    await act(async () => {
      setDestination('1');
    });
    const note = screen.getByTestId('send-crosschain-note');
    expect(note).toHaveTextContent(/Step 0/);
    expect(note).toHaveTextContent(/Step 1/);
    // Step 0 (burn from chain 0) → Ouronet Gas Station.
    expect(
      within(note).getByRole('link', { name: /Ouronet Gas Station/i }),
    ).toHaveAttribute(
      'href',
      'https://explorer.stoachain.com/accounts/c:iQQFWj6gWtpGEzhM_O5ekW1QtnQQy55R8BRPGhj_0FU',
    );
    // Step 1 (continuation on the target) → kadena-xchain-gas.
    expect(
      within(note).getByRole('link', { name: /kadena-xchain-gas/i }),
    ).toHaveAttribute(
      'href',
      'https://explorer.stoachain.com/accounts/kadena-xchain-gas',
    );
  });

  it('uses kadena-xchain-gas for Step 0 when the source is NOT chain 0', async () => {
    renderForm({ sourceChain: '5' });
    await act(async () => {
      setDestination('1');
    });
    const note = screen.getByTestId('send-crosschain-note');
    // Both legs are kadena-xchain-gas when leaving a non-zero chain (no GasStation).
    expect(note).not.toHaveTextContent(/Ouronet Gas Station/i);
    const xchainLinks = within(note).getAllByRole('link', {
      name: /kadena-xchain-gas/i,
    });
    expect(xchainLinks).toHaveLength(2);
  });

  // ── Editable source (Cross-chain action) ──

  it('locks the source by default (Send) — the From chain is a read-only chip', () => {
    renderForm({ sourceChain: '4' });
    expect(screen.getByTestId('send-source-chain').tagName).not.toBe('SELECT');
    expect(screen.getByTestId('send-source-chain')).toHaveTextContent('Chain 4');
  });

  it('UNLOCKS the source when lockSource is false (Cross-chain), keeping source ≠ destination', async () => {
    renderForm({ lockSource: false, sourceChain: '0' });
    const from = screen.getByTestId('send-source-chain') as HTMLSelectElement;
    expect(from.tagName).toBe('SELECT');

    // Pick a different destination → cross-chain.
    await act(async () => {
      setDestination('1');
    });
    expect(screen.getByTestId('send-crosschain-note')).toHaveTextContent(
      'Chain 0 → Chain 1',
    );

    // Change the SOURCE onto the destination (1) → the destination bumps off it.
    await act(async () => {
      fireEvent.change(from, { target: { value: '1' } });
    });
    expect((screen.getByTestId('send-chain') as HTMLSelectElement).value).not.toBe(
      '1',
    );
  });

  // ── Source balance + Max ──

  it('shows the source-chain balance under the amount and Max fills it', async () => {
    renderForm({ sourceChain: '0', getAvailableBalance: () => '12.5' });
    const balance = screen.getByTestId('send-source-balance');
    expect(balance).toHaveTextContent('Balance on #0');
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-max'));
    });
    expect(screen.getByTestId('send-amount')).toHaveValue('12.5');
  });

  it('disables Max when the source balance is unknown', () => {
    renderForm({ sourceChain: '0', getAvailableBalance: () => null });
    expect(screen.getByTestId('send-max')).toBeDisabled();
  });

  // ── Send to self ──

  it('Send to self locks the recipient, advances the destination, and forces cross-chain', async () => {
    renderForm({ sourceChain: '0' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-self-toggle'));
    });
    // Recipient is locked (filled from the sender, not editable).
    expect(screen.getByTestId('send-recipient')).toBeDisabled();
    // Destination advanced to the next chain → cross-chain.
    expect(screen.getByTestId('send-chain')).toHaveValue('1');
    expect(screen.getByTestId('send-crosschain-note')).toBeInTheDocument();
    // The source chain cannot be chosen as the destination while self is on.
    const sourceOption = within(screen.getByTestId('send-chain')).getByRole(
      'option',
      { name: /Chain 0/ },
    );
    expect(sourceOption).toBeDisabled();
  });

  // ── Address book ──

  it('picks a saved recipient from the address-book dropdown', async () => {
    const storage = new InMemoryStorageAdapter();
    await saveAddressBookEntry(storage, { name: 'Alice', address: RECIPIENT });
    renderForm({ storage });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-book-toggle'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-book-entry')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('send-book-entry')).toHaveTextContent('Alice');
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-book-entry'));
    });
    expect(screen.getByTestId('send-recipient')).toHaveValue(RECIPIENT);
  });

  it('offers to save an UNKNOWN recipient after a successful send, and persists it', async () => {
    const storage = new InMemoryStorageAdapter();
    const send = vi.fn(async () => OK_RESULT);
    renderForm({ sendSameChain: send, storage });
    await act(async () => {
      fillAndSend({ amount: '5' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-save-address')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.change(screen.getByTestId('send-save-name'), {
        target: { value: 'Bob' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-save-confirm'));
    });
    await waitFor(async () => {
      expect(await listAddressBook(storage)).toEqual([
        { name: 'Bob', address: RECIPIENT },
      ]);
    });
  });

  // ── Transaction toast ──

  it('raises a self-dismissing toast: PENDING on submit, then CONFIRMED ✓ with explorer link', async () => {
    const send = vi.fn(async () => OK_RESULT);
    const gate = deferred<ConfirmSendResult>();
    const confirm = vi.fn(() => gate.promise);
    renderForm({ sendSameChain: send, awaitConfirmation: confirm, withToast: true });
    await act(async () => {
      fillAndSend({ amount: '5' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    // A pending toast appears immediately on submit.
    await waitFor(() =>
      expect(screen.getByTestId('toast')).toHaveAttribute('data-status', 'pending'),
    );
    // Once the on-chain outcome resolves, the SAME toast flips to success.
    await act(async () => {
      gate.resolve({ ok: true, status: 'confirmed' });
      await gate.promise;
    });
    await waitFor(() =>
      expect(screen.getByTestId('toast')).toHaveAttribute('data-status', 'success'),
    );
    expect(screen.getByTestId('toast')).toHaveTextContent(/confirmed/i);
    expect(screen.getByTestId('toast-explorer-link')).toHaveAttribute(
      'href',
      'https://explorer.stoachain.com/transactions/rk-abc',
    );
  });

  it('raises an ERROR toast when the transaction fails on-chain', async () => {
    const send = vi.fn(async () => OK_RESULT);
    const confirm = vi.fn(
      async (): Promise<ConfirmSendResult> => ({
        ok: true,
        status: 'failed',
        detail: 'insufficient funds',
      }),
    );
    renderForm({ sendSameChain: send, awaitConfirmation: confirm, withToast: true });
    await act(async () => {
      fillAndSend({ amount: '5' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('toast')).toHaveAttribute('data-status', 'error'),
    );
    expect(screen.getByTestId('toast')).toHaveTextContent(/failed/i);
  });

  it('does NOT offer to save a recipient already in the address book', async () => {
    const storage = new InMemoryStorageAdapter();
    await saveAddressBookEntry(storage, { name: 'Known', address: RECIPIENT });
    const send = vi.fn(async () => OK_RESULT);
    renderForm({ sendSameChain: send, storage });
    await act(async () => {
      fillAndSend({ amount: '5' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('send-success')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('send-save-address')).not.toBeInTheDocument();
  });
});
