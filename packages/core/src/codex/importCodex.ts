/**
 * Codex IMPORT — bring an Ouronet "Codex" export (`OuronetCodex_*.json`, v1.2)
 * into THIS wallet's vault, preserving the wallet's key-isolation model.
 *
 * The codex export stores every secret ENCRYPTED AT THE CODEX PASSWORD
 * (`smartDecrypt`/`encryptStringV2`, the same `stoa-core/crypto` this wallet
 * uses). This module is the PURE mapper: given the export JSON, a `decrypt` seam
 * (codex-password → plaintext) and re-encrypt seams (wallet-password → at-rest
 * blob), it produces the `StoredWallet`s + `IPureKeypair`s to MERGE into the
 * vault. It performs NO storage I/O and holds no password — the caller (the
 * KeyringManager, in the background service worker) supplies the decrypt bound to
 * the codex password and the encrypt bound to the unlocked wallet password, so a
 * decrypted secret is re-sealed at rest and never leaves the secure context.
 *
 * We consume ONLY the codex's seed wallets + pure keypairs. The Ouronet identity
 * accounts (`ouronetWallets`) are protocol identities, not StoaChain `k:` coin
 * accounts, so they are intentionally NOT imported here.
 */

import type {
  EncryptedBlob,
  IPureKeypair,
  SeedType,
  StoredAccount,
  StoredWallet,
} from '../keyring';
import { SEED_TYPES } from '../keyring';

/** A `k:` public key: 64 hex chars (the form a StoaChain `k:` account wraps). */
const PUBKEY_RE = /^[0-9a-fA-F]{64}$/;

// ── The minimal slice of the v1.2 export we consume (validated structurally) ──

/** One derived account inside a codex seed. */
interface CodexAccount {
  readonly index: number;
  readonly publicKey: string;
  readonly derivationPath: string;
}

/** One codex seed: its type, the codex-password-encrypted mnemonic, its accounts. */
interface CodexSeed {
  readonly id: string;
  readonly name?: string;
  readonly seedType: string;
  /** The mnemonic, encrypted at the CODEX password. */
  readonly secret: string;
  readonly accounts: readonly CodexAccount[];
  /** v0.2.0+ prime-seed flag — the seed that kickstarted the codex. */
  readonly isPrime?: boolean;
}

/** The canonical designation for a codex's prime seed (the legacy stored name is
 * "Initial Seed"; OuronetUI masks it at render — we normalize it on import). */
const PRIME_CODEX_SEED_NAME = 'Prime Codex Seed';

/**
 * The display name to store for an imported codex seed. Ports OuronetUI's
 * `getSeedDisplayName` prime rule: the codex persists the prime seed's name as the
 * legacy literal `"Initial Seed"` (only masked at render upstream), and v0.2.0+
 * also flags it via `isPrime`. Normalize both to the canonical designation so the
 * legacy name never surfaces here; non-prime seeds keep their stored name (or a
 * descriptive fallback when the codex stored none).
 */
function seedDisplayName(seed: CodexSeed): string {
  if (seed.isPrime === true || seed.name === 'Initial Seed') {
    return PRIME_CODEX_SEED_NAME;
  }
  return seed.name ?? `Imported ${seed.seedType} seed`;
}

/** One pure (raw) keypair, its private key encrypted at the codex password. */
interface CodexPureKeypair {
  readonly id: string;
  readonly label?: string;
  readonly publicKey: string;
  readonly encryptedPrivateKey: string;
}

/** The export top level (v1.2). Only the fields this wallet imports are typed. */
export interface CodexExport {
  readonly version: string;
  readonly kadenaWallets: readonly CodexSeed[];
  readonly pureKeypairs?: readonly CodexPureKeypair[];
}

/** A pre-existing vault wallet, viewed for SAME-SEED detection during import. */
export interface ExistingWalletView {
  readonly id: string;
  readonly name: string;
  /** Every derived account public key the wallet already holds. */
  readonly accountPubKeys: readonly string[];
}

