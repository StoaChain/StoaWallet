import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { coreInfo, type StoredAccount } from '@stoawallet/core';
import type {
  PollProofAndContinueParams,
  PollProofAndContinueResult,
} from '@stoawallet/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WalletProvider,
  useWallet,
  type ContextCrossChainParams,
  type ContextCrossChainStep0Result,
  type WalletContextValue,
} from '../../context/WalletContext';
import { CrossChainTransferForm } from '../CrossChainTransferForm';

const PASSWORD = 'correct horse battery staple';

const CUSTOM_RECEIVER =
  'k:2222222222222222222222222222222222222222222222222222222222222222';

/** A deferred promise whose resolve is exposed for manual staged-state control. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const STEP0_OK: ContextCrossChainStep0Result = {
  ok: true,
  requestKey: 'rk-step0',
  sourceChain: '0',
  targetChain: '1',
};

const POLL_OK: PollProofAndContinueResult = {
  ok: true,
  continuationKey: 'ck-done',
};

/**
 * Render the form inside a real WalletProvider with a control probe, injecting
 * the hook's options so the form drives a STUBBED step-0 + poll op without
 * touching key material. The probe onboards a real wallet so the form's
 * SELF-receiver default reads the genuinely derived active k: account.
 */
function renderForm(
  opts: {
    step0?: (params: ContextCrossChainParams) => Promise<ContextCrossChainStep0Result>;
    poll?: (
      params: PollProofAndContinueParams,
      deps?: undefined,
      options?: { onProgress?: (a: number, m: number) => void },
    ) => Promise<PollProofAndContinueResult>;
    onRouteToRecovery?: (params: {
      requestKey: string;
      sourceChain: string;
      targetChain: string;
    }) => void;
    onRequireUnlock?: () => void;
  } = {},
) {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const ctl: { current: WalletContextValue | null } = { current: null };

  function Probe(): null {
    ctl.current = useWallet();
    return null;
  }

  render(
    <WalletProvider storage={storage} keyVault={keyVault}>
      <Probe />
      <CrossChainTransferForm
        hookOptions={{
          sendCrossChainStep0: opts.step0,
          pollProofAndContinue: opts.poll,
        }}
        onRouteToRecovery={opts.onRouteToRecovery}
        onRequireUnlock={opts.onRequireUnlock}
      />
    </WalletProvider>,
  );

  return { ctl, storage, keyVault };
}

async function onboard(ctl: { current: WalletContextValue | null }) {
  await act(async () => {
    await ctl.current!.startCreate();
    await ctl.current!.saveWallet(PASSWORD);
  });
}

/** Set source + target chain selectors and submit the preview form. */
function configureAndPreview(params: {
  source?: string;
  target?: string;
  amount: string;
}): void {
  if (params.source !== undefined) {
    fireEvent.change(screen.getByTestId('xchain-source'), {
      target: { value: params.source },
    });
  }
  if (params.target !== undefined) {
    fireEvent.change(screen.getByTestId('xchain-target'), {
      target: { value: params.target },
    });
  }
  fireEvent.change(screen.getByTestId('xchain-amount'), {
    target: { value: params.amount },
  });
  fireEvent.click(screen.getByTestId('xchain-submit'));
}

