/**
 * The page-world `window.stoa` provider — the HIGHEST-RISK surface of the wallet.
 *
 * This script runs in the UNTRUSTED main world of every web page (the same world
 * as arbitrary dApp / attacker JavaScript). It therefore holds NO key material of
 * any kind: it is a pure message broker that posts public method requests toward
 * the wallet (via the isolated-world content script that injects it) and resolves
 * promises with the public results the wallet returns. All key derivation, signing,
 * and secret storage live ONLY in the background service worker; nothing secret
 * ever crosses into this file's scope.
 *
 * API SHAPE (eckoWALLET-style, mirroring `window.kadena`):
 *   window.stoa = {
 *     isStoa: true,                              // feature-detection flag
 *     request({ method, ...data }): Promise<res>,// correlated request/response
 *     on(event, handler),                        // 'accountsChanged' | 'disconnect'
 *     removeListener(event, handler),
 *   }
 *
 * TRANSPORT & HARDENING:
 *   - Each request() mints a unique id and posts a {@link StoaRequestEnvelope}
 *     over window.postMessage with targetOrigin === window.location.origin
 *     (RR#3: NEVER "*"). The returned promise is parked in an id-keyed pending
 *     map and resolved when the correlated {@link StoaResponseEnvelope} arrives.
 *   - Inbound messages are validated BEFORE processing: event.source must be this
 *     window AND event.origin must equal window.location.origin AND the shared
 *     {@link STOA_DAPP_CHANNEL} marker + 'to-page' direction must match. The
 *     marker is a convenience filter; source+origin are the security boundary.
 *   - RR#14: every pending request arms a timeout that rejects + evicts its entry
 *     if no correlated reply lands (no hung promises, no unbounded map growth). An
 *     inbound `disconnect` event rejects ALL in-flight requests.
 *
 * The provider surfaces a wallet `{ status: 'fail' }` result AS-IS (eckoWALLET
 * convention) — it never fabricates a success — and never console.* logs payloads.
 */

import { DAPP_CHANNEL } from './protocol';

/**
 * Shared channel marker stamped on every dApp-bridge envelope so a page's own
 * postMessage traffic is trivially filtered out. This is a convenience FILTER,
 * not the security boundary (source + origin are). It is the SINGLE shared
 * marker {@link DAPP_CHANNEL} from the protocol module, re-exported under the
 * provider-local name so the inpage provider and the isolated-world content
 * script (T9.5) agree on ONE channel + envelope shape.
 */
export const STOA_DAPP_CHANNEL = DAPP_CHANNEL;

/** Public dApp method names the provider relays (eckoWALLET-compatible set). */
export type StoaRequestPayload = {
  readonly method: string;
  readonly [key: string]: unknown;
};

/** Envelope the provider posts toward the wallet (isolated-world content script). */
export interface StoaRequestEnvelope {
  readonly channel: typeof STOA_DAPP_CHANNEL;
  readonly direction: 'to-wallet';
  readonly kind: 'request';
  readonly id: string;
  readonly payload: StoaRequestPayload;
}

/** Correlated response the content script replays back into the page world. */
export interface StoaResponseEnvelope {
  readonly channel: typeof STOA_DAPP_CHANNEL;
  readonly direction: 'to-page';
  readonly kind: 'response';
  readonly id: string;
  readonly result: unknown;
}

/** Wallet-pushed event names a dApp may subscribe to. */
export type StoaEventName = 'accountsChanged' | 'disconnect';

/** An unsolicited event the wallet pushes (account switch, disconnect/lock). */
export interface StoaEventEnvelope {
  readonly channel: typeof STOA_DAPP_CHANNEL;
  readonly direction: 'to-page';
  readonly kind: 'event';
  readonly event: StoaEventName;
  readonly data: unknown;
}

/** A handler the dApp registers via {@link StoaProvider.on}. */
export type StoaEventHandler = (data: unknown) => void;

/** Per-request options; `timeoutMs` overrides the default RR#14 deadline. */
export interface StoaRequestOptions {
  readonly timeoutMs?: number;
}