/** The injectable crypto + identity seams (the KeyringManager binds the real ones). */
export interface ImportCodexDeps {
  /** Decrypt a codex blob at the CODEX password (e.g. `stoa-core/crypto` smartDecrypt). */
  decrypt: (encrypted: string) => Promise<string>;
  /** Re-seal a plaintext mnemonic at the WALLET password (encrypt-at-rest). */
  encryptPhrase: (mnemonic: string) => Promise<EncryptedBlob>;
  /** Re-seal a plaintext private key at the WALLET password. */
  encryptPrivateKey: (privateKey: string) => Promise<string>;
  /** Public keys ALREADY in the vault (accounts + pure keys) — for idempotent dedupe. */
  existingPubKeys: ReadonlySet<string>;
  /** The pre-existing wallets — for SAME-SEED detection (merge, not duplicate). */
  existingWallets: readonly ExistingWalletView[];
  /** A fresh id (the manager injects its id scheme; tests inject a counter). */
  genId: (kind: 'wallet' | 'key') => string;
  /** An ISO timestamp (`Date.now`-free for determinism in tests). */
  now: () => string;
}

/**
 * A MERGE into a pre-existing wallet: the codex carried a seed the vault already
 * holds (shared account pubkey), so rather than duplicating the seed we append its
 * NEW accounts to the existing wallet and adopt the codex's name. `accounts` may be
 * empty (a name-only adopt when the account sets already match).
 */
export interface ImportCodexMerge {
  readonly walletId: string;
  readonly name: string;
  readonly accounts: readonly StoredAccount[];
}

/** The vault additions an import produces — the caller merges + persists them. */
export interface ImportCodexResult {
  readonly wallets: readonly StoredWallet[];
  /** Accounts/name to fold into pre-existing wallets (same seed, more accounts). */
  readonly merges: readonly ImportCodexMerge[];
  readonly pureKeypairs: readonly IPureKeypair[];
  /** Counts for a user-facing summary (and to detect a no-op import). */
  readonly summary: {
    /** Brand-new seeds added (merges do NOT count here). */
    readonly seedsImported: number;
    /** Accounts added — across both new seeds AND merges into existing seeds. */
    readonly accountsImported: number;
    readonly keysImported: number;
    /** Seeds/keys skipped because they were already fully present in the vault. */
    readonly skipped: number;
  };
}

/** Failure reasons — all secret-free; never echo a decrypted value. */
export type ImportCodexFailure =
  | { readonly ok: false; readonly reason: 'invalid-json' }
  | { readonly ok: false; readonly reason: 'unsupported-version'; readonly version?: string }
  | { readonly ok: false; readonly reason: 'wrong-codex-password' }
  | { readonly ok: false; readonly reason: 'no-importable-content' };

export type ImportCodexOutcome =
  | ({ readonly ok: true } & ImportCodexResult)
  | ImportCodexFailure;

function asExport(value: unknown): CodexExport | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== 'string') return null;
  if (!Array.isArray(v.kadenaWallets)) return null;
  return v as unknown as CodexExport;
}

function isValidSeed(seed: unknown): seed is CodexSeed {
  if (typeof seed !== 'object' || seed === null) return false;
  const s = seed as Record<string, unknown>;
  return (
    typeof s.secret === 'string' &&
    typeof s.seedType === 'string' &&
    SEED_TYPES.includes(s.seedType as SeedType) &&
    Array.isArray(s.accounts)
  );
}

function toStoredAccount(raw: unknown): StoredAccount | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  if (
    typeof a.index !== 'number' ||
    typeof a.publicKey !== 'string' ||
    !PUBKEY_RE.test(a.publicKey)
  ) {
    return null;
  }
  return {
    index: a.index,
    publicKey: a.publicKey,
    account: `k:${a.publicKey}`,
    derivationPath:
      typeof a.derivationPath === 'string' ? a.derivationPath : `m'/44'/626'/${a.index}'`,
  };
}

/**
 * Import a Codex export into vault additions. Decrypts each seed's mnemonic and
 * each pure key's private key at the codex password (via {@link ImportCodexDeps.decrypt}),
 * re-seals them at the wallet password, and maps them onto `StoredWallet`/
 * `IPureKeypair`. Idempotent: a seed/key whose public key is already in the vault
 * is skipped (re-importing the same codex adds nothing). Never throws across the
 * boundary — a bad password (decrypt rejects) collapses to `wrong-codex-password`.
 */
