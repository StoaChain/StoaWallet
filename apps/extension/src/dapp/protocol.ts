/**
 * Typed dApp <-> wallet provider message protocol (Phase 9).
 *
 * A web page talks to the wallet over a THREE-HOP path:
 *
 *     inpage provider  ->  content script  ->  background service worker
 *                      <-                   <-
 *
 * Each hop re-emits the message across a different channel (`window.postMessage`
 * for inpage<->content, `chrome.runtime` for content<->background), and every
 * hop structured-clones the payload. This module pins the WIRE CONTRACT shared
 * by all three contexts as three discriminated unions — {@link DappRequest},
 * {@link DappResponse}, and {@link DappEvent} — plus the result helpers and
 * per-method request constructors that build and narrow them.
 *
 * The request/response shapes mirror the eckoWALLET provider API
 * (`window.kadena.request({ method: 'kda_*', ... })`) so existing Kadena dApps
 * work unchanged. Reference (the API SHAPE this models):
 * `kadena-stoic-legacy/src/client/signing/eckoWallet/{eckoCommon,
 * quicksignWithEckoWallet,signWithEckoWallet}.cjs`.
 *
 * INVARIANTS (load-bearing):
 *
 *   - REQUEST-ID CORRELATION: every request carries a unique `id`. Because the
 *     path is async across three contexts, the background echoes the SAME `id`
 *     on its {@link DappResponse} so the inpage provider can resolve the right
 *     pending promise. `id` is the correlation key, not a security token.
 *
 *   - BACKGROUND-FILLED ORIGIN: the trusted `origin` is stamped by the
 *     BACKGROUND from the verified `chrome.runtime` sender (`sender.origin` /
 *     `sender.url`), NEVER by the page. The page/inpage/content-script are not
 *     the origin authority — any `origin` a page puts in its payload is
 *     untrusted and is OVERWRITTEN by {@link stampOrigin}. The page-message
 *     constructors below deliberately leave `origin` unset.
 *
 *   - eckoWALLET RESPONSE SHAPE: success/failure travel as
 *     `{ status: 'success', ... }` / `{ status: 'fail', reason }` — never a
 *     thrown secret-bearing `Error`. Failures are plain string `reason`s.
 *
 *   - SECRET-FREE BOUNDARY: NO request, response, or event variant may carry a
 *     `mnemonic`, `privateKey`, or `secretKey`. Requests carry UNSIGNED public
 *     material (the `cmd` string + empty `sig` slots); responses carry the
 *     SIGNED public artifact (filled `sig`s). The wallet resolves and consumes
 *     key material entirely on the background side. {@link
 *     DappMessageHasNoSecretField} makes a regression a compile error.
 *
 *   - JSON-serializable only: both channels structured-clone messages, so every
 *     field is plain data (no functions, Errors, or class instances).
 */

/**
 * Channel marker stamped on every dApp protocol message. The content script and
 * inpage provider filter `window.postMessage` traffic on this constant so the
 * wallet ignores unrelated page messages (and vice-versa). Consumed by the
 * transport layer (T9.3/T9.5).
 */
export const DAPP_CHANNEL = 'stoa-wallet/dapp' as const;

// --- shared wire shapes ----------------------------------------------------

/** A single signature slot on a command: a pubkey with its (maybe-empty) sig. */
export interface DappSig {
  readonly pubKey: string;
  readonly sig: string | null;
}

/**
 * A dApp-supplied SigData envelope: the stringified `cmd` to sign plus the
 * signature slots. In a REQUEST the `sig`s are empty (`null`) for the pubkeys
 * the wallet controls; in a RESPONSE they are filled. Plain, public data.
 */
export interface CommandSigData {
  readonly cmd: string;
  readonly sigs: readonly DappSig[];
}

/** The eckoWALLET `kda_requestSign` signing-request envelope. */
export interface SigningCmd {
  readonly cmd: string;
  readonly sigs?: readonly DappSig[];
}

// --- REQUEST union ---------------------------------------------------------

