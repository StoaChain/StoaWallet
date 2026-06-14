// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STOA_DAPP_CHANNEL,
  installStoaProvider,
  type StoaProvider,
  type StoaRequestEnvelope,
  type StoaResponseEnvelope,
  type StoaEventEnvelope,
} from '../inpage';

/**
 * Deliver an inbound message to the page world exactly as a real browser does
 * when the isolated-world content script posts toward `window`: a `message` event
 * whose `source` is this window and whose `origin` is our own origin. We dispatch
 * a constructed MessageEvent rather than calling `window.postMessage`, because
 * jsdom's `postMessage` leaves `event.source` as null — the very field the
 * provider's RR#3 boundary checks — whereas a real browser stamps it as `window`.
 */
function deliverToPage(envelope: StoaResponseEnvelope | StoaEventEnvelope): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: envelope,
      origin: window.location.origin,
      source: window,
    }),
  );
}

/**
 * Flush jsdom's macrotask queue so a provider's outbound `window.postMessage`
 * (delivered asynchronously by jsdom, unlike the synchronous dispatch a real
 * browser uses for same-window posts) reaches the harness's request collector.
 * Requires real timers.
 */
function flushTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Fake content-script responder. The real content script lives in the isolated
 * world and bridges to the background SW; here we stand in for it inside the SAME
 * jsdom window. It listens for the provider's outbound REQUEST envelopes and
 * replays a correlated RESPONSE envelope back over `window.postMessage`, exactly
 * as the content script would, so we exercise the real correlation + validation
 * paths without any chrome.* surface.
 */
function attachFakeContentScript(
  reply: (req: StoaRequestEnvelope) => Record<string, unknown> | 'no-reply',
): { sent: StoaRequestEnvelope[]; detach: () => void } {
  const sent: StoaRequestEnvelope[] = [];
  const handler = (event: MessageEvent): void => {
    const data = event.data as Partial<StoaRequestEnvelope> | undefined;
    if (!data || data.channel !== STOA_DAPP_CHANNEL || data.direction !== 'to-wallet') {
      return;
    }
    const req = data as StoaRequestEnvelope;
    sent.push(req);
    const result = reply(req);
    if (result === 'no-reply') {
      return;
    }
    const response: StoaResponseEnvelope = {
      channel: STOA_DAPP_CHANNEL,
      direction: 'to-page',
      kind: 'response',
      id: req.id,
      result,
    };
    deliverToPage(response);
  };
  window.addEventListener('message', handler);
  return { sent, detach: () => window.removeEventListener('message', handler) };
}