/** The object installed as `window.stoa`. */
export interface StoaProvider {
  readonly isStoa: true;
  request(payload: StoaRequestPayload, options?: StoaRequestOptions): Promise<unknown>;
  on(event: StoaEventName, handler: StoaEventHandler): void;
  removeListener(event: StoaEventName, handler: StoaEventHandler): void;
}

/** Default time a request waits for its correlated reply before rejecting. */
const DEFAULT_TIMEOUT_MS = 60_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Generate a collision-resistant request id. Prefers crypto.randomUUID where the
 * page world exposes it; falls back to a random+counter token otherwise. The id
 * is only a correlation key (not a secret), so a non-crypto fallback is safe.
 */
function makeRequestId(scope: Window): string {
  const cryptoObj = (scope as Window & { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `stoa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isResponseEnvelope(data: unknown): data is StoaResponseEnvelope {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.channel === STOA_DAPP_CHANNEL &&
    d.direction === 'to-page' &&
    d.kind === 'response' &&
    typeof d.id === 'string'
  );
}

function isEventEnvelope(data: unknown): data is StoaEventEnvelope {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.channel === STOA_DAPP_CHANNEL &&
    d.direction === 'to-page' &&
    d.kind === 'event' &&
    (d.event === 'accountsChanged' || d.event === 'disconnect')
  );
}

/**
 * Build a `window.stoa` provider bound to `scope` and install it. Returns the
 * provider plus an `uninstall` that detaches the message listener and rejects any
 * still-pending requests — used by tests and by a teardown path. The T9.5 content
 * script is responsible for calling this in the page world; this function holds
 * no chrome.* surface so it is safe to run in the untrusted main world.
 */
export function installStoaProvider(scope: Window): {
  provider: StoaProvider;
  uninstall: () => void;
} {
  const pending = new Map<string, PendingRequest>();
  const listeners: Record<StoaEventName, Set<StoaEventHandler>> = {
    accountsChanged: new Set(),
    disconnect: new Set(),
  };

  const origin = scope.location.origin;

  function settle(id: string, settler: (entry: PendingRequest) => void): void {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    settler(entry);
  }

  function rejectAll(error: Error): void {
    for (const [id] of pending) {
      settle(id, (entry) => entry.reject(error));
    }
  }

  function onMessage(event: MessageEvent): void {
    // SECURITY BOUNDARY (RR#3): only trust messages this very window posted to
    // itself, from our own origin. A foreign frame's `source`, or a message from
    // a different origin, is dropped before any payload is inspected. The channel
    // marker below is a convenience filter layered on top, not the boundary.
    if (event.source !== scope) return;
    if (event.origin !== origin) return;

    const { data } = event;
    if (isResponseEnvelope(data)) {
      settle(data.id, (entry) => entry.resolve(data.result));
      return;
    }
    if (isEventEnvelope(data)) {
      if (data.event === 'disconnect') {
        rejectAll(new Error('stoa: wallet disconnect — in-flight requests cancelled'));
      }
      for (const handler of listeners[data.event]) {
        handler(data.data);
      }
    }
  }

  scope.addEventListener('message', onMessage);

  const provider: StoaProvider = {
    isStoa: true,
    request(payload: StoaRequestPayload, options?: StoaRequestOptions): Promise<unknown> {
      const id = makeRequestId(scope);
      const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(id, (entry) =>
            entry.reject(new Error(`stoa: request "${payload.method}" timeout after ${timeoutMs}ms`)),
          );
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });

        const envelope: StoaRequestEnvelope = {
          channel: STOA_DAPP_CHANNEL,
          direction: 'to-wallet',
          kind: 'request',
          id,
          payload,
        };
        // RR#3: explicit same-origin targetOrigin — never "*".
        scope.postMessage(envelope, origin);
      });
    },
    on(event: StoaEventName, handler: StoaEventHandler): void {
      listeners[event].add(handler);
    },
    removeListener(event: StoaEventName, handler: StoaEventHandler): void {
      listeners[event].delete(handler);
    },
  };

  function uninstall(): void {
    scope.removeEventListener('message', onMessage);
    rejectAll(new Error('stoa: provider uninstalled — in-flight requests cancelled'));
  }

  return { provider, uninstall };
}
