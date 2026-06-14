/**
 * The request router: maps one popup {@link Request} to a {@link Response} by
 * driving the {@link KeyringManager}. This is the single place where the secure
 * service worker decides WHICH manager op a wire message triggers and how its
 * outcomes (success / typed errors) collapse onto the wire {@link FailureReason}
 * set.
 *
 * SECURITY POSTURE:
 *   - signTx resolves the signing keypair SET on THIS side from the
 *     {@link SignerSpec} (XP-12): the popup never sends key material, and the
 *     reply carries ONLY the signed public transaction — the keypair never
 *     leaves the worker.
 *   - Every failure travels as a discriminated `{ok:false, reason}`; no error is
 *     thrown back across the wire, so a stack/message can never carry a secret
 *     out of the secure context.
 *   - Sender trust is enforced UPSTREAM of this router (see createBackground); by
 *     the time a request reaches here it is already from the trusted popup.
 */
import type { KeyringManager } from '@stoawallet/core';
import { fromKeypair, universalSignTransaction } from '@stoachain/stoa-core/signing';
import type { SignableKeypair } from '@stoawallet/core';
import type { IUnsignedCommand } from '@stoachain/kadena-stoic-legacy/types';
// The SDK's blake2b-256 base64url hasher (the canonical Pact cmd hash). Its ESM
// `.d.ts` is empty in this build of @stoachain/kadena-stoic-legacy (only `.d.cts`
// declares it), so the named export is typed locally; the runtime resolves it
// from the `.cjs`.
import * as cryptoUtils from '@stoachain/kadena-stoic-legacy/cryptography-utils';

const hashCmd = (cryptoUtils as unknown as { hash: (str: string) => string }).hash;

import type { KeyVault } from '@stoawallet/core';

import {
  err,
  ok,
  type FailureReason,
  type Request,
  type Response,
  type SignTxRequest,
  type UrStoaOpRequest,
  type UrStoaOpResponse,
  type WireAccount,
  type WireCommand,
  type WireSigData,
} from '../messaging/protocol';
import type {
  CollectUrStoaParams,
  CollectUrStoaResult,
  TransferUrStoaParams,
  TransferUrStoaResult,
  UrStoaStakeParams,
  UrStoaStakeResult,
} from '@stoawallet/core';
import {
  collectUrStoa as coreCollectUrStoa,
  stakeUrStoa as coreStakeUrStoa,
  transferUrStoa as coreTransferUrStoa,
  unstakeUrStoa as coreUnstakeUrStoa,
} from '@stoawallet/core';

/** A stored account record shape, minimal view used to build a {@link WireAccount}. */
interface AccountLike {
  readonly index: number;
  readonly publicKey: string;
  readonly account: string;
  readonly derivationPath: string;
}

function toWireAccount(account: AccountLike): WireAccount {
  return {
    index: account.index,
    publicKey: account.publicKey,
    account: account.account,
    derivationPath: account.derivationPath,
  };
}

/**
 * Map a KeyringManager rejection to the wire {@link FailureReason}. The decrypt
 * path throws SDK error classes named `WrongPasswordError` /
 * `CorruptEnvelopeError` / `UnsupportedFormatError`; a missing-or-corrupt vault
 * surfaces as `CorruptVaultError`; a locked-vault signing attempt as
 * `WalletLockedError`. Matched by `error.name` (not `instanceof`) so a
 * cross-package duplicate of the class still classifies correctly. An
 * unrecognized error collapses to `corrupt-envelope` rather than re-throwing a
 * secret-bearing Error across the wire.
 */
function reasonForError(error: unknown): FailureReason {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'WrongPasswordError':
      return 'wrong-password';
    case 'UnsupportedFormatError':
      return 'unsupported-format';
    case 'WalletLockedError':
      return 'locked';
    case 'CorruptVaultError':
      // No usable vault to act on — the popup should onboard, not retry a pw.
      return 'no-wallet';
    default:
      return 'corrupt-envelope';
  }
}

/** A WireCommand crosses as a plain {cmd, hash, sigs?}; sign needs an IUnsignedCommand. */
function toUnsignedCommand(tx: WireCommand): IUnsignedCommand {
  return {
    cmd: tx.cmd,
    hash: tx.hash,
    sigs: (tx.sigs ?? []).map((s) =>
      s == null ? undefined : { pubKey: s.pubKey ?? '', sig: s.sig ?? undefined },
    ),
  } as IUnsignedCommand;
}

