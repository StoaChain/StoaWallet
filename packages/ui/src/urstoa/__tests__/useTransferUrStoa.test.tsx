import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import type { ContextUrStoaResult } from '../../context/WalletContext';
import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import {
  useTransferUrStoa,
  type TransferUrStoaSeam,
  type UseTransferUrStoaOptions,
} from '../useTransferUrStoa';

/** Active `k:` sender/payment-key ADDRESS (sender === payment key, PAT-004). */
const SENDER =
  'k:aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
/** A well-formed RECIPIENT k:-account distinct from the sender. */
const RECIPIENT =
  'k:bbbb111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';

const OK_TRANSFER: ContextUrStoaResult = { ok: true, requestKey: 'rk-xfer-1' };

/** A deferred promise whose resolve/reject are exposed for manual control. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeWrapper() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WalletProvider storage={storage} keyVault={keyVault}>
      {children}
    </WalletProvider>
  );
  return { wrapper };
}

/**
 * Base options with the seam + sender stubbed so the hook never hits a wallet/
 * network. The hook passes PUBLIC params ({senderAddress, receiverAddress,
 * amount}) to the seam — no keypair crosses from the hook (XP-12).
 */
function baseOptions(
  over: Partial<UseTransferUrStoaOptions> = {},
): UseTransferUrStoaOptions {
  return {
    senderAddress: SENDER,
    urstoaTransfer: vi.fn(async () => OK_TRANSFER),
    walletBalance: '100',
    refresh: vi.fn(),
    ...over,
  };
}

