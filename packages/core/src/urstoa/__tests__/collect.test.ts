import { describe, expect, it, vi, afterEach } from 'vitest';

import { collectUrStoa, type CollectUrStoaDeps } from '../collect';

/**
 * A representative active-account keypair: the re-derived `k:` payment key. Its
 * `privateKey`/`password`/`encryptedSecretKey` are secrets that must NEVER reach
 * a discriminated `detail` string nor a console sink.
 */
const GAS_STATION_KEY = {
  publicKey: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
  privateKey: 'SECRET_PRIV_KEY_64_HEX_DEADBEEF_NEVER_LOG_THIS_VALUE_0123456789ab',
  seedType: 'koala' as const,
  encryptedSecretKey: 'SECRET_ENCRYPTED_BLOB_NEVER_LOG',
  password: 'SECRET_WALLET_PASSWORD',
};

const PAYMENT_KEY_ADDRESS =
  'k:aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888';

function makeDeps(over: Partial<CollectUrStoaDeps> = {}): CollectUrStoaDeps {
  return {
    checkCoinAccountExists: vi.fn(async () => true),
    executeCollectUrStoa: vi.fn(async () => ({ requestKey: 'RK_DEFAULT' })),
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collectUrStoa', () => {
  it('resolves existence first and passes accountExists:true to the executor (plain Collect) when the coin account exists', async () => {
    const checkCoinAccountExists = vi.fn(async () => true);
    const executeCollectUrStoa = vi.fn(async () => ({ requestKey: 'RK_PLAIN' }));
    const deps = makeDeps({ checkCoinAccountExists, executeCollectUrStoa });

    const result = await collectUrStoa(
      { paymentKeyAddress: PAYMENT_KEY_ADDRESS, gasStationKey: GAS_STATION_KEY },
      deps,
    );

    // Existence is probed against the SAME payment-key account that collects.
    expect(checkCoinAccountExists).toHaveBeenCalledWith(PAYMENT_KEY_ADDRESS);
    // accountExists:true → executor uses the plain (non-create) Collect variant.
    expect(executeCollectUrStoa).toHaveBeenCalledWith({
      paymentKeyAddress: PAYMENT_KEY_ADDRESS,
      gasStationKey: GAS_STATION_KEY,
      accountExists: true,
    });
    expect(result).toEqual({ ok: true, requestKey: 'RK_PLAIN' });
  });

  it('passes accountExists:false to the executor (create-account-then-collect variant) when the coin account is absent', async () => {
    const executeCollectUrStoa = vi.fn(async () => ({ requestKey: 'RK_CREATE' }));
    const deps = makeDeps({
      checkCoinAccountExists: vi.fn(async () => false),
      executeCollectUrStoa,
    });

    const result = await collectUrStoa(
      { paymentKeyAddress: PAYMENT_KEY_ADDRESS, gasStationKey: GAS_STATION_KEY },
      deps,
    );

    expect(executeCollectUrStoa).toHaveBeenCalledWith(
      expect.objectContaining({ accountExists: false }),
    );
    expect(result).toEqual({ ok: true, requestKey: 'RK_CREATE' });
  });

  it('treats a null existence probe (RPC error / uncertainty) conservatively as accountExists:false (create-account variant)', async () => {
    const executeCollectUrStoa = vi.fn(async () => ({ requestKey: 'RK_NULL' }));
    const deps = makeDeps({
      checkCoinAccountExists: vi.fn(async () => null),
      executeCollectUrStoa,
    });

    await collectUrStoa(
      { paymentKeyAddress: PAYMENT_KEY_ADDRESS, gasStationKey: GAS_STATION_KEY },
      deps,
    );

    // null must NOT be forwarded verbatim, nor coerced to true — it collapses to
    // false so the executor builds the safe create-account-then-collect tx.
    expect(executeCollectUrStoa).toHaveBeenCalledWith(
      expect.objectContaining({ accountExists: false }),
    );
  });

  it('returns a discriminated {ok:false} (never throws) when the executor rejects', async () => {
    const deps = makeDeps({
      executeCollectUrStoa: vi.fn(async () => {
        throw new Error('on-chain collect failure');
      }),
    });

    const result = await collectUrStoa(
      { paymentKeyAddress: PAYMENT_KEY_ADDRESS, gasStationKey: GAS_STATION_KEY },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('collect-failed');
      expect(result.detail).toContain('on-chain collect failure');
    }
  });

  it('never leaks the gas-station keypair secrets through the discriminated detail or any console sink', async () => {
    const consoleSpies = (
      ['log', 'info', 'warn', 'error', 'debug'] as const
    ).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));

    // A pathological error embedding every secret field of the keypair.
    const leaky =
      `boom ${GAS_STATION_KEY.privateKey} ${GAS_STATION_KEY.password} ` +
      `${GAS_STATION_KEY.encryptedSecretKey}`;
    const deps = makeDeps({
      executeCollectUrStoa: vi.fn(async () => {
        throw new Error(leaky);
      }),
    });

    const result = await collectUrStoa(
      { paymentKeyAddress: PAYMENT_KEY_ADDRESS, gasStationKey: GAS_STATION_KEY },
      deps,
    );

    const secrets = [
      GAS_STATION_KEY.privateKey,
      GAS_STATION_KEY.password,
      GAS_STATION_KEY.encryptedSecretKey,
    ];

    if (result.ok === false) {
      for (const secret of secrets) {
        expect(result.detail).not.toContain(secret);
      }
    }

    const printed = consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ');
    for (const secret of secrets) {
      expect(printed).not.toContain(secret);
    }
  });
});