/**
 * The discriminant `method` literals of every {@link DappRequest} arm — the
 * eckoWALLET provider method names. `kda_requestQuickSign` is the canonical
 * signing method; `kda_requestSign` is the legacy single-sign path.
 */
export type DappMethod =
  | 'kda_connect'
  | 'kda_checkStatus'
  | 'kda_disconnect'
  | 'kda_requestSign'
  | 'kda_requestQuickSign'
  | 'kda_getNetwork';

/**
 * Fields shared by every request as it leaves the page: the {@link DappMethod}
 * discriminant and the correlation {@link id}. NOTE: NO `origin` — the page is
 * not the origin authority; the background stamps it via {@link stampOrigin}.
 */
interface BaseRequest<M extends DappMethod> {
  readonly method: M;
  /** Correlation id echoed back on the response; unique per in-flight request. */
  readonly id: string;
}

/** `kda_connect` — request the wallet expose account(s) to this origin. */
export interface ConnectRequest extends BaseRequest<'kda_connect'> {
  readonly networkId: string;
}

/** `kda_checkStatus` — is this origin already connected? (isConnected). */
export interface CheckStatusRequest extends BaseRequest<'kda_checkStatus'> {
  readonly networkId: string;
}

/** `kda_disconnect` — revoke this origin's connection. */
export type DisconnectRequest = BaseRequest<'kda_disconnect'>;

/** `kda_getNetwork` — read the wallet's active networkId. */
export type GetNetworkRequest = BaseRequest<'kda_getNetwork'>;

/**
 * `kda_requestQuickSign` (CANONICAL) — fill the empty `sig` slots on one or more
 * {@link CommandSigData} envelopes. The request carries UNSIGNED public material
 * only.
 */
export interface QuickSignRequest extends BaseRequest<'kda_requestQuickSign'> {
  readonly data: {
    readonly networkId: string;
    readonly commandSigDatas: readonly CommandSigData[];
  };
}

/**
 * `kda_requestSign` (legacy single-sign) — sign one signing-request command.
 * Supported for eckoWALLET parity; prefer {@link QuickSignRequest}.
 */
export interface SignRequest extends BaseRequest<'kda_requestSign'> {
  readonly data: {
    readonly networkId: string;
    readonly signingCmd: SigningCmd;
  };
}

/** REQUEST union: every message a page sends, keyed on `method`. */
export type DappRequest =
  | ConnectRequest
  | CheckStatusRequest
  | DisconnectRequest
  | GetNetworkRequest
  | QuickSignRequest
  | SignRequest;

/**
 * A request after the background has stamped the verified origin. Carries the
 * SAME shape plus a trusted `origin` the page could not forge.
 */
export type StampedRequest<R extends DappRequest = DappRequest> = R & {
  readonly origin: string;
};

// --- RESPONSE union (eckoWALLET shape) -------------------------------------

/**
 * The eckoWALLET-style failure reasons. NEVER a thrown secret-bearing Error —
 * failures travel as a plain `reason` string the page can branch on.
 */
export type DappFailReason =
  | 'user-rejected'
  | 'not-connected'
  | 'origin-not-allowed'
  | 'rate-limited'
  | 'locked'
  | 'invalid-request';

/** A public account string the wallet exposes to a connected origin (`k:...`). */
export type DappAccount = string;

/** A single signed command in a {@link QuickSignResponse}. */
export interface QuickSignedCommand {
  readonly commandSigData: CommandSigData;
  readonly outcome:
    | { readonly result: 'success'; readonly hash: string }
    | { readonly result: 'failure'; readonly msg?: string };
}

/** The discriminated failure arm shared by every response, correlated by `id`. */
export interface DappFail {
  readonly id: string;
  readonly method: DappMethod;
  readonly status: 'fail';
  readonly reason: DappFailReason;
}

/** `kda_connect` success: the account(s) granted to this origin. */
export interface ConnectResponse {
  readonly id: string;
  readonly method: 'kda_connect';
  readonly status: 'success';
  readonly accounts: readonly DappAccount[];
}

