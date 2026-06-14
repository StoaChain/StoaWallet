import { describe, expect, expectTypeOf, it } from 'vitest';
import { KADENA_NETWORK } from '@stoachain/stoa-core/constants';

import {
  DAPP_CHANNEL,
  dappOk,
  dappFail,
  isDappOk,
  makeConnectRequest,
  makeCheckStatusRequest,
  makeDisconnectRequest,
  makeQuickSignRequest,
  makeGetNetworkRequest,
  stampOrigin,
  type DappRequest,
  type DappResponse,
  type DappEvent,
  type QuickSignRequest,
  type QuickSignResponse,
  type GetNetworkResponse,
  type DappFailReason,
  type DappMessageHasNoSecretField,
  type NoSecretFields,
} from '../protocol';

describe('dApp protocol — request/response round-trip (RR#10)', () => {
  it('round-trips a quickSign REQUEST through structured-clone-equivalent JSON losslessly', () => {
    const req = makeQuickSignRequest('id-1', KADENA_NETWORK, [
      { cmd: '{"payload":{}}', sigs: [{ pubKey: 'k:abc', sig: null }] },
    ]);
    const wire = JSON.parse(JSON.stringify(req)) as QuickSignRequest;
    expect(wire).toEqual(req);
    // The method + id survive the wire so the background correlates the reply.
    expect(wire.method).toBe('kda_requestQuickSign');
    expect(wire.id).toBe('id-1');
    expect(wire.data.commandSigDatas[0].sigs[0].sig).toBeNull();
  });

  it('correlates a response to its request by the SAME id and narrows on status', () => {
    const req = makeQuickSignRequest('corr-7', KADENA_NETWORK, [
      { cmd: '{"payload":{}}', sigs: [{ pubKey: 'k:abc', sig: null }] },
    ]);
    const res: QuickSignResponse = dappOk(req.id, 'kda_requestQuickSign', {
      responses: [
        {
          commandSigData: { cmd: '{"payload":{}}', sigs: [{ pubKey: 'k:abc', sig: 'deadbeef' }] },
          outcome: { result: 'success', hash: 'the-hash' },
        },
      ],
    });
    const wire = JSON.parse(JSON.stringify(res)) as QuickSignResponse;
    expect(wire.id).toBe(req.id);
    expect(isDappOk(wire)).toBe(true);
    if (isDappOk(wire)) {
      // Narrowed to success: the signed artifact is reachable, no `reason`.
      const outcome = wire.responses[0].outcome;
      expect(outcome.result === 'success' && outcome.hash).toBe('the-hash');
      expect(wire.responses[0].commandSigData.sigs[0].sig).toBe('deadbeef');
    }
  });
});

describe('quickSign per-method shape (RR#10, canonical)', () => {
  it('SUCCESS = {responses:[{commandSigData, outcome:{result,hash}}]} — distinct from fail {reason}', () => {
    const success: QuickSignResponse = dappOk('q1', 'kda_requestQuickSign', {
      responses: [
        {
          commandSigData: { cmd: 'c', sigs: [{ pubKey: 'k:x', sig: 'sig' }] },
          outcome: { result: 'success', hash: 'h' },
        },
      ],
    });
    expect(success.status).toBe('success');
    if (success.status === 'success') {
      expect(success.responses[0].outcome.result).toBe('success');
      // The success shape has no `reason` field — fail and success are NOT uniform.
      expect('reason' in success).toBe(false);
    }
  });

  it('FAIL = {status:"fail", reason} carries a reason and NO responses array', () => {
    const failure: QuickSignResponse = dappFail('q2', 'kda_requestQuickSign', 'user-rejected');
    expect(failure.status).toBe('fail');
    if (failure.status === 'fail') {
      expect(failure.reason).toBe('user-rejected');
      expect('responses' in failure).toBe(false);
    }
  });
});

describe('per-method request constructors + getNetwork (RR#10)', () => {
  it('builds connect / checkStatus / disconnect / getNetwork requests keyed by method with a correlation id', () => {
    expect(makeConnectRequest('a', KADENA_NETWORK).method).toBe('kda_connect');
    expect(makeCheckStatusRequest('b', KADENA_NETWORK).method).toBe('kda_checkStatus');
    expect(makeDisconnectRequest('c').method).toBe('kda_disconnect');
    expect(makeGetNetworkRequest('d').method).toBe('kda_getNetwork');
    expect(makeConnectRequest('a', KADENA_NETWORK).id).toBe('a');
  });

  it('getNetwork response carries the StoaChain networkId from the KADENA_NETWORK constant (never a literal)', () => {
    const res: GetNetworkResponse = dappOk('d', 'kda_getNetwork', { networkId: KADENA_NETWORK });
    expect(res.status).toBe('success');
    if (res.status === 'success') {
      // Pinned to the constant, not a hardcoded "stoa" string in the protocol.
      expect(res.networkId).toBe(KADENA_NETWORK);
    }
  });
});