/** A signed IUnsignedCommand/ICommand back to the JSON-safe wire shape. */
function toWireCommand(signed: { cmd: string; hash: string; sigs?: unknown }): WireCommand {
  const sigs = Array.isArray(signed.sigs)
    ? signed.sigs.map((s) => {
        const slot = s as { pubKey?: string; sig?: string | null } | null;
        if (slot == null) return null;
        return { pubKey: slot.pubKey, sig: slot.sig ?? null };
      })
    : undefined;
  return { cmd: signed.cmd, hash: signed.hash, sigs };
}

/**
 * Resolve the signing keypair SET for a signTx request from its {@link SignerSpec}
 * and sign on THIS side. Only the `active` (and `advanced`) kinds are wired;
 * the Phase-9 dApp `commandSigDatas` and Phase-11 `gas-station` co-signer kinds
 * reply a first-class `unsupported-signer` so those phases can grep the seam.
 *
 * XP-3: when an `approvalToken` is present, this is the validation hook —
 * Phase 9 enforces single-use approval before honoring a dApp signing request.
 * A dApp-originated signTx MUST carry a token; the in-wallet popup path omits it.
 */
/**
 * XP-4: sign a dApp-supplied {@link WireSigData} envelope in the BACKGROUND.
 *
 * The dApp hands a `cmd` string plus the empty `sig` slots for the pubkeys it
 * wants the wallet to fill. We resolve the wallet's CURRENT signing keypairs
 * (the active account today; advanced/derived sets extend this list), build the
 * pubkey→keypair map, and sign the dApp's OWN cmd via `universalSignTransaction`
 * — never re-encoding it. The wallet only fills the slots whose pubkey it
 * controls; slots for foreign pubkeys keep their `null` sig (a co-signer fills
 * them). The reply carries ONLY the filled public command; the keypair never
 * leaves this function.
 *
 * The cmd's blake2b hash is computed from the cmd string itself, so the signature
 * binds the EXACT bytes the dApp (and the approval preview) showed — the no-bait-
 * and-switch guarantee holds at the cryptographic layer.
 */
async function signCommandSigData(
  manager: KeyringManager,
  sigData: WireSigData,
): Promise<Response> {
  // Resolve the keypair(s) the wallet can currently sign with. A locked vault
  // throws WalletLockedError → mapped to `locked` by the caller's catch.
  const keypairs = await manager.resolveActiveSigningKeypairs();

  // Only sign with the keypairs whose pubkey the dApp actually requested a slot
  // for — so the wallet never attaches a signature the dApp did not ask for.
  const requested = new Set(sigData.sigs.map((s) => s.pubKey));
  const signingSet = keypairs.filter(
    (kp) => kp.publicKey !== undefined && requested.has(kp.publicKey),
  );

  const unsigned: IUnsignedCommand = {
    cmd: sigData.cmd,
    hash: hashCmd(sigData.cmd),
    sigs: sigData.sigs.map((s) => ({ pubKey: s.pubKey, sig: s.sig ?? undefined })),
  } as IUnsignedCommand;

  const signed = await universalSignTransaction(
    unsigned,
    signingSet.map((kp) => fromKeypair(kp)),
  );

  return ok({ signed: toWireCommand(signed as { cmd: string; hash: string; sigs?: unknown }) });
}

/**
 * XP-3: validate-and-consume a single-use approval token before a dApp sign. The
 * registry is owned by the background; the in-wallet popup paths pass no
 * consumer (they sign without a token).
 */
export interface ApprovalTokenConsumer {
  consume(token: string): boolean;
}

/**
 * Injectable UrStoa core seam (XP-12). Defaults to the real `@stoawallet/core`
 * wrappers; tests inject off-network spies so the keypair-resolution + sender +
 * idle-rearm path runs for real without hitting node1. Each wrapper bundles
 * build+sign+submit around the LITERAL keypair the background resolves — which is
 * exactly why the WHOLE op must run here rather than routing one signature back.
 */