/** `kda_checkStatus` success: whether connected, and the account(s) if so. */
export interface CheckStatusResponse {
  readonly id: string;
  readonly method: 'kda_checkStatus';
  readonly status: 'success';
  readonly accounts?: readonly DappAccount[];
}

/** `kda_disconnect` success: an empty acknowledgement. */
export interface DisconnectResponse {
  readonly id: string;
  readonly method: 'kda_disconnect';
  readonly status: 'success';
}

/** `kda_getNetwork` success: the StoaChain `networkId` (the KADENA_NETWORK constant). */
export interface GetNetworkResponse {
  readonly id: string;
  readonly method: 'kda_getNetwork';
  readonly status: 'success';
  readonly networkId: string;
}

/**
 * `kda_requestQuickSign` success (CANONICAL shape): an array of signed commands,
 * each pairing the filled {@link CommandSigData} with its `outcome`. Distinct
 * from {@link DappFail} — success carries `responses`, failure carries `reason`.
 */
export interface QuickSignSuccess {
  readonly id: string;
  readonly method: 'kda_requestQuickSign';
  readonly status: 'success';
  readonly responses: readonly QuickSignedCommand[];
}

/** `kda_requestSign` success: the single signed command (public artifact). */
export interface SignSuccess {
  readonly id: string;
  readonly method: 'kda_requestSign';
  readonly status: 'success';
  readonly signedCmd: CommandSigData;
}

/** Per-method response: the success arm OR a correlated {@link DappFail}. */
export type ConnectResponseT = ConnectResponse | DappFail;
export type CheckStatusResponseT = CheckStatusResponse | DappFail;
export type DisconnectResponseT = DisconnectResponse | DappFail;
export type GetNetworkResponseT = GetNetworkResponse | DappFail;
export type QuickSignResponse = QuickSignSuccess | DappFail;
export type SignResponse = SignSuccess | DappFail;

/** RESPONSE union: every message the background returns, correlated by `id`. */
export type DappResponse =
  | ConnectResponse
  | CheckStatusResponse
  | DisconnectResponse
  | GetNetworkResponse
  | QuickSignSuccess
  | SignSuccess
  | DappFail;

/** Maps a request `method` to the response union the background returns for it. */
export type DappResponseFor<M extends DappMethod> = M extends 'kda_connect'
  ? ConnectResponseT
  : M extends 'kda_checkStatus'
    ? CheckStatusResponseT
    : M extends 'kda_disconnect'
      ? DisconnectResponseT
      : M extends 'kda_getNetwork'
        ? GetNetworkResponseT
        : M extends 'kda_requestQuickSign'
          ? QuickSignResponse
          : M extends 'kda_requestSign'
            ? SignResponse
            : never;

/** The success payload for a method, minus the `id`/`method`/`status` envelope. */
type SuccessPayload<M extends DappMethod> = Omit<
  Extract<DappResponseFor<M>, { status: 'success' }>,
  'id' | 'method' | 'status'
>;

// --- EVENT union (EIP-1193-like background push) ---------------------------

/**
 * EVENT union: unsolicited pushes the background sends a connected page,
 * EIP-1193-style. Events carry ONLY public data — no key material, no `id`
 * (they are not request replies).
 *   - `accountsChanged` — the exposed account set changed (e.g. active-account
 *     switch); carries the public `k:` account string(s).
 *   - `disconnect`      — the wallet revoked this origin's connection.
 */
export type DappEvent =
  | { readonly event: 'accountsChanged'; readonly accounts: readonly DappAccount[] }
  | { readonly event: 'disconnect' };

// --- SECRET-FREE BOUNDARY (compile-time guard) -----------------------------

/** The field names that must NEVER appear on any protocol message. */
type SecretKeyName = 'mnemonic' | 'privateKey' | 'secretKey';

/**
 * `T` if it has NO secret field, else `never`. Distributes over unions so each
 * arm is checked independently. Any arm carrying a secret field collapses to
 * `never` — the building block of the guard below.
 */
export type NoSecretFields<T> = T extends unknown
  ? Extract<keyof T, SecretKeyName> extends never
    ? T
    : never
  : never;

