import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import type { ContextUrStoaResult } from '../../context/WalletContext';
import { formatUrStoaAmount } from '../amount';
import {
  useStakeUnstakeUrStoa,
  type UrStoaOpSeam,
  type UseStakeUnstakeUrStoaOptions,
} from '../useStakeUnstakeUrStoa';

/** Active `k:` payment-key ADDRESS — interpolated into the pact build by core. */
const PAYMENT_KEY =
  'k:aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';

const OK_STAKE: ContextUrStoaResult = { ok: true, requestKey: 'rk-stake-1' };
const OK_UNSTAKE: ContextUrStoaResult = { ok: true, requestKey: 'rk-unstake-1' };

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
 * Base options with the seam + account stubbed so the hook never hits a wallet/
 * network. The hook passes PUBLIC params ({paymentKeyAddress, amount}) to the seam
 * — no keypair crosses from the hook; the seam (context) resolves the key locally
 * or in the background.
 */
function baseOptions(
  over: Partial<UseStakeUnstakeUrStoaOptions> = {},
): UseStakeUnstakeUrStoaOptions {
  return {
    paymentKeyAddress: PAYMENT_KEY,
    urstoaStake: vi.fn(async () => OK_STAKE),
    urstoaUnstake: vi.fn(async () => OK_UNSTAKE),
    walletBalance: '100',
    userStaked: '40',
    vaultTotal: '1000',
    refresh: vi.fn(),
    ...over,
  };
}