export interface UrStoaCore {
  stakeUrStoa(params: UrStoaStakeParams): Promise<UrStoaStakeResult>;
  unstakeUrStoa(params: UrStoaStakeParams): Promise<UrStoaStakeResult>;
  collectUrStoa(params: CollectUrStoaParams): Promise<CollectUrStoaResult>;
  transferUrStoa(params: TransferUrStoaParams): Promise<TransferUrStoaResult>;
}

const DEFAULT_URSTOA_CORE: UrStoaCore = {
  stakeUrStoa: coreStakeUrStoa,
  unstakeUrStoa: coreUnstakeUrStoa,
  collectUrStoa: coreCollectUrStoa,
  transferUrStoa: coreTransferUrStoa,
};

/**
 * Run a full UrStoa write op in the BACKGROUND (XP-12). The active account's
 * SIGN-READY keypair is resolved from the in-memory unlocked state via the SAME
 * `resolveActiveSigningKeypairs` path `signTx` uses (a locked vault throws
 * `WalletLockedError`, mapped to `locked` by the caller's catch). The resolved
 * keypair is consumed INSIDE the core wrapper and never crosses back to the popup;
 * the reply carries only the discriminated result. The popup supplied PUBLIC
 * params only — no key material entered the worker from the wire.
 */
async function handleUrStoaOp(
  manager: KeyringManager,
  request: UrStoaOpRequest,
  core: UrStoaCore,
): Promise<UrStoaOpResponse> {
  // Re-derive the active account's keypair (koala nacl path) from the unlocked
  // mnemonic+password. A locked vault rejects here BEFORE any core call.
  const keypairs = await manager.resolveActiveSigningKeypairs();
  const keypair = keypairs[0];
  if (keypair === undefined) {
    return { ok: false, reason: 'locked' };
  }

  // The active account's own keypair signs BOTH the gas-payer cap and the op cap
  // (RR#1) — the same dual-cap signer the in-process path uses. The SDK keypair
  // shape carries publicKey/privateKey/seedType; the wrapper consumes it directly.
  const signingKey = {
    publicKey: keypair.publicKey ?? '',
    privateKey: keypair.privateKey ?? '',
    seedType: keypair.seedType ?? 'koala',
  } as CollectUrStoaParams['gasStationKey'];

  switch (request.op) {
    case 'stake':
      return core.stakeUrStoa({
        paymentKeyAddress: request.params.paymentKeyAddress,
        amount: request.params.amount,
        gasStationKey: signingKey,
      });
    case 'unstake':
      return core.unstakeUrStoa({
        paymentKeyAddress: request.params.paymentKeyAddress,
        amount: request.params.amount,
        gasStationKey: signingKey,
      });
    case 'collect':
      return core.collectUrStoa({
        paymentKeyAddress: request.params.paymentKeyAddress,
        gasStationKey: signingKey,
      });
    case 'transfer':
      return core.transferUrStoa({
        senderAddress: request.params.senderAddress,
        receiverAddress: request.params.receiverAddress,
        amount: request.params.amount,
        paymentKeyAddress: request.params.senderAddress,
        paymentKeypair: signingKey as TransferUrStoaParams['paymentKeypair'],
      });
  }
}

