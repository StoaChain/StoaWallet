import { describe, it, expect, vi, afterEach } from 'vitest';
import { transferUrStoa, type TransferUrStoaDeps } from '../transfer';

// A valid 64-char ED25519 hex pubkey for the sender and a DISTINCT one for the
// receiver, so the recipient-keyset assertion can prove the keyset is built from
// the RECEIVER's pubkey and never the sender's.
const SENDER_PUB = 'a'.repeat(64);
const RECEIVER_PUB = 'b'.repeat(64);
const SENDER = `k:${SENDER_PUB}`;
const RECEIVER = `k:${RECEIVER_PUB}`;
const AMOUNT = '12.500'; // already SDK-formatted at UrStoa's 3-decimal scale

const paymentKeypair = { publicKey: SENDER_PUB, secretKey: 's'.repeat(64) };

function makeDeps(
  overrides: Partial<TransferUrStoaDeps> = {},
): { deps: TransferUrStoaDeps; execSpy: ReturnType<typeof vi.fn> } {
  const execSpy = vi.fn().mockResolvedValue({ requestKey: 'RK-OK' });
  const deps: TransferUrStoaDeps = {
    getUrStoaGuard: vi.fn().mockResolvedValue(null),
    checkCoinAccountExists: vi.fn().mockResolvedValue(null),
    executeNativeUrStoaTransfer: execSpy,
    ...overrides,
  };
  return { deps, execSpy };
}

