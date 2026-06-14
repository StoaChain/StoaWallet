/**
 * The ISOLATED-world content script — the page <-> background relay gateway, and
 * the HIGHEST-RISK trust boundary of the wallet's dApp surface.
 *
 * TWO scripts cooperate to bridge a web page to the wallet's background service
 * worker (the SW is the ONLY origin authority; RR#8: there is no
 * `externally_connectable`, so a page reaches the SW ONLY through this hop):
 *
 *   1. The inpage provider (T9.3 `inpage.ts`) runs in the page's MAIN world so
 *      `window.stoa` is defined in the page's own JS context. It has NO access to
 *      `chrome.*`. It speaks to the wallet purely via `window.postMessage`.
 *
 *   2. THIS file runs in the ISOLATED world (it has `chrome.runtime`; the MAIN
 *      world does not). It is a PURE RELAY: it forwards the page's requests to
 *      the background over `chrome.runtime.sendMessage` and replays the
 *      correlated responses + unsolicited events back to the page over
 *      `window.postMessage`. It holds NO key material and makes NO
 *      signing/permission/trust decisions — those live entirely in the background
 *      (T9.6), which derives the trusted origin from the verified runtime sender.
 *
 * INJECTION MECHANISM (T9.8 manifest wiring — RR#4):
 *   The MAIN-world provider is delivered by a SEPARATE `world:"MAIN"` content
 *   script (`inpageEntry.ts`), registered in the manifest at
 *   `run_at:"document_start"` (RR#5). Chrome injects `window.stoa` directly into
 *   the page's JS context, so there is NO `<script src=...>` injection from this
 *   relay and NO `web_accessible_resources` entry for the inpage bundle — that
 *   removes the page-observable extension fingerprint the old `<script>` approach
 *   exposed. `world:"MAIN"` needs Chrome 111+, which is the wallet's pinned
 *   target. THIS file installs only the ISOLATED-world relay below.
 *
 * SECURITY BOUNDARY (load-bearing):
 *   - RR#3 inbound hardening: a page message is only forwarded when
 *     `event.source === window` AND `event.origin === window.location.origin` AND
 *     it carries the shared {@link DAPP_CHANNEL} marker with `direction:'to-wallet'`.
 *     The marker is a FILTER; source + origin are the boundary. Foreign-frame,
 *     wrong-origin, and unrelated messages are dropped before forwarding.
 *   - RR#3 outbound: every page-ward `window.postMessage` uses an explicit
 *     `targetOrigin === window.location.origin`, NEVER "*".
 *   - NO TRUSTED-ORIGIN SMUGGLING (the core boundary): the page does not get to
 *     assert its own origin. Any `origin` field the page set — on the envelope OR
 *     inside the inner payload — is STRIPPED before the request is forwarded. The
 *     background stamps the trusted origin from the runtime sender (T9.1
 *     `stampOrigin`), not from page-controlled data.
 *   - Correlation by `id` keeps concurrent requests from crossing. Errors cross
 *     as `{ status: 'fail', reason }` — never a thrown secret-bearing Error.
 *   - `chrome.runtime` is NEVER exposed to the page; no payloads are console.*'d.
 */

import { DAPP_CHANNEL } from './protocol';

/**
 * The minimal `chrome.runtime` surface the relay touches — injectable so the
 * relay logic is exercised against a double in tests without a real `chrome.*`.
 */
export interface RelayRuntime {
  sendMessage(message: unknown): Promise<unknown>;
  readonly onMessage: {
    addListener(callback: (message: unknown) => void): void;
    removeListener(callback: (message: unknown) => void): void;
  };
}

/** A page-side REQUEST envelope as posted by the inpage provider. */
interface RequestEnvelope {
  readonly channel: typeof DAPP_CHANNEL;
  readonly direction: 'to-wallet';
  readonly kind: 'request';
  readonly id: string;
  readonly payload: Record<string, unknown>;
}

/** A correlated RESPONSE envelope the relay replays into the page world. */
interface ResponseEnvelope {
  readonly channel: typeof DAPP_CHANNEL;
  readonly direction: 'to-page';
  readonly kind: 'response';
  readonly id: string;
  readonly result: unknown;
}

