/**
 * Typed popup -> background message protocol for the MV3 wallet.
 *
 * The popup is a thin view; every operation that touches the keyring (unlock,
 * lock, add account, sign) is delegated to the background service worker over
 * `chrome.runtime` message passing. This module pins the WIRE CONTRACT between
 * the two contexts as two discriminated unions — {@link Request} and
 * {@link Response} — plus the result helpers that build/narrow them.
 *
 * INVARIANTS (load-bearing):
 *   - SECRET-FREE BOUNDARY: NO response variant may carry a `mnemonic`,
 *     `privateKey`, `secretKey`, or `password` field. The {@link signTx}
 *     response returns ONLY the signed (public) transaction; the background
 *     resolves and consumes key material entirely on its side. The
 *     {@link ResponseHasNoSecretField} type-level guard makes a regression a
 *     compile error.
 *   - The `unlock` REQUEST carries the password transiently (popup -> background
 *     only); no response echoes it back.
 *   - SIGNER-SET-AWARE signing: the popup sends a {@link SignerSpec} describing
 *     WHAT to sign with (active account / advanced address / chain-0 gas-station
 *     co-signer / dApp commandSigDatas), never raw keys. The background resolves
 *     the actual keypair set from the spec.
 *   - JSON-serializable only: chrome.runtime structured-clones messages, so
 *     every field is plain data (no functions, Errors, or class instances) and
 *     failures travel as `reason` string literals.
 */

/**
 * A Pact command as it crosses the wire: the canonical stringified `cmd`
 * payload and its blake2b `hash`, optionally with attached signatures once
 * signed. A structural, JSON-safe view of the SDK's `IUnsignedCommand`/
 * `ICommand` so the protocol stays decoupled from node-only SDK types.
 */
export interface WireCommand {
  readonly cmd: string;
  readonly hash: string;
  readonly sigs?: readonly (WireSig | null)[];
}

/** A single signature slot on a command: a pubkey with its (maybe-empty) sig. */
export interface WireSig {
  readonly pubKey?: string;
  readonly sig: string | null;
}

/**
 * A dApp-supplied SigData envelope (Phase 9): the command to sign plus the
 * signature slots to fill. Plain data — the background fills the empty `sig`
 * slots for the pubkeys the wallet controls.
 */
export interface WireSigData {
  readonly cmd: string;
  readonly sigs: readonly WireSig[];
}

/**
 * SIGNER SPEC (XP-12): tells the background WHICH keypair set to resolve for a
 * {@link SignTxRequest}, WITHOUT the popup ever sending key material. A closed
 * discriminated union keyed on `kind`, so the background resolves on an
 * exhaustive switch:
 *   - `active`          — the active account's derived keypair.
 *   - `advanced`        — resolve the guard-satisfying set for a non-seed
 *                         account by its on-chain `address` (Phase 4/5).
 *   - `gas-station`     — add the chain-0 gas-station co-signer (Phase 11).
 *   - `commandSigDatas` — fill the dApp-supplied SigData slots (Phase 9).
 *
 * Extensible: the UrStoa dual-cap active-key signer (Phase 12) is carried by the
 * `active` variant's optional `cap` selector; new variants append a `kind`.
 */
export type SignerSpec =
  | { readonly kind: 'active'; readonly cap?: string }
  | { readonly kind: 'advanced'; readonly address: string }
  | { readonly kind: 'gas-station'; readonly chainId: string }
  | { readonly kind: 'commandSigDatas'; readonly sigData: WireSigData };

/**
 * Sign an unsigned transaction in the background.
 *
 * Beyond the `{tx, accountIndex}` core, it carries the {@link SignerSpec} (WHAT
 * to sign with) and an optional single-use `approvalToken` (XP-3) that Phase 9
 * validates before honoring a dApp signing request. The RESPONSE returns only
 * the signed transaction (see {@link SignTxResponse}).
 */
export interface SignTxRequest {
  readonly type: 'signTx';
  readonly tx: WireCommand;
  readonly accountIndex: number;
  readonly signerSpec: SignerSpec;
  /** Single-use approval token minted by the approval flow; Phase 9 validates it. */
  readonly approvalToken?: string;
}

