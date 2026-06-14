import { describe, expect, it, vi, afterEach } from 'vitest';

import { sendSameChain } from '../sendSameChain';
import type { SameChainDeps, SameChainSendParams } from '../sendSameChain';

const SENDER = 'k:aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff';
const RECIPIENT =
  'k:1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777888899990000';
const RECIPIENT_PUBKEY =
  '1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff7777888899990000';
const SENDER_KEYPAIR = {
  publicKey: 'aaaa111122223333444455556666777788889999aaaabbbbccccddddeeeeffff',
  privateKey: 'b'.repeat(64),
};

function baseParams(
  over: Partial<SameChainSendParams> = {},
): SameChainSendParams {
  return {
    sender: SENDER,
    recipient: RECIPIENT,
    amount: '1.5',
    chainId: '0',
    ...over,
  };
}

/**
 * Build a deps double whose client boundary is fully stubbed (NEVER hits the
 * network). `accountExists` controls the recipient-existence read result and
 * `simStatus`/`submitImpl` control the simulate/submit legs.
 */
function makeDeps(opts: {
  accountExists?: boolean;
  simResult?: { result: { status: string; error?: { message?: string } }; gas?: number };
  submitImpl?: () => Promise<{ requestKey?: string; status?: string }>;
} = {}): {
  deps: SameChainDeps;
  spies: {
    readAccountExists: ReturnType<typeof vi.fn>;
    buildTx: ReturnType<typeof vi.fn>;
    dirtyRead: ReturnType<typeof vi.fn>;
    sign: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    calculateAutoGasLimit: ReturnType<typeof vi.fn>;
  };
} {
  const simResult =
    opts.simResult ?? ({ result: { status: 'success' }, gas: 700 } as const);

  const readAccountExists = vi.fn(async () => opts.accountExists ?? true);
  const buildTx = vi.fn(
    (spec: { pactCode: string; gasLimit: number; chainId: string }) => ({
      cmd: 'BUILT',
      pactCode: spec.pactCode,
      gasLimit: spec.gasLimit,
      chainId: spec.chainId,
    }),
  );
  const dirtyRead = vi.fn(async () => simResult);
  const sign = vi.fn(async () => ({ cmd: 'SIGNED' }));
  const submit =
    opts.submitImpl !== undefined
      ? vi.fn(opts.submitImpl)
      : vi.fn(async () => ({ requestKey: 'rk-1', status: 'pending' }));
  const calculateAutoGasLimit = vi.fn((gas: number) => gas + 500);

  const deps: SameChainDeps = {
    readAccountExists,
    buildTx,
    dirtyRead,
    sign,
    submit,
    calculateAutoGasLimit,
  };

  return {
    deps,
    spies: { readAccountExists, buildTx, dirtyRead, sign, submit, calculateAutoGasLimit },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendSameChain — full same-chain gasless orchestration', () => {
  it('happy path (existing recipient): builds C_Transfer, calibrates gas from sim, signs the keypair SET, submits, returns ok+requestKey', async () => {
    const { deps, spies } = makeDeps({ accountExists: true });

    const result = await sendSameChain(baseParams(), [SENDER_KEYPAIR], deps);

    // Existence read targets the recipient on the SELECTED chain.
    expect(spies.readAccountExists).toHaveBeenCalledWith(RECIPIENT, '0');

    // Existing recipient → the C_Transfer verb, never C_TransferAnew.
    const firstBuild = spies.buildTx.mock.calls[0][0];
    expect(firstBuild.pactCode).toContain('coin.C_Transfer ');
    expect(firstBuild.pactCode).not.toContain('C_TransferAnew');

    // Gas is calibrated from the simulate's reported gas, then re-built.
    expect(spies.calculateAutoGasLimit).toHaveBeenCalledWith(700);
    expect(spies.buildTx).toHaveBeenCalledTimes(2);
    const finalBuild = spies.buildTx.mock.calls[1][0];
    expect(finalBuild.gasLimit).toBe(1200); // 700 + 500 from the stub

    // Signs with the SET passed in, then submits the signed tx.
    expect(spies.sign).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'BUILT' }),
      [SENDER_KEYPAIR],
    );
    expect(spies.submit).toHaveBeenCalledOnce();

    expect(result).toEqual({
      ok: true,
      requestKey: 'rk-1',
      status: 'pending',
    });
  });

  it('absent recipient on chain → builds C_TransferAnew with the recipient keyset', async () => {
    const { deps, spies } = makeDeps({ accountExists: false });

    const result = await sendSameChain(baseParams(), [SENDER_KEYPAIR], deps);

    const firstBuild = spies.buildTx.mock.calls[0][0];
    expect(firstBuild.pactCode).toContain('coin.C_TransferAnew ');
    // New-account keyset must guard the RECIPIENT pubkey, attached as payload.
    expect(firstBuild.payloadJson).toContain(RECIPIENT_PUBKEY);
    expect((result as { ok: boolean }).ok).toBe(true);
  });

  it('non-"0" chainId builds with that chain as the meta chain and reads existence on it', async () => {
    const { deps, spies } = makeDeps({ accountExists: true });

    await sendSameChain(baseParams({ chainId: '5' }), [SENDER_KEYPAIR], deps);

    expect(spies.readAccountExists).toHaveBeenCalledWith(RECIPIENT, '5');
    expect(spies.buildTx.mock.calls[0][0].chainId).toBe('5');
    expect(spies.buildTx.mock.calls[1][0].chainId).toBe('5');
  });

  it('simulate failure with a DALOS gas-payer error → gas-payer-rejected (NOT simulation-failed), with selfPaidFallbackPossible', async () => {
    const { deps, spies } = makeDeps({
      accountExists: true,
      simResult: {
        result: {
          status: 'failure',
          error: { message: 'Failure: ouronet-ns.DALOS gas-payer eligibility check failed' },
        },
      },
    });

    const result = await sendSameChain(baseParams(), [SENDER_KEYPAIR], deps);

    expect(result).toMatchObject({
      ok: false,
      reason: 'gas-payer-rejected',
      selfPaidFallbackPossible: true,
    });
    // A rejected gas payer must NOT proceed to signing or submission.
    expect(spies.sign).not.toHaveBeenCalled();
    expect(spies.submit).not.toHaveBeenCalled();
  });

  it('simulate failure WITHOUT a gas-payer signature → simulation-failed (distinct from gas-payer-rejected)', async () => {
    const { deps, spies } = makeDeps({
      accountExists: true,
      simResult: {
        result: { status: 'failure', error: { message: 'Insufficient funds in sender account' } },
      },
    });

    const result = await sendSameChain(baseParams(), [SENDER_KEYPAIR], deps);

    expect(result).toMatchObject({ ok: false, reason: 'simulation-failed' });
    expect(spies.submit).not.toHaveBeenCalled();
  });

  it('generic "gas limit exceeded" simulate failure stays simulation-failed (NOT gas-payer-rejected)', async () => {
    // The rejection classifier must require a DALOS/GAS_PAYER MODULE signature —
    // a bare mention of "gas" must NOT be misread as a sponsor refusal, or a
    // recoverable-by-self-paid fallback would be falsely advertised.
    const { deps, spies } = makeDeps({
      accountExists: true,
      simResult: {
        result: { status: 'failure', error: { message: 'gas limit exceeded' } },
      },
    });

    const result = await sendSameChain(baseParams(), [SENDER_KEYPAIR], deps);

    expect(result).toMatchObject({ ok: false, reason: 'simulation-failed' });
    expect(spies.submit).not.toHaveBeenCalled();
  });

  it('submit throws a gas-payer rejection → gas-payer-rejected (classified from the submit error)', async () => {
    const { deps } = makeDeps({
      accountExists: true,
      submitImpl: async () => {
        throw new Error('on-chain: ouronet-ns.DALOS gas-payer rate-limit exceeded');
      },
    });

    const result = await sendSameChain(baseParams(), [SENDER_KEYPAIR], deps);

    expect(result).toMatchObject({
      ok: false,
      reason: 'gas-payer-rejected',
      selfPaidFallbackPossible: true,
    });
  });

  it('submit throws a non-gas-payer error → submit-failed', async () => {
    const { deps } = makeDeps({
      accountExists: true,
      submitImpl: async () => {
        throw new Error('node unreachable: TLS handshake failed');
      },
    });

    const result = await sendSameChain(baseParams(), [SENDER_KEYPAIR], deps);

    expect(result).toMatchObject({ ok: false, reason: 'submit-failed' });
  });

  it('a malformed amount returns {ok:false, reason:"invalid-amount"} — never an uncaught throw across the boundary', async () => {
    const { deps, spies } = makeDeps({ accountExists: true });

    // 13 fractional digits exceeds the 12-decimal on-chain precision; core must
    // discriminate this as invalid-amount, NOT let formatStoaAmount throw out of
    // the orchestration (the caller would misread a pre-submit throw as pending).
    const result = await sendSameChain(
      baseParams({ amount: '1.0000000000001' }),
      [SENDER_KEYPAIR],
      deps,
    );

    expect(result).toMatchObject({ ok: false, reason: 'invalid-amount' });
    // No tx was built/signed/submitted on a pure validation failure.
    expect(spies.buildTx).not.toHaveBeenCalled();
    expect(spies.sign).not.toHaveBeenCalled();
    expect(spies.submit).not.toHaveBeenCalled();
  });

  it('a transient recipient-existence read failure returns {ok:false, reason:"precheck-failed"} — not a throw', async () => {
    const { deps, spies } = makeDeps({ accountExists: true });
    (deps.readAccountExists as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error('node unreachable during existence read');
      },
    );

    const result = await sendSameChain(baseParams(), [SENDER_KEYPAIR], deps);

    expect(result).toMatchObject({ ok: false, reason: 'precheck-failed' });
    expect(spies.buildTx).not.toHaveBeenCalled();
    expect(spies.submit).not.toHaveBeenCalled();
  });

  describe('recipient validation (core is the security boundary)', () => {
    it('rejects a recipient without the k: prefix and never builds/reads/submits', async () => {
      const { deps, spies } = makeDeps();

      const result = await sendSameChain(
        baseParams({ recipient: RECIPIENT_PUBKEY }), // no k: prefix
        [SENDER_KEYPAIR],
        deps,
      );

      expect(result).toEqual({ ok: false, reason: 'invalid-recipient' });
      expect(spies.readAccountExists).not.toHaveBeenCalled();
      expect(spies.buildTx).not.toHaveBeenCalled();
      expect(spies.submit).not.toHaveBeenCalled();
    });

    it('rejects a recipient whose hex is not 64 chars', async () => {
      const { deps, spies } = makeDeps();

      const result = await sendSameChain(
        baseParams({ recipient: 'k:abcd' }),
        [SENDER_KEYPAIR],
        deps,
      );

      expect(result).toEqual({ ok: false, reason: 'invalid-recipient' });
      expect(spies.buildTx).not.toHaveBeenCalled();
    });

    it('rejects a recipient with non-hex characters in the pubkey', async () => {
      const { deps, spies } = makeDeps();
      const nonHex = 'k:' + 'g'.repeat(64);

      const result = await sendSameChain(
        baseParams({ recipient: nonHex }),
        [SENDER_KEYPAIR],
        deps,
      );

      expect(result).toEqual({ ok: false, reason: 'invalid-recipient' });
      expect(spies.buildTx).not.toHaveBeenCalled();
    });

    it('rejects an empty recipient', async () => {
      const { deps, spies } = makeDeps();

      const result = await sendSameChain(
        baseParams({ recipient: '' }),
        [SENDER_KEYPAIR],
        deps,
      );

      expect(result).toEqual({ ok: false, reason: 'invalid-recipient' });
      expect(spies.buildTx).not.toHaveBeenCalled();
    });

    it('rejects a self-send (recipient === sender)', async () => {
      const { deps, spies } = makeDeps();

      const result = await sendSameChain(
        baseParams({ recipient: SENDER }),
        [SENDER_KEYPAIR],
        deps,
      );

      expect(result).toEqual({ ok: false, reason: 'invalid-recipient' });
      expect(spies.buildTx).not.toHaveBeenCalled();
    });
  });

  it('never leaks signing secrets to console across the full cycle', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Exercise the failure path too — that is where careless logging leaks.
    const { deps } = makeDeps({
      accountExists: true,
      submitImpl: async () => {
        throw new Error('node unreachable');
      },
    });

    await sendSameChain(baseParams(), [SENDER_KEYPAIR], deps);

    const allOutput = [errorSpy, logSpy, warnSpy]
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg ?? '')))
      .join('\n');

    expect(allOutput).not.toContain(SENDER_KEYPAIR.privateKey);
  });

  it('scrubs the private key out of any detail string it returns', async () => {
    const { deps } = makeDeps({
      accountExists: true,
      submitImpl: async () => {
        // A pathological error that embeds the secret — detail must scrub it.
        throw new Error(`submit failed with key ${SENDER_KEYPAIR.privateKey}`);
      },
    });

    const result = (await sendSameChain(baseParams(), [SENDER_KEYPAIR], deps)) as {
      ok: false;
      reason: string;
      detail?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.detail ?? '').not.toContain(SENDER_KEYPAIR.privateKey);
  });
});
