import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransferUrStoaModal } from '../TransferUrStoaModal';
import type {
  TransferParams,
  TransferPreview,
  TransferState,
  UseTransferUrStoaResult,
} from '../useTransferUrStoa';

/** A well-formed RECIPIENT k:-account distinct from the active sender. */
const RECIPIENT =
  'k:bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';

/**
 * A controllable stand-in for the T12.9 hook. `send`/`confirm`/`reset` are spies;
 * the state/preview a test wants to render are passed in and the harness re-renders
 * the modal so a status transition is visible to RTL.
 */
interface StubControls {
  readonly send: ReturnType<typeof vi.fn>;
  readonly confirm: ReturnType<typeof vi.fn>;
  readonly reset: ReturnType<typeof vi.fn>;
  setState(state: TransferState): void;
  setPreview(preview: TransferPreview | null): void;
}

/**
 * Render the modal with a STUBBED `useTransferUrStoa`. The stub exposes `send`/
 * `confirm`/`reset` spies and lets a test push the hook's `state`/`preview` so the
 * modal's rendering of each staged/terminal state can be asserted in isolation —
 * the modal under test composes the hook, it does not re-implement it.
 */
function renderModal(opts: {
  initialState?: TransferState;
  initialPreview?: TransferPreview | null;
  onRequireUnlock?: () => void;
} = {}): StubControls {
  const send = vi.fn(async (_params: TransferParams) => {});
  const confirm = vi.fn(async () => {});
  const reset = vi.fn();

  const controls: StubControls = {
    send,
    confirm,
    reset,
    setState: () => {},
    setPreview: () => {},
  };

  function Harness(): ReactNode {
    const [state, setState] = useState<TransferState>(
      opts.initialState ?? { status: 'idle' },
    );
    const [preview, setPreview] = useState<TransferPreview | null>(
      opts.initialPreview ?? null,
    );
    controls.setState = setState;
    controls.setPreview = setPreview;

    const hook: UseTransferUrStoaResult = {
      state,
      preview,
      send,
      confirm,
      reset,
    };
    return (
      <TransferUrStoaModal
        open
        onClose={() => {}}
        onRequireUnlock={opts.onRequireUnlock}
        useTransfer={() => hook}
      />
    );
  }

  render(<Harness />);
  return controls;
}