export async function importCodex(
  json: string,
  deps: ImportCodexDeps,
): Promise<ImportCodexOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }

  const exp = asExport(parsed);
  if (exp === null) return { ok: false, reason: 'invalid-json' };
  // The wire format is frozen at "1.2"; reject anything else loudly rather than
  // mis-parsing a future/older shape.
  if (exp.version !== '1.2') {
    return { ok: false, reason: 'unsupported-version', version: exp.version };
  }

  const seen = new Set<string>(deps.existingPubKeys);
  // Mutable view of pre-existing wallets for SAME-SEED detection: a codex seed is
  // the same seed as an existing wallet iff they share ANY account public key (same
  // mnemonic + seedType derive identical pubkeys per index). Updated as we go so a
  // just-created wallet also absorbs a later same-seed codex entry.
  const existing = deps.existingWallets.map((w) => ({
    id: w.id,
    name: w.name,
    pubs: new Set(w.accountPubKeys),
  }));

  const wallets: StoredWallet[] = [];
  const merges: ImportCodexMerge[] = [];
  const pureKeypairs: IPureKeypair[] = [];
  let accountsImported = 0;
  let skipped = 0;

  try {
    for (const rawSeed of exp.kadenaWallets) {
      if (!isValidSeed(rawSeed)) {
        skipped += 1;
        continue;
      }
      const accounts = rawSeed.accounts
        .map(toStoredAccount)
        .filter((a): a is StoredAccount => a !== null);
      if (accounts.length === 0) {
        skipped += 1;
        continue;
      }

      const name = seedDisplayName(rawSeed);

      // SAME-SEED MERGE: an existing wallet that shares any account pubkey IS this
      // seed. Fold in the accounts it does not yet have (and adopt the codex name)
      // instead of creating a duplicate wallet.
      const match = existing.find((w) =>
        accounts.some((a) => w.pubs.has(a.publicKey)),
      );
      if (match !== undefined) {
        const newAccounts = accounts.filter((a) => !match.pubs.has(a.publicKey));
        // Nothing new AND the name already matches → truly already present.
        if (newAccounts.length === 0 && name === match.name) {
          skipped += 1;
          continue;
        }
        merges.push({ walletId: match.id, name, accounts: newAccounts });
        newAccounts.forEach((a) => {
          seen.add(a.publicKey);
          match.pubs.add(a.publicKey);
        });
        match.name = name; // adopt for subsequent same-seed comparisons
        accountsImported += newAccounts.length;
        continue;
      }

      const mnemonic = await deps.decrypt(rawSeed.secret);
      const encryptedPhrase = await deps.encryptPhrase(mnemonic);
      const id = deps.genId('wallet');

      wallets.push({
        id,
        name,
        encryptedPhrase,
        accounts,
        activeAccountIndex: 0,
        seedType: rawSeed.seedType as SeedType,
        createdAt: deps.now(),
      });
      // The just-created wallet is now "existing" for any later same-seed codex entry.
      existing.push({ id, name, pubs: new Set(accounts.map((a) => a.publicKey)) });
      accounts.forEach((a) => seen.add(a.publicKey));
      accountsImported += accounts.length;
    }

    for (const rawKey of exp.pureKeypairs ?? []) {
      if (
        typeof rawKey !== 'object' ||
        rawKey === null ||
        typeof (rawKey as CodexPureKeypair).publicKey !== 'string' ||
        typeof (rawKey as CodexPureKeypair).encryptedPrivateKey !== 'string'
      ) {
        skipped += 1;
        continue;
      }
      const key = rawKey as CodexPureKeypair;
      if (!PUBKEY_RE.test(key.publicKey) || seen.has(key.publicKey)) {
        skipped += 1;
        continue;
      }
      const privateKey = await deps.decrypt(key.encryptedPrivateKey);
      pureKeypairs.push({
        id: deps.genId('key'),
        ...(key.label !== undefined ? { label: key.label } : {}),
        publicKey: key.publicKey,
        encryptedPrivateKey: await deps.encryptPrivateKey(privateKey),
        createdAt: deps.now(),
      });
      seen.add(key.publicKey);
    }
  } catch {
    // The ONLY async failure here is a decrypt rejection — a wrong codex password
    // (or a tampered blob). Collapse it to a single secret-free reason.
    return { ok: false, reason: 'wrong-codex-password' };
  }

  if (wallets.length === 0 && merges.length === 0 && pureKeypairs.length === 0) {
    return { ok: false, reason: 'no-importable-content' };
  }

  return {
    ok: true,
    wallets,
    merges,
    pureKeypairs,
    summary: {
      seedsImported: wallets.length,
      accountsImported,
      keysImported: pureKeypairs.length,
      skipped,
    },
  };
}