/**
 * UrStoa-op PUBLIC params (XP-12): the popup sends ONLY these — never a keypair.
 * stake/unstake carry the active payment-key ADDRESS + a pre-formatted decimal
 * amount; collect carries only the address; transfer carries sender/receiver +
 * amount. The background resolves the active account's keypair from its in-memory
 * KeyVault (the SAME path `signTx` uses) and runs the core wrapper there.
 */
export interface UrStoaStakeOpParams {
  readonly paymentKeyAddress: string;
  readonly amount: string;
}
export interface UrStoaCollectOpParams {
  readonly paymentKeyAddress: string;
}
export interface UrStoaTransferOpParams {
  readonly senderAddress: string;
  readonly receiverAddress: string;
  readonly amount: string;
}

/**
 * Run a full UrStoa write op (build+sign+submit) in the BACKGROUND. The SDK
 * `execute*UrStoa` executors bundle build+sign+submit around a LITERAL keypair —
 * there is no `signTransaction` seam to route a single signature through — so the
 * WHOLE op must run where the unlocked key lives (the worker). The popup sends the
 * `op` discriminant + PUBLIC params; the background resolves the active keypair and
 * returns ONLY the discriminated result (a requestKey or a reason). No key crosses
 * back. A closed union on `op` so the background resolves on an exhaustive switch.
 */
export type UrStoaOpRequest =
  | { readonly type: 'urstoaOp'; readonly op: 'stake'; readonly params: UrStoaStakeOpParams }
  | { readonly type: 'urstoaOp'; readonly op: 'unstake'; readonly params: UrStoaStakeOpParams }
  | { readonly type: 'urstoaOp'; readonly op: 'collect'; readonly params: UrStoaCollectOpParams }
  | { readonly type: 'urstoaOp'; readonly op: 'transfer'; readonly params: UrStoaTransferOpParams };

/**
 * REQUEST union: every message the popup sends the background. Each arm is
 * discriminated on `type` so the background switches exhaustively.
 */
export type Request =
  | { readonly type: 'isUnlocked' }
  | { readonly type: 'unlock'; readonly walletId: string; readonly password: string }
  | { readonly type: 'lock' }
  | { readonly type: 'addAccount'; readonly walletId: string }
  | { readonly type: 'setActiveAccount'; readonly walletId: string; readonly index: number }
  | { readonly type: 'getActiveAccount' }
  | { readonly type: 'listAccounts' }
  // Auto-lock session: a READ-ONLY status query (no re-arm) and the duration setter.
  | { readonly type: 'getSession' }
  | { readonly type: 'setAutoLock'; readonly minutes: number }
  // Advanced / Codex (multi-seed) management.
  | { readonly type: 'listWallets' }
  | { readonly type: 'listPureKeypairs' }
  | { readonly type: 'setActiveWallet'; readonly walletId: string }
  | { readonly type: 'addAccountAtIndex'; readonly walletId: string; readonly index: number }
  | { readonly type: 'removeAccount'; readonly walletId: string; readonly index: number }
  | { readonly type: 'renameWallet'; readonly walletId: string; readonly name: string }
  | { readonly type: 'importCodex'; readonly json: string; readonly codexPassword: string }
  | SignTxRequest
  | UrStoaOpRequest;

/** The discriminant literal of every {@link Request} arm. */
export type RequestType = Request['type'];

/**
 * The reasons a REQUIRING op fails. Reuses the Phase-2 at-rest set
 * (`wrong-password` / `corrupt-envelope` / `unsupported-format`) plus the
 * SW-specific outcomes:
 *   - `locked`       — an op that REQUIRES an unlocked vault was called locked.
 *   - `no-wallet`    — no vault/wallet is stored to act on.
 *   - `unauthorized` — the message came from a sender the wallet does not trust
 *                      (RR#1, foreign sender).
 *   - `unsupported-signer` — the {@link SignerSpec} names a signer kind whose
 *                      background resolver is not wired yet (gas-station co-signer
 *                      arrives in Phase 11, dApp commandSigDatas in Phase 9). A
 *                      first-class outcome so those phases can grep for the seam.
 */
export type FailureReason =
  | 'wrong-password'
  | 'corrupt-envelope'
  | 'unsupported-format'
  | 'locked'
  | 'no-wallet'
  | 'unauthorized'
  | 'unsupported-signer';