describe('TransferUrStoaModal', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not render its dialog when open is false', () => {
    const send = vi.fn(async () => {});
    render(
      <TransferUrStoaModal
        open={false}
        onClose={() => {}}
        useTransfer={() =>
          ({
            state: { status: 'idle' },
            preview: null,
            send,
            confirm: vi.fn(async () => {}),
            reset: vi.fn(),
          }) as UseTransferUrStoaResult
        }
      />,
    );
    expect(screen.queryByTestId('urstoa-transfer-modal')).toBeNull();
  });

  it('has NO chain selector — UrStoa is chain-0-only', () => {
    renderModal();
    expect(screen.queryByTestId('urstoa-transfer-chain')).toBeNull();
    // The recipient + amount inputs ARE present.
    expect(screen.getByTestId('urstoa-transfer-recipient')).toBeTruthy();
    expect(screen.getByTestId('urstoa-transfer-amount')).toBeTruthy();
  });

  it('calls send({recipient, amount}) with the typed recipient + amount on review', () => {
    const controls = renderModal();

    fireEvent.change(screen.getByTestId('urstoa-transfer-recipient'), {
      target: { value: RECIPIENT },
    });
    fireEvent.change(screen.getByTestId('urstoa-transfer-amount'), {
      target: { value: '12.5' },
    });
    fireEvent.click(screen.getByTestId('urstoa-transfer-submit'));

    expect(controls.send).toHaveBeenCalledTimes(1);
    expect(controls.send).toHaveBeenCalledWith({
      recipient: RECIPIENT,
      amount: '12.5',
    });
  });

  it('passes a 24-decimal amount intact as a STRING (no Number round-trip)', () => {
    const controls = renderModal();
    // 24 fractional digits — a Number() round-trip would lose precision past ~15.
    const PRECISE = '0.123456789012345678901234';

    fireEvent.change(screen.getByTestId('urstoa-transfer-recipient'), {
      target: { value: RECIPIENT },
    });
    fireEvent.change(screen.getByTestId('urstoa-transfer-amount'), {
      target: { value: PRECISE },
    });
    fireEvent.click(screen.getByTestId('urstoa-transfer-submit'));

    const [arg] = controls.send.mock.calls[0] as [TransferParams];
    expect(arg.amount).toBe(PRECISE);
    expect(typeof arg.amount).toBe('string');
    // The exact 24-digit string survives — it never round-tripped through Number.
    expect(arg.amount).toBe(String(PRECISE));
    expect(arg.amount).not.toBe(String(Number(PRECISE)));
  });

  it('does NOT reach confirm() until the user explicitly confirms the preview', () => {
    const controls = renderModal({
      initialState: { status: 'preview' },
      initialPreview: { recipient: RECIPIENT, amount: '12.5' },
    });

    // The preview panel shows the exact recipient + amount to review.
    const previewPanel = screen.getByTestId('urstoa-transfer-preview');
    expect(previewPanel.textContent).toContain(RECIPIENT);
    expect(previewPanel.textContent).toContain('12.5');

    // confirm() has NOT been called merely by reaching the preview.
    expect(controls.confirm).not.toHaveBeenCalled();

    // The user must press the explicit confirm control to sign+submit.
    fireEvent.click(screen.getByTestId('urstoa-transfer-confirm'));
    expect(controls.confirm).toHaveBeenCalledTimes(1);
  });

  it('shows the gasless sponsor + new-account note in the preview', () => {
    renderModal({
      initialState: { status: 'preview' },
      initialPreview: { recipient: RECIPIENT, amount: '1.0' },
    });
    const previewPanel = screen.getByTestId('urstoa-transfer-preview');
    // The sponsor (gas station pays) is disclosed before confirm.
    expect(screen.getByTestId('urstoa-transfer-gasless')).toBeTruthy();
    expect(previewPanel.textContent?.toLowerCase()).toContain('keyset');
  });

  it('shows inline invalid-recipient feedback for a malformed / self-send recipient', () => {
    renderModal({ initialState: { status: 'error', reason: 'invalid-recipient' } });
    const feedback = screen.getByTestId('urstoa-transfer-invalid-recipient');
    expect(feedback.textContent?.toLowerCase()).toContain('recipient');
    // It is NOT a false success and NOT the generic submit error.
    expect(screen.queryByTestId('urstoa-transfer-success')).toBeNull();
    expect(screen.queryByTestId('urstoa-transfer-error')).toBeNull();
  });

  it('shows inline insufficient-funds feedback distinct from a generic error', () => {
    renderModal({ initialState: { status: 'error', reason: 'insufficient-funds' } });
    expect(screen.getByTestId('urstoa-transfer-insufficient-funds')).toBeTruthy();
    expect(screen.queryByTestId('urstoa-transfer-success')).toBeNull();
  });

  it('disables the confirm control while a submit is in-flight (RR#6)', () => {
    const controls = renderModal({
      initialState: { status: 'preview' },
      initialPreview: { recipient: RECIPIENT, amount: '12.5' },
    });

    const confirmBtn = screen.getByTestId(
      'urstoa-transfer-confirm',
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);

    // Once the hook reports building/submitting, the confirm control must be
    // disabled so a second click cannot trigger a double-spend.
    act(() => controls.setState({ status: 'building' }));
    expect(
      (screen.getByTestId('urstoa-transfer-confirm') as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    act(() => controls.setState({ status: 'submitting' }));
    expect(
      (screen.getByTestId('urstoa-transfer-confirm') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('renders a staged-progress indicator while building/submitting', () => {
    const controls = renderModal({
      initialState: { status: 'building' },
      initialPreview: { recipient: RECIPIENT, amount: '1' },
    });
    expect(screen.getByTestId('urstoa-transfer-stage')).toBeTruthy();
    act(() => controls.setState({ status: 'submitting' }));
    expect(screen.getByTestId('urstoa-transfer-stage')).toBeTruthy();
  });

  it('renders success with the request key and no false-success on other states', () => {
    renderModal({ initialState: { status: 'success', requestKey: 'rk-xfer-9' } });
    const panel = screen.getByTestId('urstoa-transfer-success');
    expect(panel.textContent).toContain('rk-xfer-9');
  });

  it('renders a gas-payer-rejected error distinctly (not a false success)', () => {
    renderModal({
      initialState: { status: 'error', reason: 'gas-payer-rejected' },
    });
    expect(screen.getByTestId('urstoa-transfer-gas-payer-rejected')).toBeTruthy();
    expect(screen.queryByTestId('urstoa-transfer-success')).toBeNull();
  });

  it('renders pending with the request key, never a success and never a resend', () => {
    renderModal({ initialState: { status: 'pending', requestKey: 'rk-lost-3' } });
    const panel = screen.getByTestId('urstoa-transfer-pending');
    expect(panel.textContent).toContain('rk-lost-3');
    // A lost-response must NOT read as success and must NOT auto-resubmit: there
    // is no confirm/resend control rendered in the pending state.
    expect(screen.queryByTestId('urstoa-transfer-success')).toBeNull();
    expect(screen.queryByTestId('urstoa-transfer-confirm')).toBeNull();
  });

  it('routes a locked error to onRequireUnlock instead of a generic error', () => {
    const onRequireUnlock = vi.fn();
    renderModal({
      initialState: { status: 'error', reason: 'locked' },
      onRequireUnlock,
    });
    fireEvent.click(screen.getByTestId('urstoa-transfer-unlock'));
    expect(onRequireUnlock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('urstoa-transfer-error')).toBeNull();
  });

  it('emits no console output that could leak the recipient or amount', () => {
    const controls = renderModal();
    fireEvent.change(screen.getByTestId('urstoa-transfer-recipient'), {
      target: { value: RECIPIENT },
    });
    fireEvent.change(screen.getByTestId('urstoa-transfer-amount'), {
      target: { value: '12.5' },
    });
    fireEvent.click(screen.getByTestId('urstoa-transfer-submit'));
    act(() => controls.setState({ status: 'success', requestKey: 'rk-xfer-9' }));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