describe('background-filled origin (untrusted page payload)', () => {
  it('the page-message constructor does NOT set a trusted origin', () => {
    const req = makeConnectRequest('o1', KADENA_NETWORK);
    // The page/inpage/content-script are NOT the origin authority. The
    // constructor must leave `origin` unset; only the background stamps it.
    expect('origin' in req).toBe(false);
  });

  it('stampOrigin fills the verified origin from the chrome.runtime sender, overriding any page-claimed value', () => {
    const req = makeConnectRequest('o2', KADENA_NETWORK);
    const stamped = stampOrigin(req, 'https://app.example.com');
    expect(stamped.origin).toBe('https://app.example.com');
    // The stamp does not mutate the page message in place.
    expect('origin' in req).toBe(false);
    // A page that smuggles a claimed origin is overwritten by the verified one.
    const liar = { ...req, origin: 'https://evil.example.com' } as DappRequest;
    expect(stampOrigin(liar, 'https://app.example.com').origin).toBe('https://app.example.com');
  });
});

describe('EVENT variant (EIP-1193-like background push)', () => {
  it('accountsChanged carries only public k: account strings, disconnect carries none', () => {
    const accountsChanged: DappEvent = { event: 'accountsChanged', accounts: ['k:abc', 'k:def'] };
    const disconnect: DappEvent = { event: 'disconnect' };
    expect(accountsChanged.event).toBe('accountsChanged');
    if (accountsChanged.event === 'accountsChanged') {
      expect(accountsChanged.accounts).toEqual(['k:abc', 'k:def']);
    }
    expect(JSON.parse(JSON.stringify(disconnect))).toEqual({ event: 'disconnect' });
  });
});

describe('SECRET-FREE BOUNDARY (load-bearing)', () => {
  it('the type-level guard rejects any request/response/event variant carrying a secret field', () => {
    // `true` iff NO arm of the protocol union has mnemonic/privateKey/secretKey.
    expectTypeOf<DappMessageHasNoSecretField<DappRequest>>().toEqualTypeOf<true>();
    expectTypeOf<DappMessageHasNoSecretField<DappResponse>>().toEqualTypeOf<true>();
    expectTypeOf<DappMessageHasNoSecretField<DappEvent>>().toEqualTypeOf<true>();

    // The mapper flags a secret-bearing shape as `never`, proving it discriminates.
    expectTypeOf<NoSecretFields<{ id: string; mnemonic: string }>>().toEqualTypeOf<never>();
    expectTypeOf<NoSecretFields<{ id: string; cmd: string }>>().not.toEqualTypeOf<never>();
  });

  it('no constructible request or response serializes a mnemonic/privateKey/secretKey', () => {
    const samples: (DappRequest | DappResponse)[] = [
      makeConnectRequest('s1', KADENA_NETWORK),
      makeQuickSignRequest('s2', KADENA_NETWORK, [{ cmd: 'c', sigs: [{ pubKey: 'k:x', sig: null }] }]),
      dappOk('s2', 'kda_requestQuickSign', {
        responses: [
          { commandSigData: { cmd: 'c', sigs: [{ pubKey: 'k:x', sig: 'sig' }] }, outcome: { result: 'success', hash: 'h' } },
        ],
      }),
      dappFail('s3', 'kda_connect', 'user-rejected'),
    ];
    for (const msg of samples) {
      const json = JSON.stringify(msg).toLowerCase();
      expect(json).not.toMatch(/"(mnemonic|privatekey|secretkey)":/);
    }
  });
});

describe('result helpers + fail reasons', () => {
  it('dappFail builds {status:"fail", reason} for every eckoWALLET fail reason', () => {
    const reasons: DappFailReason[] = [
      'user-rejected',
      'not-connected',
      'origin-not-allowed',
      'rate-limited',
      'locked',
      'invalid-request',
    ];
    for (const r of reasons) {
      const res = dappFail('x', 'kda_connect', r);
      expect(res.status).toBe('fail');
      expect(res.reason).toBe(r);
      expect(isDappOk(res)).toBe(false);
    }
  });

  it('exposes a stable channel marker for the transport layer to filter on', () => {
    expect(typeof DAPP_CHANNEL).toBe('string');
    expect(DAPP_CHANNEL.length).toBeGreaterThan(0);
  });
});
