import { describe, expect, it, vi } from 'vitest';

import { STOA_AUTONOMIC_OURONETGASSTATION } from '@stoachain/ouronet-core/constants';

import { buildGaslessProbeTx, makeSignedLocalProbe } from '../buildProbe';

const ACCOUNT_PUB =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('buildGaslessProbeTx', () => {
  it('sets the gas-station as the sender account for any chain (no chain-0 restriction)', () => {
    const spec = buildGaslessProbeTx({
      chainId: '7',
      accountPublicKey: ACCOUNT_PUB,
    });

    // A gasless transfer is paid by the gas station, not by the fresh account.
    expect(spec.senderAccount).toBe(STOA_AUTONOMIC_OURONETGASSTATION);
    expect(spec.chainId).toBe('7');
  });

  it('scopes the cap-signer with exactly the (ouronet-ns.DALOS.GAS_PAYER "" 0 0.0) capability', () => {
    const spec = buildGaslessProbeTx({
      chainId: '0',
      accountPublicKey: ACCOUNT_PUB,
    });

    expect(spec.signers).toHaveLength(1);
    const signer = spec.signers[0];
    expect(signer.capabilities).toHaveLength(1);
    const cap = signer.capabilities[0];
    // The eligibility gate keys off this exact cap name + args. A drift here
    // means the gas-payer module would reject the transaction at submit time.
    expect(cap.name).toBe('ouronet-ns.DALOS.GAS_PAYER');
    expect(cap.args).toEqual(['', { int: 0 }, { decimal: '0.0' }]);
  });

  it('selects the cap-signing key via selectCapsSigningKey — the fresh account key, gas station has no user key', () => {
    const spec = buildGaslessProbeTx({
      chainId: '3',
      accountPublicKey: ACCOUNT_PUB,
    });

    // The gas station is a `c:` account with no user-held key, so the fresh
    // account's own key must sign the GAS_PAYER cap. selectCapsSigningKey
    // (paymentKeyPub=null, codexPubs={accountPub}, pureSigningPubs=∅) picks
    // "any codex key not used for pure signing" — the fresh account's key.
    expect(spec.signers[0].publicKey).toBe(ACCOUNT_PUB);
  });
});

describe('makeSignedLocalProbe', () => {
  it('runs a SIGNED /local (preflight + signatureVerification) against the per-chain node1 endpoint — not a shape-only dirtyRead', async () => {
    const preflight = vi.fn(async () => ({
      result: { status: 'success' },
    }));
    const dirtyRead = vi.fn();
    const createClient = vi.fn(() => ({ preflight, dirtyRead }));
    const getActivePactUrl = vi.fn((chainId: string) => `https://node1/${chainId}`);
    const signTx = vi.fn(async (tx: unknown) => ({ ...(tx as object), sigs: [{ sig: 'x' }] }));

    const probe = makeSignedLocalProbe({
      accountPublicKey: ACCOUNT_PUB,
      signTx,
      createClient,
      getActivePactUrl,
    });

    const result = await probe('5');

    // The probe MUST hit node1's per-chain endpoint.
    expect(getActivePactUrl).toHaveBeenCalledWith('5');
    expect(createClient).toHaveBeenCalledWith('https://node1/5');
    // Eligibility is enforced on a SIGNED tx — preflight runs the gas-payer
    // gate; a parse-only dirtyRead would NOT and must not be used here.
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(dirtyRead).not.toHaveBeenCalled();
    expect(result).toEqual({ chainId: '5', outcome: 'pass' });
  });

  it('records a node-rejected eligibility check as fail (distinct from pass)', async () => {
    const preflight = vi.fn(async () => ({
      result: { status: 'failure', error: { message: 'gas payer refused' } },
    }));
    const createClient = vi.fn(() => ({ preflight, dirtyRead: vi.fn() }));
    const getActivePactUrl = vi.fn((chainId: string) => `https://node1/${chainId}`);
    const signTx = vi.fn(async (tx: unknown) => ({ ...(tx as object), sigs: [{ sig: 'x' }] }));

    const probe = makeSignedLocalProbe({
      accountPublicKey: ACCOUNT_PUB,
      signTx,
      createClient,
      getActivePactUrl,
    });

    const result = await probe('2');
    expect(result.outcome).toBe('fail');
  });

  it('records an unreachable node as unreachable, never a silent pass', async () => {
    const createClient = vi.fn(() => ({
      preflight: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      dirtyRead: vi.fn(),
    }));
    const getActivePactUrl = vi.fn((chainId: string) => `https://node1/${chainId}`);
    const signTx = vi.fn(async (tx: unknown) => tx);

    const probe = makeSignedLocalProbe({
      accountPublicKey: ACCOUNT_PUB,
      signTx,
      createClient,
      getActivePactUrl,
    });

    const result = await probe('1');
    expect(result.outcome).toBe('unreachable');
  });
});