describe('CrossChainTransferForm', () => {
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

  it('renders every StoaChain braided chain (10) in BOTH the source and target selectors', async () => {
    // Both selectors are the sole drivers of which chains a transfer bridges;
    // each must enumerate every braided chain (10), never a hardcoded subset.
    const { ctl } = renderForm();
    await onboard(ctl);
    const source = screen.getByTestId('xchain-source') as HTMLSelectElement;
    const target = screen.getByTestId('xchain-target') as HTMLSelectElement;
    expect(source.options).toHaveLength(coreInfo.chainCount);
    expect(target.options).toHaveLength(coreInfo.chainCount);
    expect(coreInfo.chainCount).toBe(10);
  });

  it('disables the target chip matching the selected source so source ≠ target', async () => {
    // A same-chain "cross-chain" transfer is nonsensical; selecting source "3"
    // must DISABLE the target option "3" so the user can never pick it.
    const { ctl } = renderForm();
    await onboard(ctl);
    fireEvent.change(screen.getByTestId('xchain-source'), {
      target: { value: '3' },
    });
    const target = screen.getByTestId('xchain-target') as HTMLSelectElement;
    const disabledOption = Array.from(target.options).find(
      (o) => o.value === '3',
    );
    expect(disabledOption?.disabled).toBe(true);
    const otherOption = Array.from(target.options).find((o) => o.value === '5');
    expect(otherOption?.disabled).toBe(false);
  });

  it('discloses a DIFFERENT gas mode for source "0" (gas station) vs source "5" (xchain-gas)', async () => {
    // Source 0 routes gas through the Ouronet Gas Station; any other source
    // uses kadena-xchain-gas. The disclosure text must DIFFER so the user knows
    // who pays — a frozen single message would mislead on one of the paths.
    const { ctl } = renderForm();
    await onboard(ctl);
    fireEvent.change(screen.getByTestId('xchain-source'), {
      target: { value: '0' },
    });
    const gasStationText =
      screen.getByTestId('xchain-gas-mode').textContent ?? '';
    expect(gasStationText.toLowerCase()).toContain('gas station');

    fireEvent.change(screen.getByTestId('xchain-source'), {
      target: { value: '5' },
    });
    const xchainGasText =
      screen.getByTestId('xchain-gas-mode').textContent ?? '';
    expect(xchainGasText.toLowerCase()).toContain('xchain-gas');
    expect(xchainGasText).not.toBe(gasStationText);
  });

  it('shows the preview before confirm and does NOT call transfer until confirmed', async () => {
    // The preview is the user's last review of receiver/amount/route/gas before
    // money moves; the step-0 burn must NOT run until explicit confirm.
    const step0 = vi.fn(async () => STEP0_OK);
    const { ctl } = renderForm({ step0, poll: vi.fn(async () => POLL_OK) });
    await onboard(ctl);
    const account = ctl.current!.activeAccount as StoredAccount;

    await act(async () => {
      configureAndPreview({ source: '0', target: '1', amount: '3.25' });
    });

    const preview = screen.getByTestId('xchain-preview');
    // The SELF receiver default surfaces the active k: account in the review.
    expect(preview).toHaveTextContent(account.account);
    expect(preview).toHaveTextContent('3.25');
    expect(step0).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('xchain-confirm'));
    });
    expect(step0).toHaveBeenCalledTimes(1);
    expect(step0).toHaveBeenCalledWith(
      expect.objectContaining({
        receiver: account.account,
        amount: '3.25',
        sourceChain: '0',
        targetChain: '1',
      }),
    );
  });

  it('forwards a 12-decimal amount string to the transfer op intact', async () => {
    // 12-decimal precision is money: the amount must reach the hook verbatim —
    // no Number()/round/truncate that would silently alter the value.
    const step0 = vi.fn(async () => STEP0_OK);
    const { ctl } = renderForm({ step0, poll: vi.fn(async () => POLL_OK) });
    await onboard(ctl);

    await act(async () => {
      configureAndPreview({ source: '0', target: '1', amount: '0.000000000001' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('xchain-confirm'));
    });
    expect(step0).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '0.000000000001' }),
    );
  });

  it('sends to a CUSTOM receiver when the user overrides the SELF default', async () => {
    // The default is SELF, but a user bridging to another address must be able
    // to override it — the typed custom k: must be the one that moves.
    const step0 = vi.fn(async () => STEP0_OK);
    const { ctl } = renderForm({ step0, poll: vi.fn(async () => POLL_OK) });
    await onboard(ctl);

    fireEvent.click(screen.getByTestId('xchain-receiver-custom'));
    fireEvent.change(screen.getByTestId('xchain-receiver-input'), {
      target: { value: CUSTOM_RECEIVER },
    });
    await act(async () => {
      configureAndPreview({ source: '0', target: '1', amount: '5' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('xchain-confirm'));
    });
    expect(step0).toHaveBeenCalledWith(
      expect.objectContaining({ receiver: CUSTOM_RECEIVER }),
    );
  });

  it('renders the live SPV attempt/max counter while waiting-spv (not a frozen spinner)', async () => {
    // The ~120s block-finality wait must show PROGRESS (n/30) from the poll's
    // onProgress, so the user sees the wait advancing, not a hung spinner.
    const step0 = vi.fn(async () => STEP0_OK);
    let progress: ((a: number, m: number) => void) | undefined;
    const pollDef = deferred<PollProofAndContinueResult>();
    const poll = vi.fn(
      (
        _p: PollProofAndContinueParams,
        _d: undefined,
        options?: { onProgress?: (a: number, m: number) => void },
      ) => {
        progress = options?.onProgress;
        return pollDef.promise;
      },
    );
    const { ctl } = renderForm({ step0, poll });
    await onboard(ctl);

    await act(async () => {
      configureAndPreview({ source: '0', target: '1', amount: '5' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('xchain-confirm'));
    });

    await waitFor(() => expect(progress).toBeDefined());
    await act(async () => {
      progress!(7, 30);
    });

    const stage = screen.getByTestId('xchain-stage');
    expect(stage).toHaveTextContent('7');
    expect(stage).toHaveTextContent('30');

    await act(async () => {
      pollDef.resolve(POLL_OK);
      await pollDef.promise;
    });
  });

  it('disables the confirm control while a transfer is in flight', async () => {
    // Re-clicking confirm mid-flight risks a double-burn; the control must be
    // disabled across building/submitting/waiting-spv/completing.
    const step0 = vi.fn(async () => STEP0_OK);
    const pollDef = deferred<PollProofAndContinueResult>();
    const poll = vi.fn(() => pollDef.promise);
    const { ctl } = renderForm({ step0, poll });
    await onboard(ctl);

    await act(async () => {
      configureAndPreview({ source: '0', target: '1', amount: '5' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('xchain-confirm'));
    });
    expect(screen.getByTestId('xchain-confirm')).toBeDisabled();

    await act(async () => {
      pollDef.resolve(POLL_OK);
      await pollDef.promise;
    });
  });

  it('on DONE shows the continuation key and a success affordance', async () => {
    const step0 = vi.fn(async () => STEP0_OK);
    const poll = vi.fn(async () => POLL_OK);
    const { ctl } = renderForm({ step0, poll });
    await onboard(ctl);

    await act(async () => {
      configureAndPreview({ source: '0', target: '1', amount: '5' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('xchain-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('xchain-success')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('xchain-success')).toHaveTextContent('ck-done');
  });

  it('on PENDING shows the requestKey + a Continue-tab recovery affordance, NOT success and NO resubmit control', async () => {
    // A pending transfer carries an UNCONFIRMED burn (the tx may have committed);
    // it must read as PENDING, surface the request key + a route-to-recovery
    // affordance, and offer NO re-send and NO success — re-burning would double-spend.
    const step0 = vi.fn(
      async (): Promise<ContextCrossChainStep0Result> => ({
        ok: false,
        reason: 'network-lost-pending',
        requestKey: 'rk-pending',
      }),
    );
    const onRouteToRecovery = vi.fn();
    const { ctl } = renderForm({ step0, onRouteToRecovery });
    await onboard(ctl);

    await act(async () => {
      configureAndPreview({ source: '0', target: '1', amount: '5' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('xchain-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('xchain-pending')).toBeInTheDocument(),
    );

    const pending = screen.getByTestId('xchain-pending');
    expect(pending).toHaveTextContent('rk-pending');
    expect(pending).toHaveTextContent(/pending/i);
    expect(screen.queryByTestId('xchain-success')).not.toBeInTheDocument();
    // No re-send-step-0 control is present in the pending landing.
    expect(screen.queryByTestId('xchain-confirm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('xchain-submit')).not.toBeInTheDocument();

    // The Continue-tab affordance routes to recovery with the burn's identity
    // PREFILLED — the exact ResumeParams shape T5.8 consumes.
    fireEvent.click(screen.getByTestId('xchain-continue'));
    expect(onRouteToRecovery).toHaveBeenCalledWith({
      requestKey: 'rk-pending',
      sourceChain: '0',
      targetChain: '1',
    });
  });

  it('on a HARD failure shows a clear failure DISTINCT from pending (no recovery affordance)', async () => {
    // A hard step-0 failure means NO tx landed; it must read as a clear failure
    // with a retry, NOT the ambiguous "pending — may have committed" message.
    const step0 = vi.fn(
      async (): Promise<ContextCrossChainStep0Result> => ({
        ok: false,
        reason: 'submit-failed',
      }),
    );
    const { ctl } = renderForm({ step0 });
    await onboard(ctl);

    await act(async () => {
      configureAndPreview({ source: '0', target: '1', amount: '5' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('xchain-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('xchain-error')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('xchain-pending')).not.toBeInTheDocument();
    expect(screen.queryByTestId('xchain-continue')).not.toBeInTheDocument();
  });

  it('on a LOCKED result routes to unlock rather than a generic error', async () => {
    const step0 = vi.fn(
      async (): Promise<ContextCrossChainStep0Result> => ({
        ok: false,
        reason: 'locked',
      }),
    );
    const onRequireUnlock = vi.fn();
    const { ctl } = renderForm({ step0, onRequireUnlock });
    await onboard(ctl);

    await act(async () => {
      configureAndPreview({ source: '0', target: '1', amount: '5' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('xchain-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('xchain-locked')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /unlock/i }));
    expect(onRequireUnlock).toHaveBeenCalledTimes(1);
  });

  it('does not log the receiver or amount as telemetry', async () => {
    const step0 = vi.fn(async () => STEP0_OK);
    const { ctl } = renderForm({ step0, poll: vi.fn(async () => POLL_OK) });
    await onboard(ctl);
    const account = ctl.current!.activeAccount as StoredAccount;

    await act(async () => {
      configureAndPreview({ source: '0', target: '1', amount: '0.000000000001' });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('xchain-confirm'));
    });

    const logged = [errorSpy, logSpy, warnSpy].flatMap((s) =>
      s.mock.calls.flat().map((a: unknown) => String(a)),
    );
    expect(logged.some((m) => m.includes(account.account))).toBe(false);
    expect(logged.some((m) => m.includes('0.000000000001'))).toBe(false);
  });
});