function baseParams() {
  return {
    senderAddress: SENDER,
    receiverAddress: RECEIVER,
    amount: AMOUNT,
    paymentKeyAddress: SENDER,
    paymentKeypair,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('transferUrStoa', () => {
  it('absent receiver routes to TransferAnew with a keyset built from the RECEIVER pubkey (keys-all)', async () => {
    // Both existence probes report non-existence -> new-account branch.
    const { deps, execSpy } = makeDeps({
      getUrStoaGuard: vi.fn().mockResolvedValue(null),
      checkCoinAccountExists: vi.fn().mockResolvedValue(null),
    });

    const result = await transferUrStoa(baseParams(), deps);

    expect(result).toEqual({ ok: true, requestKey: 'RK-OK' });
    expect(execSpy).toHaveBeenCalledTimes(1);
    const sdkParams = execSpy.mock.calls[0][0];
    // receiverExists is RESOLVED to false, never defaulted.
    expect(sdkParams.receiverExists).toBe(false);
    // The keyset guards the RECEIVER's pubkey, not the sender's.
    expect(sdkParams.receiverKeyset).toEqual({
      keys: [RECEIVER_PUB],
      pred: 'keys-all',
    });
    expect(sdkParams.receiverKeyset.keys).not.toContain(SENDER_PUB);
  });

  it('existing receiver routes to Transfer with NO receiverKeyset (existence resolved from the guard read)', async () => {
    const { deps, execSpy } = makeDeps({
      getUrStoaGuard: vi
        .fn()
        .mockResolvedValue({ exists: true, isKeyset: true, keys: [RECEIVER_PUB], pred: 'keys-all' }),
    });

    const result = await transferUrStoa(baseParams(), deps);

    expect(result).toEqual({ ok: true, requestKey: 'RK-OK' });
    const sdkParams = execSpy.mock.calls[0][0];
    expect(sdkParams.receiverExists).toBe(true);
    expect(sdkParams.receiverKeyset).toBeUndefined();
  });

  it('resolves existence from checkCoinAccountExists when the guard read is inconclusive', async () => {
    const { deps, execSpy } = makeDeps({
      getUrStoaGuard: vi.fn().mockResolvedValue(null),
      checkCoinAccountExists: vi.fn().mockResolvedValue(true),
    });

    await transferUrStoa(baseParams(), deps);

    const sdkParams = execSpy.mock.calls[0][0];
    expect(sdkParams.receiverExists).toBe(true);
    expect(sdkParams.receiverKeyset).toBeUndefined();
  });

  it('rejects a non-k: recipient as invalid-recipient and never builds a tx (no blind slice(2))', async () => {
    const { deps, execSpy } = makeDeps();

    const result = await transferUrStoa(
      { ...baseParams(), receiverAddress: `w:${RECEIVER_PUB}` },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: 'invalid-recipient' });
    expect(execSpy).not.toHaveBeenCalled();
    expect(deps.getUrStoaGuard).not.toHaveBeenCalled();
  });

  it('rejects an empty recipient as invalid-recipient with no tx', async () => {
    const { deps, execSpy } = makeDeps();

    const result = await transferUrStoa({ ...baseParams(), receiverAddress: '' }, deps);

    expect(result).toEqual({ ok: false, reason: 'invalid-recipient' });
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('rejects a recipient whose pubkey is not a 64-char ED25519 key', async () => {
    const { deps, execSpy } = makeDeps();

    const result = await transferUrStoa(
      { ...baseParams(), receiverAddress: 'k:notavalidkey' },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: 'invalid-recipient' });
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('rejects a self-send (receiver === sender) as invalid-recipient with no tx', async () => {
    const { deps, execSpy } = makeDeps();

    const result = await transferUrStoa(
      { ...baseParams(), receiverAddress: SENDER },
      deps,
    );

    expect(result).toEqual({ ok: false, reason: 'invalid-recipient' });
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('passes the pre-formatted amount through unchanged and maps ExecuteNativeUrStoaParams exactly', async () => {
    const { deps, execSpy } = makeDeps();

    await transferUrStoa(baseParams(), deps);

    const sdkParams = execSpy.mock.calls[0][0];
    expect(sdkParams.amount).toBe(AMOUNT); // not reformatted
    expect(sdkParams.senderAddress).toBe(SENDER);
    expect(sdkParams.receiverAddress).toBe(RECEIVER);
    expect(sdkParams.paymentKeyAddress).toBe(SENDER);
    expect(sdkParams.paymentKeypair).toBe(paymentKeypair);
    // RR#1 (PAT-004): no separate gas-station signer in the pact sense.
    expect(sdkParams.senderGuardKeys).toEqual([]);
    // k:-only self-as-sender: payment key pubkey === sender pubkey -> transfer family.
    expect(sdkParams.isTransferFamily).toBe(true);
  });

  it('returns submit-failed (discriminated) when the executor rejects, never throwing a secret-bearing error', async () => {
    const { deps } = makeDeps({
      executeNativeUrStoaTransfer: vi
        .fn()
        .mockRejectedValue(new Error(`boom ${paymentKeypair.secretKey}`)),
    });

    const result = await transferUrStoa(baseParams(), deps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('submit-failed');
      // The discriminated reason must not leak the secret.
      expect(JSON.stringify(result)).not.toContain(paymentKeypair.secretKey);
    }
  });

  it('classifies a gas-payer/sponsor refusal as gas-payer-rejected (consistency with stake.ts)', async () => {
    // A gas-station refusal matches the DALOS / GAS_PAYER signature stake.ts
    // classifies; the catch must return the distinct `gas-payer-rejected` reason
    // the result type declares and the TransferUrStoaModal renders, NOT the
    // generic `submit-failed`.
    const { deps } = makeDeps({
      executeNativeUrStoaTransfer: vi
        .fn()
        .mockRejectedValue(new Error('Failure: Tx Failed: DALOS.GAS_PAYER capability not granted')),
    });

    const result = await transferUrStoa(baseParams(), deps);

    expect(result).toEqual({ ok: false, reason: 'gas-payer-rejected' });
  });

  it('never prints the keypair, secret, or recipient material to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const { deps } = makeDeps();

    await transferUrStoa(baseParams(), deps);

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const text = call.map((a) => String(a)).join(' ');
        expect(text).not.toContain(paymentKeypair.secretKey);
        expect(text).not.toContain(RECEIVER_PUB);
      }
    }
  });
});