/** A JSON-safe view of an account record the popup renders. */
export interface WireAccount {
  readonly index: number;
  readonly publicKey: string;
  readonly account: string;
  readonly derivationPath: string;
}

/** The discriminated failure arm shared by every response. */
export interface Failure {
  readonly ok: false;
  readonly reason: FailureReason;
}

/**
 * isUnlocked RESPONSE (RR#12, pinned): the QUERY always SUCCEEDS and carries the
 * boolean. `{ok:false, reason:'locked'}` is reserved for ops that REQUIRE an
 * unlocked vault (signTx / getActiveAccount / addAccount).
 */
export type IsUnlockedResponse = { readonly ok: true; readonly unlocked: boolean };

/** lock / unlock / setActiveAccount succeed with an empty success payload. */
export type AckResponse = { readonly ok: true };

/**
 * getSession success: the live auto-lock snapshot the popup renders a countdown
 * from — whether unlocked, the epoch-ms auto-lock instant (null when locked), and
 * the configured window in minutes. A pure status query; carries no secret.
 */
export type SessionResponse = {
  readonly ok: true;
  readonly unlocked: boolean;
  readonly expiresAt: number | null;
  readonly autoLockMinutes: number;
};

/** setAutoLock success: the clamped minutes the wallet now uses. */
export type SetAutoLockResponse = { readonly ok: true; readonly autoLockMinutes: number };

/** getActiveAccount success: the active account, or null when none is selected. */
export type GetActiveAccountResponse =
  | { readonly ok: true; readonly account: WireAccount | null }
  | Failure;

/** addAccount success: the newly derived account. */
export type AddAccountResponse =
  | { readonly ok: true; readonly account: WireAccount }
  | Failure;

/** listAccounts success: the active wallet's accounts. */
export type ListAccountsResponse =
  | { readonly ok: true; readonly accounts: readonly WireAccount[] }
  | Failure;

/** A public per-seed summary across the wire (no secret material). */
export interface WireWalletSummary {
  readonly id: string;
  readonly name: string;
  readonly seedType: string;
  readonly isActive: boolean;
  readonly activeAccountIndex: number;
  readonly accounts: readonly WireAccount[];
}

/** listWallets success: every seed (wallet) in the vault, public fields only. */
export type ListWalletsResponse =
  | { readonly ok: true; readonly wallets: readonly WireWalletSummary[] }
  | Failure;

/** A public pure-keypair summary across the wire (no secret material). */
export interface WirePureKeypair {
  readonly id: string;
  readonly label?: string;
  readonly publicKey: string;
  readonly account: string;
}

/** listPureKeypairs success: every vault pure key, public fields only. */
export type ListPureKeypairsResponse =
  | { readonly ok: true; readonly keys: readonly WirePureKeypair[] }
  | Failure;

/**
 * importCodex RESULT: the discriminated outcome of a background Codex import. The
 * success arm carries ONLY the counts (no seed/key material crosses back — the
 * secrets were decrypted + re-sealed entirely in the worker). The failure arm
 * carries the core reason plus a local `locked`. Secret-free.
 */
export type ImportCodexResponse =
  | {
      readonly ok: true;
      readonly summary: {
        readonly seedsImported: number;
        readonly accountsImported: number;
        readonly keysImported: number;
        readonly skipped: number;
      };
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid-json'
        | 'unsupported-version'
        | 'wrong-codex-password'
        | 'no-importable-content'
        | 'locked';
    };

/**
 * signTx success carries ONLY the signed transaction (a public artifact) — never
 * a signing key. The background resolved and consumed the key material on its
 * side per the {@link SignerSpec}.
 */
export type SignTxResponse =
  | { readonly ok: true; readonly signed: WireCommand }
  | Failure;

/**
 * The reasons an UrStoa op fails as it crosses the wire. The background maps the
 * core wrapper's discriminated failure verbatim (`gas-payer-rejected` /
 * `submit-failed` / `collect-failed` / `invalid-recipient`) plus `locked` for a
 * locked/no-active-account vault. The full set lives here so the popup can render
 * the same reason the in-process (mobile/web) path would.
 */
export type UrStoaOpReason =
  | 'locked'
  | 'gas-payer-rejected'
  | 'submit-failed'
  | 'collect-failed'
  | 'invalid-recipient';

