import { describe, expect, it, vi, afterEach } from 'vitest';

import { stakeUrStoa, unstakeUrStoa } from '../stake';
import type { StakeDeps } from '../stake';

/** Active `k:` payment-key ADDRESS — interpolated into pact code + cap params. */
const PAYMENT_KEY_ADDRESS =
  'k:aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';

/**
 * The active account KEYPAIR — for this k:-only wallet the SDK `gasStationKey`
 * param IS the user's own cap-signing key (re-derived by the caller from the
 * unlocked payload), NOT a separate service key. It signs BOTH the GAS_PAYER
 * cap and the op cap.
 */
const GAS_STATION_KEY = {
  publicKey:
    'aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff',
  privateKey: 'b'.repeat(64),
};

/** Amount is the PRE-FORMATTED decimal string the caller produced via the SDK. */
const AMOUNT = '12.500000000000000000000000';

/**
 * Build a deps double whose executor boundary is fully stubbed (NEVER hits the
 * network). `stakeImpl`/`unstakeImpl` control what the SDK executor returns or
 * throws so the wrapper's success/rejection mapping can be exercised offline.
 */
function makeDeps(opts: {
  stakeImpl?: () => Promise<{ requestKey?: string; status?: string }>;
  unstakeImpl?: () => Promise<{ requestKey?: string; status?: string }>;
} = {}): {
  deps: StakeDeps;
  spies: {
    executeStakeUrStoa: ReturnType<typeof vi.fn>;
    executeUnstakeUrStoa: ReturnType<typeof vi.fn>;
  };
} {
  const executeStakeUrStoa = vi.fn(
    opts.stakeImpl ?? (async () => ({ requestKey: 'rk-stake-1', status: 'pending' })),
  );
  const executeUnstakeUrStoa = vi.fn(
    opts.unstakeImpl ??
      (async () => ({ requestKey: 'rk-unstake-1', status: 'pending' })),
  );

  return {
    deps: { executeStakeUrStoa, executeUnstakeUrStoa },
    spies: { executeStakeUrStoa, executeUnstakeUrStoa },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stakeUrStoa — chain-0 gasless STAKE core wrapper', () => {
  it('delegates to executeStakeUrStoa with the payment-key address, the pre-formatted amount STRING, and the gas-station key; maps success to {ok:true, requestKey}', async () => {
    const { deps, spies } = makeDeps();

    const result = await stakeUrStoa(
      {
        paymentKeyAddress: PAYMENT_KEY_ADDRESS,
        amount: AMOUNT,
        gasStationKey: GAS_STATION_KEY,
      },
      deps,
    );

    // The wrapper composes the SDK executor — it passes the address, the EXACT
    // pre-formatted string (no reformat), and the gas-station keypair through.
    expect(spies.executeStakeUrStoa).toHaveBeenCalledOnce();
    const passed = spies.executeStakeUrStoa.mock.calls[0][0];
    expect(passed.paymentKeyAddress).toBe(PAYMENT_KEY_ADDRESS);
    expect(passed.amount).toBe(AMOUNT);
    expect(passed.gasStationKey).toBe(GAS_STATION_KEY);

    // The deprecated `numAmount` is the SINGLE-source-of-truth violation we must
    // NOT introduce — the amount string is the only quantity passed.
    expect(passed.numAmount).toBeUndefined();

    expect(result).toEqual({
      ok: true,
      requestKey: 'rk-stake-1',
      status: 'pending',
    });
  });

  it('an executor rejection maps to a discriminated {ok:false, reason:"submit-failed"} — never a thrown Error across the boundary', async () => {
    const { deps } = makeDeps({
      stakeImpl: async () => {
        throw new Error('node unreachable: TLS handshake failed');
      },
    });

    const result = await stakeUrStoa(
      {
        paymentKeyAddress: PAYMENT_KEY_ADDRESS,
        amount: AMOUNT,
        gasStationKey: GAS_STATION_KEY,
      },
      deps,
    );

    expect(result).toMatchObject({ ok: false, reason: 'submit-failed' });
  });

  it('a DALOS gas-payer rejection from the executor maps to {ok:false, reason:"gas-payer-rejected"} (distinct from a generic submit failure)', async () => {
    const { deps } = makeDeps({
      stakeImpl: async () => {
        throw new Error('on-chain: ouronet-ns.DALOS gas-payer eligibility check failed');
      },
    });

    const result = await stakeUrStoa(
      {
        paymentKeyAddress: PAYMENT_KEY_ADDRESS,
        amount: AMOUNT,
        gasStationKey: GAS_STATION_KEY,
      },
      deps,
    );

    expect(result).toMatchObject({ ok: false, reason: 'gas-payer-rejected' });
  });

  it('faithfully submits whatever amount it is given — the last-staker floor is the hook\'s job, NOT enforced here', async () => {
    const { deps, spies } = makeDeps();

    // A tiny amount that the T12.7 hook might floor-reject is passed straight
    // through; the core wrapper does not know the vault total and does not gate.
    await stakeUrStoa(
      {
        paymentKeyAddress: PAYMENT_KEY_ADDRESS,
        amount: '0.000000000000000000000001',
        gasStationKey: GAS_STATION_KEY,
      },
      deps,
    );

    expect(spies.executeStakeUrStoa.mock.calls[0][0].amount).toBe(
      '0.000000000000000000000001',
    );
  });
});