/**
 * `true` iff EVERY arm of the message union `M` is secret-free. If any arm
 * carries a secret field, `NoSecretFields<M>` drops it, the unions differ, and
 * this resolves to `false` — a compile-time tripwire asserted in the suite.
 */
export type DappMessageHasNoSecretField<M> = [NoSecretFields<M>] extends [M]
  ? [M] extends [NoSecretFields<M>]
    ? true
    : false
  : false;

// Statically-evaluated assertions: if a future edit adds a secret-bearing arm
// to any of the three unions, these assignments stop being `true` and the
// package fails to type-check.
const _requestSecretFree: DappMessageHasNoSecretField<DappRequest> = true;
const _responseSecretFree: DappMessageHasNoSecretField<DappResponse> = true;
const _eventSecretFree: DappMessageHasNoSecretField<DappEvent> = true;
void _requestSecretFree;
void _responseSecretFree;
void _eventSecretFree;

// --- request constructors (page side) --------------------------------------
//
// These build the page-side message. They deliberately set NO `origin`: the
// page is not the origin authority. The background stamps the verified origin
// via stampOrigin() once the message crosses chrome.runtime.

/** Build a `kda_connect` request correlated by `id`. */
export function makeConnectRequest(id: string, networkId: string): ConnectRequest {
  return { method: 'kda_connect', id, networkId };
}

/** Build a `kda_checkStatus` (isConnected) request correlated by `id`. */
export function makeCheckStatusRequest(id: string, networkId: string): CheckStatusRequest {
  return { method: 'kda_checkStatus', id, networkId };
}

/** Build a `kda_disconnect` request correlated by `id`. */
export function makeDisconnectRequest(id: string): DisconnectRequest {
  return { method: 'kda_disconnect', id };
}

/** Build a `kda_getNetwork` request correlated by `id`. */
export function makeGetNetworkRequest(id: string): GetNetworkRequest {
  return { method: 'kda_getNetwork', id };
}

/** Build a canonical `kda_requestQuickSign` request correlated by `id`. */
export function makeQuickSignRequest(
  id: string,
  networkId: string,
  commandSigDatas: readonly CommandSigData[],
): QuickSignRequest {
  return { method: 'kda_requestQuickSign', id, data: { networkId, commandSigDatas } };
}

/** Build a legacy `kda_requestSign` request correlated by `id`. */
export function makeSignRequest(id: string, networkId: string, signingCmd: SigningCmd): SignRequest {
  return { method: 'kda_requestSign', id, data: { networkId, signingCmd } };
}

/**
 * Stamp the VERIFIED origin onto a page request. The background calls this with
 * the origin read from the trusted `chrome.runtime` sender — NOT from the page
 * payload. Any `origin` the page smuggled in is overwritten. Returns a new
 * object; never mutates the page message in place.
 */
export function stampOrigin<R extends DappRequest>(req: R, verifiedOrigin: string): StampedRequest<R> {
  return { ...req, origin: verifiedOrigin };
}

// --- response helpers (background side) ------------------------------------

/**
 * Build a correlated success response for `method`, spreading the method's
 * success payload onto the `{id, method, status:'success'}` envelope. The page
 * narrows on `res.status === 'success'` to reach the payload.
 */
export function dappOk<M extends DappMethod>(
  id: string,
  method: M,
  payload: SuccessPayload<M>,
): Extract<DappResponseFor<M>, { status: 'success' }> {
  return { id, method, status: 'success', ...payload } as Extract<
    DappResponseFor<M>,
    { status: 'success' }
  >;
}

/** Build a correlated `{status:'fail', reason}` response. Never throws a secret. */
export function dappFail(id: string, method: DappMethod, reason: DappFailReason): DappFail {
  return { id, method, status: 'fail', reason };
}

/** Narrow a response to its success arm on the `status` discriminant. */
export function isDappOk<R extends { status: string }>(
  res: R,
): res is Extract<R, { status: 'success' }> {
  return res.status === 'success';
}