async function handleSignTx(
  manager: KeyringManager,
  request: SignTxRequest,
  consumer?: ApprovalTokenConsumer,
): Promise<Response> {
  const spec = request.signerSpec;

  // XP-3: a dApp-originated signing request (commandSigDatas) MUST carry a valid
  // single-use approval token. Validate-and-consume it BEFORE any key material is
  // resolved, so a replayed approved sign — or one with no/forged token — is
  // rejected without a second signature. The in-wallet popup paths (active /
  // advanced) sign without a token and skip this gate.
  if (spec.kind === 'commandSigDatas') {
    const token = request.approvalToken;
    if (consumer === undefined || token === undefined || !consumer.consume(token)) {
      return err('unauthorized');
    }
  }

  let keypairs: readonly SignableKeypair[];
  switch (spec.kind) {
    case 'active': {
      // WalletLockedError → reasonForError maps to `locked` in the catch below.
      keypairs = await manager.resolveActiveSigningKeypairs();
      break;
    }
    case 'advanced': {
      const accounts = await manager.listAdvancedAccounts();
      const account = accounts.find((a) => a.address === spec.address);
      if (account === undefined) {
        return err('no-wallet');
      }
      const resolved = await manager.resolveAdvancedSigningKeypairs(account);
      if (!resolved.ok) {
        // The advanced resolver could not satisfy the guard (locked / missing
        // key / guard changed). Surface a locked-or-unauthorized style failure
        // rather than signing with an incomplete set.
        return err('locked');
      }
      keypairs = resolved.keypairs;
      break;
    }
    // XP-4: the dApp-supplied SigData path resolves each requested pubkey to a
    // wallet keypair and signs the dApp's own cmd here, returning the filled
    // command (a different envelope than the active/advanced tx-rewrite path).
    case 'commandSigDatas':
      return signCommandSigData(manager, spec.sigData);
    // Phase 11 (gas-station co-signer) wires its resolver here; until then it is
    // a first-class unsupported signer.
    case 'gas-station':
      return err('unsupported-signer');
  }

  const unsigned = toUnsignedCommand(request.tx);
  // Normalize each resolved keypair to the SDK's UniversalKeypair (maps the
  // `privateKey` field onto `secretKey` the nacl path reads) before signing.
  const signed = await universalSignTransaction(
    unsigned,
    keypairs.map((kp) => fromKeypair(kp)),
  );

  return ok({ signed: toWireCommand(signed as { cmd: string; hash: string; sigs?: unknown }) });
}

/**
 * Route a single trusted request to the manager and produce its response. Never
 * throws: every failure path returns a discriminated `{ok:false, reason}` so the
 * secure worker's only output across the wire is plain, secret-free data.
 *
 * The unlocked state is read from the {@link KeyVault} (the canonical owner of
 * the in-memory unlocked key) — NOT from the manager, which keeps its unlocked
 * state private. A respawned-but-not-unlocked worker therefore reports `false`.
 */
export async function routeRequest(
  manager: KeyringManager,
  keyVault: KeyVault,
  request: Request,
  approvalTokens?: ApprovalTokenConsumer,
  urstoaCore: UrStoaCore = DEFAULT_URSTOA_CORE,
): Promise<Response> {
  try {
    switch (request.type) {
      case 'isUnlocked':
        // RR#12: the query always SUCCEEDS carrying the boolean.
        return ok({ unlocked: keyVault.isUnlocked() });

      case 'unlock':
        await manager.unlock(request.walletId, request.password);
        return ok({});

      case 'lock':
        await manager.lock();
        return ok({});

      case 'addAccount': {
        if (!keyVault.isUnlocked()) {
          // RR#7: addAccount re-derives from the in-memory mnemonic, which a
          // locked vault has cleared — report `locked` rather than letting the
          // manager throw a generic "must be unlocked" Error.
          return err('locked');
        }
        const account = await manager.addAccount(request.walletId);
        return ok({ account: toWireAccount(account) });
      }

      case 'setActiveAccount':
        await manager.setActiveAccount(request.walletId, request.index);
        return ok({});

      case 'getActiveAccount': {
        if (!keyVault.isUnlocked()) {
          // Surface the account only for an unlocked vault so a respawned-but-
          // locked worker reports `locked`, not a stale cached read.
          return err('locked');
        }
        const account = manager.getActiveAccount();
        return ok({ account: account === null ? null : toWireAccount(account) });
      }

      case 'listAccounts':
        return ok({ accounts: manager.getActiveWalletAccounts().map(toWireAccount) });

      case 'signTx':
        if (!keyVault.isUnlocked()) {
          return err('locked');
        }
        return await handleSignTx(manager, request, approvalTokens);

      case 'urstoaOp':
        // The keypair lives only here; a locked vault short-circuits before any
        // re-derivation so the core wrapper never runs with null keys.
        if (!keyVault.isUnlocked()) {
          return { ok: false, reason: 'locked' };
        }
        return await handleUrStoaOp(manager, request, urstoaCore);

      default: {
        // An unrecognized/malformed request type (a trusted sender can still
        // send a corrupt envelope). Without this arm the switch would fall
        // through to `undefined`, which the popup proxy then dereferences and
        // throws on. Collapse it to a discriminated failure instead. The
        // `never` binding makes adding a new Request arm without a case here a
        // compile error.
        const _exhaustive: never = request;
        void _exhaustive;
        return err('corrupt-envelope');
      }
    }
  } catch (error) {
    return err(reasonForError(error));
  }
}