describe('unstakeUrStoa — chain-0 gasless UNSTAKE core wrapper', () => {
  it('delegates to executeUnstakeUrStoa (NOT the stake executor) with the address, amount string, and gas-station key; maps success to {ok:true, requestKey}', async () => {
    const { deps, spies } = makeDeps();

    const result = await unstakeUrStoa(
      {
        paymentKeyAddress: PAYMENT_KEY_ADDRESS,
        amount: AMOUNT,
        gasStationKey: GAS_STATION_KEY,
      },
      deps,
    );

    expect(spies.executeUnstakeUrStoa).toHaveBeenCalledOnce();
    expect(spies.executeStakeUrStoa).not.toHaveBeenCalled();
    const passed = spies.executeUnstakeUrStoa.mock.calls[0][0];
    expect(passed.paymentKeyAddress).toBe(PAYMENT_KEY_ADDRESS);
    expect(passed.amount).toBe(AMOUNT);
    expect(passed.gasStationKey).toBe(GAS_STATION_KEY);
    expect(passed.numAmount).toBeUndefined();

    expect(result).toEqual({
      ok: true,
      requestKey: 'rk-unstake-1',
      status: 'pending',
    });
  });

  it('an executor rejection maps to {ok:false} — never a thrown Error', async () => {
    const { deps } = makeDeps({
      unstakeImpl: async () => {
        throw new Error('submit failed');
      },
    });

    const result = await unstakeUrStoa(
      {
        paymentKeyAddress: PAYMENT_KEY_ADDRESS,
        amount: AMOUNT,
        gasStationKey: GAS_STATION_KEY,
      },
      deps,
    );

    expect(result).toMatchObject({ ok: false, reason: 'submit-failed' });
  });
});

describe('secret hygiene across a stake cycle', () => {
  it('never leaks the private key to console, even on the failure path', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { deps } = makeDeps({
      stakeImpl: async () => {
        throw new Error('node unreachable');
      },
    });

    await stakeUrStoa(
      {
        paymentKeyAddress: PAYMENT_KEY_ADDRESS,
        amount: AMOUNT,
        gasStationKey: GAS_STATION_KEY,
      },
      deps,
    );

    const allOutput = [errorSpy, logSpy, warnSpy]
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg ?? '')))
      .join('\n');

    expect(allOutput).not.toContain(GAS_STATION_KEY.privateKey);
  });

  it('scrubs the private key out of any detail string it returns', async () => {
    const { deps } = makeDeps({
      stakeImpl: async () => {
        // A pathological executor error that embeds the secret — detail must
        // scrub it before it crosses the discriminated-result boundary.
        throw new Error(`stake failed with key ${GAS_STATION_KEY.privateKey}`);
      },
    });

    const result = (await stakeUrStoa(
      {
        paymentKeyAddress: PAYMENT_KEY_ADDRESS,
        amount: AMOUNT,
        gasStationKey: GAS_STATION_KEY,
      },
      deps,
    )) as { ok: false; reason: string; detail?: string };

    expect(result.ok).toBe(false);
    expect(result.detail ?? '').not.toContain(GAS_STATION_KEY.privateKey);
  });
});