describe('useStakeUnstakeUrStoa', () => {
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

  it('stake() advances building→submitting→success carrying the requestKey, and calls the seam with the payment key + the formatted amount (NO keypair — XP-12)', async () => {
    const { wrapper } = makeWrapper();
    const urstoaStake: UrStoaOpSeam = vi.fn(async () => OK_STAKE);
    const options = baseOptions({ urstoaStake });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    expect(result.current.state.status).toBe('idle');

    await act(async () => {
      await result.current.stake({ amount: '12.5' });
    });

    // The seam was invoked once with PUBLIC params only: the payment-key address
    // and the amount formatted to the 24-decimal Pact scale (never the raw "12.5").
    expect(urstoaStake).toHaveBeenCalledTimes(1);
    const call = (urstoaStake as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      paymentKeyAddress: string;
      amount: string;
    };
    expect(call.paymentKeyAddress).toBe(PAYMENT_KEY);
    // No keypair field ever crosses the seam from the hook.
    expect(JSON.stringify(call).toLowerCase()).not.toMatch(
      /privatekey|secretkey|gasstationkey|paymentkeypair/,
    );
    // The amount went through the SDK Pact formatter.
    expect(call.amount).toBe(String(formatUrStoaAmount('12.5')));
    expect(call.amount).toContain('.');

    expect(result.current.state).toEqual({
      status: 'success',
      requestKey: 'rk-stake-1',
    });
  });

  it('sets building SYNCHRONOUSLY on stake() entry before the first await resolves', async () => {
    const { wrapper } = makeWrapper();
    const gate = deferred<ContextUrStoaResult>();
    const urstoaStake: UrStoaOpSeam = vi.fn(async () => gate.promise);
    const options = baseOptions({ urstoaStake });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.stake({ amount: '5' });
    });

    // Before the seam resolves, the hook has already left idle — the
    // double-submit guard + progress UI engage immediately (RR#9).
    expect(result.current.state.status).not.toBe('idle');
    expect(['building', 'submitting']).toContain(result.current.state.status);

    await act(async () => {
      gate.resolve(OK_STAKE);
      await pending;
    });
    expect(result.current.state.status).toBe('success');
  });

  it('sole-staker unstake (userStaked===vaultTotal) clamps the requested amount to userStaked-1.0', async () => {
    const { wrapper } = makeWrapper();
    const urstoaUnstake: UrStoaOpSeam = vi.fn(async () => OK_UNSTAKE);
    const options = baseOptions({
      urstoaUnstake,
      userStaked: '500',
      vaultTotal: '500',
    });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    // Request the FULL stake; the last-staker floor must clamp it to 499 (= 500-1.0),
    // never draining the vault to empty.
    await act(async () => {
      await result.current.unstake({ amount: '500' });
    });

    expect(urstoaUnstake).toHaveBeenCalledTimes(1);
    const call = (urstoaUnstake as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      amount: string;
    };
    expect(call.amount).toMatch(/^499(\.0+)?$/);
    expect(result.current.state).toEqual({
      status: 'success',
      requestKey: 'rk-unstake-1',
    });
  });

  it('not-last-staker unstake submits the FULL requested amount unclamped', async () => {
    const { wrapper } = makeWrapper();
    const urstoaUnstake: UrStoaOpSeam = vi.fn(async () => OK_UNSTAKE);
    const options = baseOptions({
      urstoaUnstake,
      userStaked: '40',
      vaultTotal: '1000',
    });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    await act(async () => {
      await result.current.unstake({ amount: '40' });
    });

    expect(urstoaUnstake).toHaveBeenCalledTimes(1);
    const call = (urstoaUnstake as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      amount: string;
    };
    expect(call.amount).toMatch(/^40(\.0+)?$/);
  });

  it('null/unknown vaultTotal BLOCKS unstake with reason vault-total-unknown and NEVER calls the seam (fail-closed full-drain guard)', async () => {
    const { wrapper } = makeWrapper();
    const urstoaUnstake: UrStoaOpSeam = vi.fn(async () => OK_UNSTAKE);
    const options = baseOptions({
      urstoaUnstake,
      userStaked: '500',
      vaultTotal: null,
    });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    await act(async () => {
      await result.current.unstake({ amount: '500' });
    });

    // The floor was NOT lifted and the amount was NOT clamped against a coerced 0:
    // the unstake is refused and the seam is never reached.
    expect(urstoaUnstake).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({
      status: 'error',
      reason: 'vault-total-unknown',
    });
  });

  it('stake amount exceeding the UrStoa wallet balance is refused as insufficient-funds BEFORE submit', async () => {
    const { wrapper } = makeWrapper();
    const urstoaStake: UrStoaOpSeam = vi.fn(async () => OK_STAKE);
    const options = baseOptions({ urstoaStake, walletBalance: '10' });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    await act(async () => {
      await result.current.stake({ amount: '10.5' });
    });

    expect(urstoaStake).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      status: 'error',
      reason: 'insufficient-funds',
    });
  });

  it('unstake amount exceeding the user staked balance is refused as insufficient-funds BEFORE submit', async () => {
    const { wrapper } = makeWrapper();
    const urstoaUnstake: UrStoaOpSeam = vi.fn(async () => OK_UNSTAKE);
    const options = baseOptions({
      urstoaUnstake,
      userStaked: '40',
      vaultTotal: '1000',
    });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    await act(async () => {
      await result.current.unstake({ amount: '41' });
    });

    expect(urstoaUnstake).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      status: 'error',
      reason: 'insufficient-funds',
    });
  });

  it('a LOCKED wallet (seam returns locked) maps to reason:locked and NEVER reaches a success', async () => {
    const { wrapper } = makeWrapper();
    const urstoaStake: UrStoaOpSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({ ok: false, reason: 'locked' }),
    );
    const options = baseOptions({ urstoaStake });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    await act(async () => {
      await result.current.stake({ amount: '5' });
    });

    // The seam was reached (the floor/bounds passed), but a locked result maps to
    // the hook's locked error — never a fabricated success.
    expect(result.current.state).toEqual({ status: 'error', reason: 'locked' });
  });

  it('a missing active account (no payment key) maps to locked and NEVER calls the seam', async () => {
    const { wrapper } = makeWrapper();
    const urstoaStake: UrStoaOpSeam = vi.fn(async () => OK_STAKE);
    const options = baseOptions({ urstoaStake, paymentKeyAddress: null });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    await act(async () => {
      await result.current.stake({ amount: '5' });
    });

    expect(urstoaStake).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: 'error', reason: 'locked' });
  });

  it('REMOTE/extension success: the seam resolves {ok:true} and the hook reaches success (no longer locked)', async () => {
    const { wrapper } = makeWrapper();
    // The seam stands in for the context routing the op to the background and the
    // background returning a requestKey — proving the remote path now succeeds.
    const urstoaStake: UrStoaOpSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({
        ok: true,
        requestKey: 'rk-remote-stake',
      }),
    );
    const options = baseOptions({ urstoaStake });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    await act(async () => {
      await result.current.stake({ amount: '5' });
    });

    expect(urstoaStake).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({
      status: 'success',
      requestKey: 'rk-remote-stake',
    });
  });

  it('two synchronous unstake() calls invoke the seam ONCE (double-submit guard)', async () => {
    const { wrapper } = makeWrapper();
    const gate = deferred<ContextUrStoaResult>();
    const urstoaUnstake: UrStoaOpSeam = vi.fn(async () => gate.promise);
    const options = baseOptions({
      urstoaUnstake,
      userStaked: '40',
      vaultTotal: '1000',
    });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    await act(async () => {
      const a = result.current.unstake({ amount: '10' });
      const b = result.current.unstake({ amount: '10' });
      gate.resolve(OK_UNSTAKE);
      await Promise.all([a, b]);
    });

    expect(urstoaUnstake).toHaveBeenCalledTimes(1);
  });

  it('a THROWN seam after dispatch lands on pending (NOT a re-armed idle / NOT auto-resubmit)', async () => {
    const { wrapper } = makeWrapper();
    const urstoaStake: UrStoaOpSeam = vi.fn(async () => {
      throw new Error('network died after dispatch');
    });
    const options = baseOptions({ urstoaStake });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    await act(async () => {
      await result.current.stake({ amount: '5' });
    });

    expect(result.current.state.status).toBe('pending');
    expect(result.current.state.status).not.toBe('idle');
  });

  it('on a successful stake the holdings refresh() is invoked once', async () => {
    const { wrapper } = makeWrapper();
    const refresh = vi.fn();
    const options = baseOptions({ refresh });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    await act(async () => {
      await result.current.stake({ amount: '5' });
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a discriminated {ok:false} seam failure maps to a distinct error reason, never success and never pending', async () => {
    const { wrapper } = makeWrapper();
    const urstoaStake: UrStoaOpSeam = vi.fn(
      async (): Promise<ContextUrStoaResult> => ({
        ok: false,
        reason: 'gas-payer-rejected',
        detail: 'DALOS gas payer refused',
      }),
    );
    const options = baseOptions({ urstoaStake });

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    await act(async () => {
      await result.current.stake({ amount: '5' });
    });

    expect(result.current.state).toMatchObject({
      status: 'error',
      reason: 'gas-payer-rejected',
    });
  });

  it('never prints a signing secret through any console channel', async () => {
    const { wrapper } = makeWrapper();
    const options = baseOptions();

    const { result } = renderHook(() => useStakeUnstakeUrStoa(options), {
      wrapper,
    });

    await act(async () => {
      await result.current.stake({ amount: '5' });
    });

    // The hook never touches a keypair, so no secret can be printed. Assert the
    // console stayed clean across the full op.
    for (const spy of [errorSpy, logSpy, warnSpy, infoSpy, debugSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
