// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DAPP_CHANNEL } from '../protocol';
import { installContentScriptRelay, type RelayRuntime } from '../contentScript';

/**
 * Inbound-from-page message exactly as a real browser stamps it when the
 * page-world inpage provider posts toward `window`: `source === window` and
 * `origin === window.location.origin`. We construct the MessageEvent rather than
 * call `postMessage` because jsdom's `postMessage` leaves `event.source` null —
 * the very field the relay's RR#3 boundary checks — whereas a real browser sets
 * it to the posting window.
 */
function deliverFromPage(
  data: unknown,
  overrides: { source?: unknown; origin?: string } = {},
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin: overrides.origin ?? window.location.origin,
      source: (overrides.source ?? window) as Window,
    }),
  );
}

/** A page-side REQUEST envelope in the shared inpage<->content wire shape. */
function requestEnvelope(id: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    channel: DAPP_CHANNEL,
    direction: 'to-wallet',
    kind: 'request',
    id,
    payload,
  };
}

/**
 * A controllable `chrome.runtime` double exposing exactly the surface the relay
 * touches: `sendMessage` (content -> background) and an `onMessage` listener
 * registry (background -> content events). `emitFromBackground` plays the role
 * of the SW pushing an event/response down the runtime channel.
 */
function makeRuntime(): RelayRuntime & {
  sendMessage: ReturnType<typeof vi.fn>;
  emitFromBackground: (message: unknown) => void;
  listenerCount: () => number;
} {
  const listeners = new Set<(message: unknown) => void>();
  const sendMessage = vi.fn<(message: unknown) => Promise<unknown>>(() =>
    Promise.resolve(undefined),
  );
  return {
    sendMessage,
    onMessage: {
      addListener: (cb: (message: unknown) => void) => listeners.add(cb),
      removeListener: (cb: (message: unknown) => void) => listeners.delete(cb),
    },
    emitFromBackground: (message: unknown) => {
      for (const cb of listeners) cb(message);
    },
    listenerCount: () => listeners.size,
  };
}

function flushTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('content-script dApp relay', () => {
  let runtime: ReturnType<typeof makeRuntime>;
  let teardown: () => void;
  let postSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runtime = makeRuntime();
    postSpy = vi.spyOn(window, 'postMessage');
    teardown = installContentScriptRelay(window, runtime);
  });

  afterEach(() => {
    teardown();
    postSpy.mockRestore();
    vi.useRealTimers();
  });

  it('forwards a valid page request to chrome.runtime.sendMessage and posts the correlated response back (targetOrigin===origin)', async () => {
    runtime.sendMessage.mockResolvedValueOnce({
      id: 'req-1',
      method: 'kda_connect',
      status: 'success',
      accounts: ['k:abc'],
    });

    deliverFromPage(requestEnvelope('req-1', { method: 'kda_connect', networkId: 'stoa01' }));

    // The request crossed to the background exactly once, carrying the page payload.
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    const forwarded = runtime.sendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded.method).toBe('kda_connect');
    expect(forwarded.id).toBe('req-1');
    expect((forwarded as { networkId?: string }).networkId).toBe('stoa01');

    await flushTasks();

    // The correlated response was replayed page-ward as a 'to-page' response
    // envelope keyed by the same id, with an explicit same-origin targetOrigin.
    const responsePost = postSpy.mock.calls.find(
      ([msg]: unknown[]) => (msg as { kind?: string })?.kind === 'response',
    );
    expect(responsePost).toBeDefined();
    const envelope = responsePost?.[0] as {
      channel: string;
      direction: string;
      id: string;
      result: { status: string; accounts: string[] };
    };
    expect(envelope.channel).toBe(DAPP_CHANNEL);
    expect(envelope.direction).toBe('to-page');
    expect(envelope.id).toBe('req-1');
    expect(envelope.result.status).toBe('success');
    expect(envelope.result.accounts).toEqual(['k:abc']);
    expect(responsePost?.[1]).toBe(window.location.origin);
    expect(responsePost?.[1]).not.toBe('*');
  });

  it('IGNORES messages from a foreign source, a wrong origin, or without the channel marker', async () => {
    // Foreign source (e.g. a malicious iframe) — dropped before forwarding.
    deliverFromPage(requestEnvelope('f-1', { method: 'kda_connect' }), {
      source: {} as Window,
    });
    // Wrong origin — dropped.
    deliverFromPage(requestEnvelope('f-2', { method: 'kda_connect' }), {
      origin: 'https://evil.example',
    });
    // Right source/origin but NOT our channel — unrelated page chatter, dropped.
    deliverFromPage({ channel: 'some-other-lib', direction: 'to-wallet', id: 'f-3', payload: {} });
    // Right channel but wrong direction (a to-page echo, not a page request) — dropped.
    deliverFromPage({ channel: DAPP_CHANNEL, direction: 'to-page', kind: 'response', id: 'f-4' });
    // Non-object junk — dropped.
    deliverFromPage('not-an-envelope');

    await flushTasks();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('STRIPS a page-supplied origin so the page cannot smuggle a trusted-origin claim', async () => {
    // The page sets its OWN `origin` field on both the envelope and the inner
    // payload, attempting to assert a trusted origin. The relay must forward
    // NEITHER as a trusted origin — the background derives origin from the
    // chrome.runtime sender, not from page-controlled data.
    const malicious = {
      channel: DAPP_CHANNEL,
      direction: 'to-wallet',
      kind: 'request',
      id: 'm-1',
      origin: 'https://trusted-bank.example',
      payload: { method: 'kda_connect', origin: 'https://trusted-bank.example' },
    };
    deliverFromPage(malicious);

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    const forwarded = runtime.sendMessage.mock.calls[0][0] as Record<string, unknown>;
    const forwardedJson = JSON.stringify(forwarded);
    expect(forwardedJson).not.toContain('trusted-bank.example');
    expect(forwarded.origin).toBeUndefined();
    expect((forwarded as { payload?: { origin?: unknown } }).payload?.origin).toBeUndefined();
  });

  it('relays a background EVENT (accountsChanged) to the page as a to-page event envelope', () => {
    runtime.emitFromBackground({
      channel: DAPP_CHANNEL,
      direction: 'to-page',
      kind: 'event',
      event: 'accountsChanged',
      data: { accounts: ['k:new'] },
    });

    const eventPost = postSpy.mock.calls.find(
      ([msg]: unknown[]) => (msg as { kind?: string })?.kind === 'event',
    );
    expect(eventPost).toBeDefined();
    const envelope = eventPost?.[0] as {
      channel: string;
      direction: string;
      event: string;
      data: { accounts: string[] };
    };
    expect(envelope.channel).toBe(DAPP_CHANNEL);
    expect(envelope.direction).toBe('to-page');
    expect(envelope.event).toBe('accountsChanged');
    expect(envelope.data).toEqual({ accounts: ['k:new'] });
    // Page-ward post is same-origin targeted, never "*".
    expect(eventPost?.[1]).toBe(window.location.origin);
    expect(eventPost?.[1]).not.toBe('*');
  });

  it('surfaces a background sendMessage rejection to the page as a correlated fail (no thrown secret)', async () => {
    runtime.sendMessage.mockRejectedValueOnce(new Error('background unreachable'));

    deliverFromPage(requestEnvelope('e-1', { method: 'kda_connect' }));
    await flushTasks();

    const responsePost = postSpy.mock.calls.find(
      ([msg]: unknown[]) => (msg as { kind?: string })?.kind === 'response',
    );
    expect(responsePost).toBeDefined();
    const envelope = responsePost?.[0] as { id: string; result: { status: string; reason: string } };
    expect(envelope.id).toBe('e-1');
    expect(envelope.result.status).toBe('fail');
    expect(typeof envelope.result.reason).toBe('string');
  });

  it('correlates concurrent requests by id so responses do not cross', async () => {
    let resolveA!: (v: unknown) => void;
    let resolveB!: (v: unknown) => void;
    runtime.sendMessage
      .mockImplementationOnce(() => new Promise((r) => (resolveA = r)))
      .mockImplementationOnce(() => new Promise((r) => (resolveB = r)));

    deliverFromPage(requestEnvelope('A', { method: 'kda_getNetwork' }));
    deliverFromPage(requestEnvelope('B', { method: 'kda_checkStatus' }));
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);

    // Resolve out of order: B first, then A.
    resolveB({ id: 'B', method: 'kda_checkStatus', status: 'success', accounts: [] });
    resolveA({ id: 'A', method: 'kda_getNetwork', status: 'success', networkId: 'stoa01' });
    await flushTasks();

    type ResponsePost = { kind?: string; id?: string; result?: { networkId?: string } };
    const responses = postSpy.mock.calls
      .map(([msg]: unknown[]) => msg as ResponsePost)
      .filter((m: ResponsePost) => m?.kind === 'response');
    const byId = new Map<string | undefined, ResponsePost>(
      responses.map((r: ResponsePost) => [r.id, r]),
    );
    expect(byId.get('A')?.result?.networkId).toBe('stoa01');
    expect(byId.get('B')?.result?.networkId).toBeUndefined();
  });

  it('teardown detaches both the window listener and the runtime listener', async () => {
    expect(runtime.listenerCount()).toBe(1);
    teardown();
    expect(runtime.listenerCount()).toBe(0);

    runtime.sendMessage.mockClear();
    postSpy.mockClear();
    deliverFromPage(requestEnvelope('after', { method: 'kda_connect' }));
    runtime.emitFromBackground({
      channel: DAPP_CHANNEL,
      direction: 'to-page',
      kind: 'event',
      event: 'disconnect',
    });
    await flushTasks();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();

    // installContentScriptRelay's afterEach teardown is now a no-op double-call;
    // make it safe.
    teardown = () => {};
  });
});