/**
 * urstoaOp RESPONSE: the discriminated outcome of a background-run UrStoa op. The
 * success arm carries ONLY the public `requestKey` (the tx tracker) — never a
 * signing key, since the keypair was resolved+consumed in the worker. The failure
 * arm carries the core reason (+ optional non-secret detail). Secret-free.
 */
export type UrStoaOpResponse =
  | { readonly ok: true; readonly requestKey: string; readonly status?: string }
  | { readonly ok: false; readonly reason: UrStoaOpReason; readonly detail?: string };

/**
 * RESPONSE union: every message the background returns. `ok` discriminates
 * success from failure (Phase-2 RR#12 discriminated results).
 *
 * SECRET-FREE: no arm carries a mnemonic/privateKey/secretKey/password — pinned
 * by {@link ResponseHasNoSecretField} below.
 */
export type Response =
  | IsUnlockedResponse
  | AckResponse
  | SessionResponse
  | SetAutoLockResponse
  | GetActiveAccountResponse
  | AddAccountResponse
  | ListAccountsResponse
  | ListWalletsResponse
  | ListPureKeypairsResponse
  | ImportCodexResponse
  | SignTxResponse
  | UrStoaOpResponse;

/** Maps a request `type` to the response shape the background returns for it. */
export type ResponseFor<T extends RequestType> = T extends 'isUnlocked'
  ? IsUnlockedResponse
  : T extends 'unlock' | 'lock' | 'setActiveAccount'
    ? AckResponse | Failure
    : T extends 'getSession'
      ? SessionResponse
      : T extends 'setAutoLock'
        ? SetAutoLockResponse
        : T extends 'listWallets'
          ? ListWalletsResponse
          : T extends 'listPureKeypairs'
          ? ListPureKeypairsResponse
          : T extends 'setActiveWallet'
            ? AckResponse | Failure
            : T extends 'addAccountAtIndex'
              ? AddAccountResponse
              : T extends 'removeAccount' | 'renameWallet'
                ? AckResponse | Failure
                : T extends 'importCodex'
                  ? ImportCodexResponse
                  : T extends 'getActiveAccount'
      ? GetActiveAccountResponse
      : T extends 'addAccount'
        ? AddAccountResponse
        : T extends 'listAccounts'
          ? ListAccountsResponse
          : T extends 'signTx'
            ? SignTxResponse
            : T extends 'urstoaOp'
              ? UrStoaOpResponse
              : never;

// --- SECRET-FREE BOUNDARY (compile-time guard) -----------------------------

/** The field names that must NEVER appear on any response arm. */
type SecretKeyName = 'mnemonic' | 'privateKey' | 'secretKey' | 'password';

/**
 * `T` if it has NO secret field, else `never`. Distributes over unions so each
 * arm is checked independently. A response shape that carries any secret field
 * collapses to `never` here — the building block of the guard below.
 */
export type NoSecretFields<T> = T extends unknown
  ? Extract<keyof T, SecretKeyName> extends never
    ? T
    : never
  : never;

/**
 * `true` iff EVERY arm of the response union `R` is secret-free. If any arm
 * carries a secret field, `NoSecretFields<R>` drops it and the unions differ,
 * yielding `false` — a compile-time tripwire asserted in the test suite.
 */
export type ResponseHasNoSecretField<R> = [NoSecretFields<R>] extends [R]
  ? [R] extends [NoSecretFields<R>]
    ? true
    : false
  : false;

// A statically-evaluated assertion: if a future edit adds a secret-bearing
// response arm, `_secretFreeBoundary` stops being assignable to `true` and the
// package fails to type-check.
const _secretFreeBoundary: ResponseHasNoSecretField<Response> = true;
void _secretFreeBoundary;

// --- result helpers --------------------------------------------------------

/**
 * Build a success response, spreading the payload onto `{ok:true}`. The popup
 * narrows on `res.ok === true` to reach the payload fields.
 */
export function ok<T extends object>(payload: T): { ok: true } & T {
  return { ok: true, ...payload };
}

/** Build a discriminated failure `{ok:false, reason}`. */
export function err(reason: FailureReason): Failure {
  return { ok: false, reason };
}

/** Narrow any response to its success arm on the `ok` discriminant. */
export function isOk<R extends { ok: boolean }>(
  res: R,
): res is Extract<R, { ok: true }> {
  return res.ok === true;
}
