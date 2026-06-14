import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  err,
  ok,
  isOk,
  type Request,
  type Response,
  type SignTxRequest,
  type SignerSpec,
  type IsUnlockedResponse,
  type ResponseFor,
  type FailureReason,
  type NoSecretFields,
  type ResponseHasNoSecretField,
  type UrStoaOpRequest,
  type UrStoaOpResponse,
} from '../protocol';

describe('messaging protocol — wire serializability', () => {
  it('round-trips an unlock REQUEST through structured-clone-equivalent JSON losslessly', () => {
    const req: Request = { type: 'unlock', walletId: 'wallet-1', password: 'hunter2' };
    const wire = JSON.parse(JSON.stringify(req)) as Request;
    expect(wire).toEqual(req);
    // The discriminant survives the round-trip so the background can switch on it.
    expect(wire.type).toBe('unlock');
  });

  it('round-trips a discriminated failure RESPONSE losslessly so the popup reads the reason', () => {
    const res: Response = { ok: false, reason: 'wrong-password' };
    const wire = JSON.parse(JSON.stringify(res)) as Response;
    expect(wire).toEqual(res);
    expect(wire.ok).toBe(false);
    if (wire.ok === false) {
      expect(wire.reason).toBe('wrong-password');
    }
  });

  it('round-trips a signTx REQUEST carrying a signerSpec + approvalToken losslessly', () => {
    const req: SignTxRequest = {
      type: 'signTx',
      tx: { cmd: '{"payload":{}}', hash: 'abc' },
      accountIndex: 3,
      signerSpec: { kind: 'active' },
      approvalToken: 'one-use-token',
    };
    const wire = JSON.parse(JSON.stringify(req)) as SignTxRequest;
    expect(wire).toEqual(req);
    expect(wire.signerSpec.kind).toBe('active');
    expect(wire.approvalToken).toBe('one-use-token');
  });
});

describe('result helpers — discriminant narrows', () => {
  it('err() builds {ok:false, reason} and isOk() narrows it to the failure arm', () => {
    const res = err('unauthorized');
    expect(res).toEqual({ ok: false, reason: 'unauthorized' });
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) {
      // After narrowing, `reason` is reachable and the success payload is not.
      expectTypeOf(res.reason).toEqualTypeOf<FailureReason>();
    }
  });

  it('ok() builds a success payload and isOk() narrows to it carrying the data', () => {
    const res = ok({ unlocked: true });
    expect(res).toEqual({ ok: true, unlocked: true });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.unlocked).toBe(true);
    }
  });
});

describe('signerSpec discriminants (XP-12)', () => {
  it('models active / advanced / gas-station / commandSigDatas as a closed discriminated union', () => {
    const active: SignerSpec = { kind: 'active' };
    const advanced: SignerSpec = { kind: 'advanced', address: 'k:deadbeef' };
    const gas: SignerSpec = { kind: 'gas-station', chainId: '0' };
    const dapp: SignerSpec = {
      kind: 'commandSigDatas',
      sigData: { cmd: '{"payload":{}}', sigs: [{ pubKey: 'pk', sig: null }] },
    };

    expect(active.kind).toBe('active');
    expect(advanced.kind === 'advanced' && advanced.address).toBe('k:deadbeef');
    expect(gas.kind === 'gas-station' && gas.chainId).toBe('0');
    expect(dapp.kind === 'commandSigDatas' && dapp.sigData.cmd).toBe('{"payload":{}}');

    // The discriminant is the exhaustive switch key the background resolves on.
    const kinds: SignerSpec['kind'][] = ['active', 'advanced', 'gas-station', 'commandSigDatas'];
    expectTypeOf<SignerSpec['kind']>().toEqualTypeOf<(typeof kinds)[number]>();
  });

  it('a signerSpec carries NO raw key material — only indices/addresses/sigData', () => {
    // The background resolves keys; the popup sends a SPEC, never a key. A
    // runtime drift guard over the constructed specs.
    for (const spec of [
      { kind: 'active' } as SignerSpec,
      { kind: 'advanced', address: 'k:x' } as SignerSpec,
      { kind: 'gas-station', chainId: '0' } as SignerSpec,
    ]) {
      const json = JSON.stringify(spec).toLowerCase();
      expect(json).not.toMatch(/privatekey|secretkey|mnemonic|password/);
    }
  });
});

describe('isUnlocked RESPONSE shape (RR#12, pinned)', () => {
  it('is {ok:true, unlocked:boolean} — the query always succeeds and carries the boolean', () => {
    const res: IsUnlockedResponse = { ok: true, unlocked: false };
    const wire = JSON.parse(JSON.stringify(res)) as IsUnlockedResponse;
    expect(wire).toEqual({ ok: true, unlocked: false });
    expect(wire.ok).toBe(true);
    expect(wire.unlocked).toBe(false);
    expectTypeOf<IsUnlockedResponse>().toEqualTypeOf<{
      readonly ok: true;
      readonly unlocked: boolean;
    }>();
  });

  it("isUnlocked's success arm has no `reason` field — the QUERY cannot fail with `locked`", () => {
    const res = ok({ unlocked: true });
    expect('reason' in res).toBe(false);
  });
});