/** An unsolicited EVENT envelope (accountsChanged / disconnect) for the page. */
interface EventEnvelope {
  readonly channel: typeof DAPP_CHANNEL;
  readonly direction: 'to-page';
  readonly kind: 'event';
  readonly event: string;
  readonly data?: unknown;
}

/**
 * Narrow an inbound page message to a valid page REQUEST envelope. Validates the
 * shared channel marker, the `to-wallet` direction, and the presence of a string
 * `id` + an object `payload`. The caller has ALREADY verified `event.source` and
 * `event.origin` (the security boundary); this is the structural filter on top.
 */
function isRequestEnvelope(data: unknown): data is RequestEnvelope {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.channel === DAPP_CHANNEL &&
    d.direction === 'to-wallet' &&
    d.kind === 'request' &&
    typeof d.id === 'string' &&
    typeof d.payload === 'object' &&
    d.payload !== null
  );
}

/** Is this background-pushed message a page-bound EVENT envelope to relay? */
function isEventEnvelope(data: unknown): data is EventEnvelope {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.channel === DAPP_CHANNEL &&
    d.direction === 'to-page' &&
    d.kind === 'event' &&
    typeof d.event === 'string'
  );
}

/**
 * Build the message forwarded to the background from a page request, STRIPPING
 * any page-supplied trusted-origin claim. The page does not get to assert its
 * origin: any `origin` it placed on the envelope OR inside the payload is dropped
 * here so the background can stamp the origin from the verified runtime sender
 * instead. Returns a fresh object carrying only `{ id, ...sanitizedPayload }`.
 */
function buildForwardMessage(envelope: RequestEnvelope): Record<string, unknown> {
  const { origin: _droppedPayloadOrigin, ...payload } = envelope.payload;
  void _droppedPayloadOrigin;
  // No `origin` from the envelope is propagated either: only id + payload cross.
  return { id: envelope.id, ...payload };
}

/**
 * Install the page<->background relay in the ISOLATED-world content script.
 * Returns a teardown that detaches both the page (`window.message`) and the
 * background (`runtime.onMessage`) listeners.
 */
export function installContentScriptRelay(scope: Window, runtime: RelayRuntime): () => void {
  const origin = scope.location.origin;

  function postToPage(envelope: ResponseEnvelope | EventEnvelope): void {
    // RR#3: explicit same-origin targetOrigin — never "*".
    scope.postMessage(envelope, origin);
  }

  function onPageMessage(event: MessageEvent): void {
    // SECURITY BOUNDARY (RR#3): only relay messages this window posted to itself,
    // from our own origin. A foreign frame's `source`, or a cross-origin message,
    // is dropped before the payload is even inspected. The channel marker checked
    // in isRequestEnvelope is a convenience filter layered on top, not the boundary.
    if (event.source !== scope) return;
    if (event.origin !== origin) return;
    if (!isRequestEnvelope(event.data)) return;

    const id = event.data.id;
    const forwarded = buildForwardMessage(event.data);

    runtime.sendMessage(forwarded).then(
      (result) => {
        postToPage({
          channel: DAPP_CHANNEL,
          direction: 'to-page',
          kind: 'response',
          id,
          result,
        });
      },
      () => {
        // Errors cross as a plain `{status:'fail', reason}` — never a thrown
        // secret-bearing Error, and the underlying message is not surfaced.
        postToPage({
          channel: DAPP_CHANNEL,
          direction: 'to-page',
          kind: 'response',
          id,
          result: { status: 'fail', reason: 'relay-error' },
        });
      },
    );
  }

  function onBackgroundMessage(message: unknown): void {
    // Relay only well-formed page-bound events; ignore everything else the
    // background may emit on the runtime channel.
    if (isEventEnvelope(message)) {
      postToPage(message);
    }
  }

  scope.addEventListener('message', onPageMessage);
  runtime.onMessage.addListener(onBackgroundMessage);

  return function teardown(): void {
    scope.removeEventListener('message', onPageMessage);
    runtime.onMessage.removeListener(onBackgroundMessage);
  };
}