describe('useTransferUrStoa', () => {
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

  it('send() resolves a preview and does NOT call the seam until confirm()', async () => {
    const { wrapper } = makeWrapper();
    const urstoaTransfer: TransferUrStoaSeam = vi.fn(async () => OK_TRANSFER);
    const options = baseOptions({ urstoaTransfer });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    expect(result.current.state.status).toBe('idle');

    await act(async () => {
      await result.current.send({ recipient: RECIPIENT, amount: '12.5' });
    });

    expect(result.current.state.status).toBe('preview');
    expect(urstoaTransfer).not.toHaveBeenCalled();
    expect(result.current.preview).toEqual({
      recipient: RECIPIENT,
      amount: '12.5',
    });

    await act(async () => {
      await result.current.confirm();
    });

    expect(urstoaTransfer).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({
      status: 'success',
      requestKey: 'rk-xfer-1',
    });
  });

  it('a malformed recipient is rejected as invalid-recipient with NO preview and NO submit', async () => {
    const { wrapper } = makeWrapper();
    const urstoaTransfer: TransferUrStoaSeam = vi.fn(async () => OK_TRANSFER);
    const options = baseOptions({ urstoaTransfer });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: 'not-a-k-account', amount: '5' });
    });

    expect(result.current.state).toEqual({
      status: 'error',
      reason: 'invalid-recipient',
    });
    expect(result.current.preview).toBeNull();
    expect(urstoaTransfer).not.toHaveBeenCalled();
  });

  it('a self-send (recipient === sender) is rejected as invalid-recipient, never submitted', async () => {
    const { wrapper } = makeWrapper();
    const urstoaTransfer: TransferUrStoaSeam = vi.fn(async () => OK_TRANSFER);
    const options = baseOptions({ urstoaTransfer });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: SENDER, amount: '5' });
    });

    expect(result.current.state).toEqual({
      status: 'error',
      reason: 'invalid-recipient',
    });
    expect(urstoaTransfer).not.toHaveBeenCalled();
  });

  it('an amount exceeding the T12.6 wallet balance is rejected as insufficient-funds BEFORE submit', async () => {
    const { wrapper } = makeWrapper();
    const urstoaTransfer: TransferUrStoaSeam = vi.fn(async () => OK_TRANSFER);
    const options = baseOptions({ urstoaTransfer, walletBalance: '10' });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: RECIPIENT, amount: '10.5' });
    });

    expect(result.current.state).toMatchObject({
      status: 'error',
      reason: 'insufficient-funds',
    });
    expect(urstoaTransfer).not.toHaveBeenCalled();
  });

  it('a 24-decimal amount flows to the seam as a STRING (no Number round-trip) formatted via T12.1, with public sender/receiver and NO keypair', async () => {
    const { wrapper } = makeWrapper();
    const urstoaTransfer: TransferUrStoaSeam = vi.fn(async () => OK_TRANSFER);
    // A 24-fraction-digit amount whose precision a float (Number) cannot hold.
    const PRECISE = '1.123456789012345678901234';
    const options = baseOptions({ urstoaTransfer, walletBalance: '1000' });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: RECIPIENT, amount: PRECISE });
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(urstoaTransfer).toHaveBeenCalledTimes(1);
    const call = (urstoaTransfer as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      senderAddress: string;
      receiverAddress: string;
      amount: string;
    };
    expect(typeof call.amount).toBe('string');
    expect(call.amount).toBe(PRECISE);
    expect(call.amount).not.toBe(String(Number(PRECISE)));
    expect(call.receiverAddress).toBe(RECIPIENT);
    expect(call.senderAddress).toBe(SENDER);
    // XP-12: no keypair field ever crosses the seam from the hook.
    expect(JSON.stringify(call).toLowerCase()).not.toMatch(
      /privatekey|secretkey|paymentkeypair/,
    );
  });

  it('two synchronous confirm() calls invoke the seam ONCE (RR#6 double-submit guard)', async () => {
    const { wrapper } = makeWrapper();
    const gate = deferred<ContextUrStoaResult>();
    const urstoaTransfer: TransferUrStoaSeam = vi.fn(async () => gate.promise);
    const options = baseOptions({ urstoaTransfer });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: RECIPIENT, amount: '5' });
    });

    await act(async () => {
      const a = result.current.confirm();
      const b = result.current.confirm();
      gate.resolve(OK_TRANSFER);
      await Promise.all([a, b]);
    });

    expect(urstoaTransfer).toHaveBeenCalledTimes(1);
  });

  it('a THROWN seam after dispatch lands on pending carrying NO re-armed idle (never auto-resubmit)', async () => {
    const { wrapper } = makeWrapper();
    const urstoaTransfer: TransferUrStoaSeam = vi.fn(async () => {
      throw new Error('network died after dispatch');
    });
    const options = baseOptions({ urstoaTransfer });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: RECIPIENT, amount: '5' });
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(result.current.state.status).toBe('pending');
    expect(result.current.state.status).not.toBe('idle');

    // A confirm() after the pending landing finds no armed preview — the seam stays
    // at its single call; the user must explicitly re-send to retry.
    await act(async () => {
      await result.current.confirm();
    });
    expect(urstoaTransfer).toHaveBeenCalledTimes(1);
  });

  it('a LOCKED wallet (no active sender) maps to reason:locked and NEVER calls the seam', async () => {
    const { wrapper } = makeWrapper();
    const urstoaTransfer: TransferUrStoaSeam = vi.fn(async () => OK_TRANSFER);
    // No sender resolvable (locked / no active account).
    const options = baseOptions({ urstoaTransfer, senderAddress: null });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: RECIPIENT, amount: '5' });
    });

    // A locked wallet short-circuits at send() with a distinct locked reason; the
    // seam never runs.
    expect(urstoaTransfer).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: 'error', reason: 'locked' });
  });

  it('a locked seam result at confirm maps to reason:locked, never a success', async () => {
    const { wrapper } = makeWrapper();
    const urstoaTransfer: TransferUrStoaSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({ ok: false, reason: 'locked' }),
    );
    const options = baseOptions({ urstoaTransfer });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: RECIPIENT, amount: '5' });
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(result.current.state).toEqual({ status: 'error', reason: 'locked' });
  });

  it('on a successful transfer the T12.6 holdings refresh() is invoked once', async () => {
    const { wrapper } = makeWrapper();
    const refresh = vi.fn();
    const options = baseOptions({ refresh });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: RECIPIENT, amount: '5' });
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('REMOTE/extension success: the seam (background-routed) returns {ok:true} and the hook reaches success — no longer locked', async () => {
    const { wrapper } = makeWrapper();
    const urstoaTransfer: TransferUrStoaSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({ ok: true, requestKey: 'rk-remote-xfer' }),
    );
    const options = baseOptions({ urstoaTransfer });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: RECIPIENT, amount: '5' });
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(urstoaTransfer).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({
      status: 'success',
      requestKey: 'rk-remote-xfer',
    });
  });

  it('a discriminated {ok:false} seam failure maps to a distinct error reason, never success and never pending', async () => {
    const { wrapper } = makeWrapper();
    const urstoaTransfer: TransferUrStoaSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({
        ok: false,
        reason: 'gas-payer-rejected',
      }),
    );
    const options = baseOptions({ urstoaTransfer });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: RECIPIENT, amount: '5' });
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(result.current.state).toMatchObject({
      status: 'error',
      reason: 'gas-payer-rejected',
    });
  });

  it('building is set SYNCHRONOUSLY on confirm() entry before the first await resolves (RR#9)', async () => {
    const { wrapper } = makeWrapper();
    const gate = deferred<ContextUrStoaResult>();
    const urstoaTransfer: TransferUrStoaSeam = vi.fn(async () => gate.promise);
    const options = baseOptions({ urstoaTransfer });

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: RECIPIENT, amount: '5' });
    });

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.confirm();
    });

    expect(result.current.state.status).not.toBe('preview');
    expect(['building', 'submitting']).toContain(result.current.state.status);

    await act(async () => {
      gate.resolve(OK_TRANSFER);
      await pending;
    });
    expect(result.current.state.status).toBe('success');
  });

  it('never prints a recipient through any console channel (the hook holds no key at all)', async () => {
    const { wrapper } = makeWrapper();
    const options = baseOptions();

    const { result } = renderHook(() => useTransferUrStoa(options), { wrapper });

    await act(async () => {
      await result.current.send({ recipient: RECIPIENT, amount: '5' });
    });
    await act(async () => {
      await result.current.confirm();
    });

    for (const spy of [errorSpy, logSpy, warnSpy, infoSpy, debugSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