describe('SECRET-FREE BOUNDARY (RR#2, load-bearing)', () => {
  it('the type-level guard rejects any response variant carrying a secret field', () => {
    // `ResponseHasNoSecretField<Response>` is `true` iff NO arm of the Response
    // union has a mnemonic/privateKey/secretKey/password key. This is the
    // compile-time invariant; the assignment below fails `tsc` if it regresses.
    expectTypeOf<ResponseHasNoSecretField<Response>>().toEqualTypeOf<true>();

    // The `NoSecretFields` mapper flags a shape that DOES carry a secret as
    // `never`, proving the guard discriminates rather than rubber-stamping.
    expectTypeOf<NoSecretFields<{ ok: true; mnemonic: string }>>().toEqualTypeOf<never>();
    expectTypeOf<NoSecretFields<{ ok: true; unlocked: boolean }>>().not.toEqualTypeOf<never>();
  });

  it('no constructible response value serializes a mnemonic/privateKey/secretKey/password', () => {
    const samples: Response[] = [
      ok({ unlocked: true }),
      err('wrong-password'),
      err('corrupt-envelope'),
      err('unsupported-format'),
      err('locked'),
      err('no-wallet'),
      err('unauthorized'),
    ];
    for (const res of samples) {
      // Match secret KEYS (`"password":`), not the substring inside the
      // `wrong-password` reason value — the boundary forbids secret fields.
      const json = JSON.stringify(res).toLowerCase();
      expect(json).not.toMatch(/"(mnemonic|privatekey|secretkey|password)":/);
    }
  });

  it('the unlock REQUEST carries the password transiently but no RESPONSE echoes it back', () => {
    const req: Request = { type: 'unlock', walletId: 'w', password: 'secret' };
    expect('password' in req).toBe(true);
    // Every success response for unlock omits the password entirely.
    const res: ResponseFor<'unlock'> = ok({});
    expect(JSON.stringify(res).toLowerCase()).not.toContain('secret');
    expect('password' in res).toBe(false);
  });
});

describe('UrStoa-op message (XP-12 background signing)', () => {
  it('round-trips a stake urstoaOp REQUEST carrying ONLY public params (no keypair)', () => {
    const req: UrStoaOpRequest = {
      type: 'urstoaOp',
      op: 'stake',
      params: { paymentKeyAddress: 'k:abc', amount: '5.0' },
    };
    const wire = JSON.parse(JSON.stringify(req)) as UrStoaOpRequest;
    expect(wire).toEqual(req);
    expect(wire.type).toBe('urstoaOp');
    expect(wire.op).toBe('stake');
    // The popup sends public params only — the background resolves the keypair.
    const json = JSON.stringify(req).toLowerCase();
    expect(json).not.toMatch(/privatekey|secretkey|mnemonic|"password"|gasstationkey|paymentkeypair/);
  });

  it('models stake/unstake/collect/transfer as the closed urstoaOp discriminant', () => {
    const ops: UrStoaOpRequest['op'][] = ['stake', 'unstake', 'collect', 'transfer'];
    const transfer: UrStoaOpRequest = {
      type: 'urstoaOp',
      op: 'transfer',
      params: { senderAddress: 'k:a', receiverAddress: 'k:b', amount: '1.0' },
    };
    const collect: UrStoaOpRequest = {
      type: 'urstoaOp',
      op: 'collect',
      params: { paymentKeyAddress: 'k:a' },
    };
    expect(ops).toContain(transfer.op);
    expect(collect.op).toBe('collect');
    // No transfer/collect params leak a secret field.
    for (const r of [transfer, collect]) {
      expect(JSON.stringify(r).toLowerCase()).not.toMatch(/privatekey|secretkey|mnemonic|paymentkeypair/);
    }
  });

  it('urstoaOp success RESPONSE carries the requestKey and NO key material', () => {
    const res: UrStoaOpResponse = { ok: true, requestKey: 'rk-stake-1' };
    const wire = JSON.parse(JSON.stringify(res)) as UrStoaOpResponse;
    expect(wire).toEqual({ ok: true, requestKey: 'rk-stake-1' });
    expect(wire.ok === true && wire.requestKey).toBe('rk-stake-1');
    expect(JSON.stringify(res).toLowerCase()).not.toMatch(/"(mnemonic|privatekey|secretkey|password)":/);
  });

  it('urstoaOp failure RESPONSE carries a discriminated reason (locked / submit-failed)', () => {
    const locked: UrStoaOpResponse = { ok: false, reason: 'locked' };
    const failed: UrStoaOpResponse = { ok: false, reason: 'submit-failed', detail: 'node rejected' };
    expect(locked.ok === false && locked.reason).toBe('locked');
    expect(failed.ok === false && failed.reason).toBe('submit-failed');
  });

  it('keeps the secret-free boundary intact with the urstoaOp arm added to Response', () => {
    // The compile-time guard still holds: adding the UrStoaOp response arm did not
    // introduce a secret-bearing field. (Asserted via the existing
    // ResponseHasNoSecretField<Response> elsewhere; here a constructed sample.)
    const res: Response = { ok: true, requestKey: 'rk' } as Response;
    expect(JSON.stringify(res).toLowerCase()).not.toMatch(/"(mnemonic|privatekey|secretkey|password)":/);
  });
});

describe('FailureReason set (Phase-2 RR#12 + SW-specific)', () => {
  it('reuses the Phase-2 reasons plus the SW-specific unauthorized/locked/no-wallet', () => {
    const reasons: FailureReason[] = [
      'wrong-password',
      'corrupt-envelope',
      'unsupported-format',
      'locked',
      'no-wallet',
      'unauthorized',
    ];
    for (const r of reasons) {
      expect(err(r).reason).toBe(r);
    }
  });
});