describe('inpage window.stoa provider', () => {
  let provider: StoaProvider;
  let uninstall: () => void;

  beforeEach(() => {
    const installed = installStoaProvider(window);
    provider = installed.provider;
    uninstall = installed.uninstall;
  });

  afterEach(() => {
    uninstall();
    vi.useRealTimers();
  });

  it('exposes the eckoWALLET-style surface with isStoa===true for feature detection', () => {
    // Mirrors `window.kadena.isKadena`: a dApp feature-detects the wallet by this flag.
    expect(provider.isStoa).toBe(true);
    expect(typeof provider.request).toBe('function');
    expect(typeof provider.on).toBe('function');
    expect(typeof provider.removeListener).toBe('function');
  });

  it('NEVER exposes key material — the page world holds no secrets', () => {
    // The provider runs in the untrusted page world; a leaked field here is a
    // wallet-draining vulnerability. No private/secret/mnemonic surface may exist.
    const keys = Object.keys(provider);
    for (const forbidden of ['privateKey', 'secretKey', 'mnemonic', 'password', 'seed']) {
      expect(keys).not.toContain(forbidden);
      expect((provider as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });

  it('posts a correlated request (with channel marker, targetOrigin===origin) and resolves with the matched response', async () => {
    const postSpy = vi.spyOn(window, 'postMessage');
    const fake = attachFakeContentScript(() => ({ status: 'success', account: 'k:abc' }));

    const result = (await provider.request({ method: 'kda_connect', networkId: 'stoa01' })) as {
      status: string;
      account: string;
    };

    // Resolves with the responder's payload, matched by id.
    expect(result).toEqual({ status: 'success', account: 'k:abc' });

    // The outbound envelope carried the method, the shared channel marker, and an id.
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].channel).toBe(STOA_DAPP_CHANNEL);
    expect(fake.sent[0].payload.method).toBe('kda_connect');
    expect(fake.sent[0].payload.networkId).toBe('stoa01');
    expect(typeof fake.sent[0].id).toBe('string');
    expect(fake.sent[0].id.length).toBeGreaterThan(0);

    // RR#3: the post used an explicit same-origin targetOrigin, NEVER "*".
    const postCall = postSpy.mock.calls.find(
      ([msg]) => (msg as StoaRequestEnvelope)?.channel === STOA_DAPP_CHANNEL,
    );
    expect(postCall).toBeDefined();
    expect(postCall?.[1]).toBe(window.location.origin);
    expect(postCall?.[1]).not.toBe('*');

    fake.detach();
  });

  it('resolves two interleaved requests with THEIR OWN responses (id-keyed pending map)', async () => {
    // Hold both requests, then reply OUT OF ORDER to prove each promise is keyed
    // by its own id rather than resolving by arrival order.
    const pending: StoaRequestEnvelope[] = [];
    const handler = (event: MessageEvent): void => {
      const data = event.data as Partial<StoaRequestEnvelope> | undefined;
      if (data?.channel !== STOA_DAPP_CHANNEL || data.direction !== 'to-wallet') return;
      pending.push(data as StoaRequestEnvelope);
    };
    window.addEventListener('message', handler);

    const pA = provider.request({ method: 'kda_getNetwork' }) as Promise<{ tag: string }>;
    const pB = provider.request({ method: 'kda_checkStatus' }) as Promise<{ tag: string }>;

    // Let the (jsdom-async) outbound posts dispatch into our collector.
    await flushTasks();
    expect(pending).toHaveLength(2);
    const [reqA, reqB] = pending;
    expect(reqA.id).not.toBe(reqB.id);

    // Reply to B first, then A — interleaved/out-of-order.
    const respB: StoaResponseEnvelope = {
      channel: STOA_DAPP_CHANNEL,
      direction: 'to-page',
      kind: 'response',
      id: reqB.id,
      result: { tag: 'B' },
    };
    const respA: StoaResponseEnvelope = {
      channel: STOA_DAPP_CHANNEL,
      direction: 'to-page',
      kind: 'response',
      id: reqA.id,
      result: { tag: 'A' },
    };
    deliverToPage(respB);
    deliverToPage(respA);

    expect(await pA).toEqual({ tag: 'A' });
    expect(await pB).toEqual({ tag: 'B' });

    window.removeEventListener('message', handler);
  });

  it('surfaces a {status:"fail"} result as-is without fabricating success (eckoWALLET convention)', async () => {
    const fake = attachFakeContentScript(() => ({ status: 'fail', message: 'User declined' }));
    const result = (await provider.request({ method: 'kda_connect' })) as { status: string };
    // The provider does NOT throw or coerce a fail into a success — the dApp decides.
    expect(result).toEqual({ status: 'fail', message: 'User declined' });
    fake.detach();
  });

  it('fires on("accountsChanged") handlers on an inbound validated event message', () => {
    const handler = vi.fn();
    provider.on('accountsChanged', handler);

    const evt: StoaEventEnvelope = {
      channel: STOA_DAPP_CHANNEL,
      direction: 'to-page',
      kind: 'event',
      event: 'accountsChanged',
      data: { accounts: ['k:abc', 'k:def'] },
    };
    deliverToPage(evt);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ accounts: ['k:abc', 'k:def'] });
  });

  it('removeListener stops a handler from firing on subsequent events', () => {
    const handler = vi.fn();
    provider.on('accountsChanged', handler);
    provider.removeListener('accountsChanged', handler);

    const evt: StoaEventEnvelope = {
      channel: STOA_DAPP_CHANNEL,
      direction: 'to-page',
      kind: 'event',
      event: 'accountsChanged',
      data: { accounts: [] },
    };
    deliverToPage(evt);

    expect(handler).not.toHaveBeenCalled();
  });

  it('RR#3: ignores a response from a different source (foreign frame) — never resolves on it', async () => {
    vi.useFakeTimers();
    const promise = provider.request({ method: 'kda_connect' }, { timeoutMs: 1000 });
    const settled = vi.fn();
    promise.then(settled, settled);

    // Capture the id the provider assigned, then forge a reply from a FOREIGN source.
    // We post via a fake event whose `source` is NOT this window.
    const foreignSource = {} as Window;
    let assignedId = '';
    const sniff = (event: MessageEvent): void => {
      const data = event.data as Partial<StoaRequestEnvelope> | undefined;
      if (data?.channel === STOA_DAPP_CHANNEL && data.direction === 'to-wallet') {
        assignedId = (data as StoaRequestEnvelope).id;
      }
    };
    window.addEventListener('message', sniff);
    await vi.advanceTimersByTimeAsync(0);
    window.removeEventListener('message', sniff);
    expect(assignedId).not.toBe('');

    const forged: StoaResponseEnvelope = {
      channel: STOA_DAPP_CHANNEL,
      direction: 'to-page',
      kind: 'response',
      id: assignedId,
      result: { status: 'success', stolen: true },
    };
    // Dispatch a MessageEvent whose source is a foreign window object.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: forged,
        origin: window.location.origin,
        source: foreignSource,
      }),
    );

    await Promise.resolve();
    // The forged foreign-source reply must be ignored: promise still pending.
    expect(settled).not.toHaveBeenCalled();

    // Drain the timeout so the test does not leak a pending promise.
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('RR#3: ignores a response with a wrong origin — never resolves on it', async () => {
    vi.useFakeTimers();
    const promise = provider.request({ method: 'kda_connect' }, { timeoutMs: 1000 });
    const settled = vi.fn();
    promise.then(settled, settled);

    let assignedId = '';
    const sniff = (event: MessageEvent): void => {
      const data = event.data as Partial<StoaRequestEnvelope> | undefined;
      if (data?.channel === STOA_DAPP_CHANNEL && data.direction === 'to-wallet') {
        assignedId = (data as StoaRequestEnvelope).id;
      }
    };
    window.addEventListener('message', sniff);
    await vi.advanceTimersByTimeAsync(0);
    window.removeEventListener('message', sniff);
    expect(assignedId).not.toBe('');

    const forged: StoaResponseEnvelope = {
      channel: STOA_DAPP_CHANNEL,
      direction: 'to-page',
      kind: 'response',
      id: assignedId,
      result: { status: 'success', stolen: true },
    };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: forged,
        origin: 'https://evil.example',
        source: window,
      }),
    );

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
  });

  it('RR#14: a request with no reply times out, rejects, and removes its pending entry', async () => {
    vi.useFakeTimers();
    const fake = attachFakeContentScript(() => 'no-reply');

    const promise = provider.request({ method: 'kda_connect' }, { timeoutMs: 500 });
    const onReject = vi.fn();
    promise.catch(onReject);

    // Before the deadline the promise is still pending.
    await vi.advanceTimersByTimeAsync(499);
    expect(onReject).not.toHaveBeenCalled();

    // At the deadline it rejects with a timeout reason.
    await vi.advanceTimersByTimeAsync(1);
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(String(onReject.mock.calls[0][0])).toMatch(/timeout/i);

    // The entry is removed: a LATE reply arriving after timeout resolves nothing
    // (no double-settle, no error) — proving the pending map was cleaned up.
    const lateReply: StoaResponseEnvelope = {
      channel: STOA_DAPP_CHANNEL,
      direction: 'to-page',
      kind: 'response',
      id: fake.sent[0].id,
      result: { status: 'success' },
    };
    expect(() => deliverToPage(lateReply)).not.toThrow();
    await Promise.resolve();
    // Still exactly one settle: the late reply found no pending entry to resolve.
    expect(onReject).toHaveBeenCalledTimes(1);

    fake.detach();
  });

  it('RR#14: an inbound disconnect event rejects ALL in-flight requests', async () => {
    const fake = attachFakeContentScript(() => 'no-reply');

    const pA = provider.request({ method: 'kda_connect' });
    const pB = provider.request({ method: 'kda_checkStatus' });
    const rejA = vi.fn();
    const rejB = vi.fn();
    pA.catch(rejA);
    pB.catch(rejB);

    await Promise.resolve();

    const disconnect: StoaEventEnvelope = {
      channel: STOA_DAPP_CHANNEL,
      direction: 'to-page',
      kind: 'event',
      event: 'disconnect',
      data: { reason: 'wallet-locked' },
    };
    deliverToPage(disconnect);

    await Promise.resolve();
    await Promise.resolve();

    expect(rejA).toHaveBeenCalledTimes(1);
    expect(rejB).toHaveBeenCalledTimes(1);
    expect(String(rejA.mock.calls[0][0])).toMatch(/disconnect/i);

    fake.detach();
  });

  it('also fires on("disconnect") handlers when a disconnect event arrives', () => {
    const handler = vi.fn();
    provider.on('disconnect', handler);

    const disconnect: StoaEventEnvelope = {
      channel: STOA_DAPP_CHANNEL,
      direction: 'to-page',
      kind: 'event',
      event: 'disconnect',
      data: { reason: 'wallet-locked' },
    };
    deliverToPage(disconnect);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ reason: 'wallet-locked' });
  });
});
