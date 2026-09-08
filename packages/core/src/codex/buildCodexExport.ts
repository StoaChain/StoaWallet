/**
 * Build an Ouronet Codex export FROM this wallet's vault — the mirror image of
 * `importCodex`.
 *
 * Why the Codex shape rather than a bespoke backup format: the wallet already
 * imports it, that importer is version-gated, dedupes by public key and is
 * verified additive, and the file interoperates with OuronetUI. Re-importing
 * one's own export is therefore a safe no-op rather than a duplication risk.
 *
 * PURE mapper: the two crypto seams are injected, exactly like `importCodex`.
 * No storage I/O, no SDK transport, no password handling here — the caller owns
 * both passwords and this file never sees either.
 *
 * SCOPE: seeds and pure keypairs only. Address book, advanced accounts and
 * settings are deliberately NOT carried — they are conveniences, the keys are
 * the funds, and widening the format would break Codex interop.
 */

import type { IPureKeypair, StoredWallet } from '../keyring/vault';

/** The vault slice an export is built from. */
export interface BuildCodexExportInput {
  readonly wallets: readonly StoredWallet[];
  readonly pureKeypairs: readonly IPureKeypair[];
}

/** The injected crypto seams plus the optional progress sink. */
export interface BuildCodexExportDeps {
  /** Open a stored envelope at the WALLET password. */
  open: (encrypted: string) => Promise<string>;
  /** Re-seal a plaintext secret at the EXPORT password. */
  reseal: (plaintext: string) => Promise<string>;
  /**
   * Optional progress sink, called once per seed and once per pure key. Each
   * item costs a KDF round on the way out just as it does on the way in, so a
   * multi-seed export is slow enough to need a determinate bar.
   */
  onProgress?: (done: number, total: number) => void;
  /** ISO timestamp for `exportedAt`. Injectable so the mapper stays pure. */
  now?: () => string;
}

/** One seed as the Codex wire format carries it. */
export interface CodexExportSeed {
  readonly id: string;
  readonly name: string;
  readonly seedType: string;
  /** The mnemonic, sealed at the EXPORT password. */
  readonly secret: string;
  readonly accounts: ReadonlyArray<{
    readonly index: number;
    readonly publicKey: string;
    readonly derivationPath: string;
  }>;
}

/** One pure keypair as the Codex wire format carries it. */
export interface CodexExportPureKey {
  readonly id: string;
  readonly label?: string;
  readonly publicKey: string;
  /** The private key, sealed at the EXPORT password. */
  readonly encryptedPrivateKey: string;
}

/**
 * The emitted export document — a COMPLETE Ouronet Codex v1.2 envelope.
 *
 * The four fields StoaWallet has no concept of (`ouronetWallets`, `addressBook`,
 * `uiSettings`) are emitted EMPTY rather than omitted: the Ouronet importer
 * validates their presence and type up front and throws
 * `CodexImportError("shape", ...)` on a missing one, so a file without them
 * would be rejected outright instead of importing its seeds.
 */
export interface CodexExportDocument {
  readonly version: '1.2';
  readonly exportedAt: string;
  readonly kadenaWallets: readonly CodexExportSeed[];
  /** Ouro/protocol identities — StoaWallet holds none; empty for shape validity. */
  readonly ouronetWallets: readonly never[];
  /** Empty for shape validity: StoaWallet's own address book uses a different shape. */
  readonly addressBook: readonly never[];
  /** Empty for shape validity: StoaWallet's settings are not Codex uiSettings. */
  readonly uiSettings: Readonly<Record<string, never>>;
  readonly pureKeypairs: readonly CodexExportPureKey[];
}

export type BuildCodexExportOutcome =
  | { readonly ok: true; readonly export: CodexExportDocument }
  | { readonly ok: false; readonly reason: 'nothing-to-export' };

/**
 * Map the vault into a Codex export, re-sealing every secret on the way.
 *
 * Emits `version: '1.2'` — the older of the two versions the importer accepts —
 * so the file also opens in tools that predate 1.3.
 */
export async function buildCodexExport(
  input: BuildCodexExportInput,
  deps: BuildCodexExportDeps,
): Promise<BuildCodexExportOutcome> {
  // An empty file that looks like a backup is worse than no backup at all.
  if (input.wallets.length === 0) {
    return { ok: false, reason: 'nothing-to-export' };
  }

  const total = input.wallets.length + input.pureKeypairs.length;
  let done = 0;
  const tick = (): void => {
    done += 1;
    deps.onProgress?.(done, total);
  };

  const kadenaWallets: CodexExportSeed[] = [];
  for (const w of input.wallets) {
    // Open at the wallet password, immediately re-seal at the export password —
    // the plaintext exists only for the width of this statement.
    const mnemonic = await deps.open(w.encryptedPhrase);
    kadenaWallets.push({
      id: w.id,
      name: w.name,
      seedType: w.seedType,
      secret: await deps.reseal(mnemonic),
      // `account` is intentionally dropped: it is `k:<publicKey>`, derivable on
      // import, and the Codex format does not carry it.
      accounts: w.accounts.map((a) => ({
        index: a.index,
        publicKey: a.publicKey,
        derivationPath: a.derivationPath,
      })),
    });
    tick();
  }

  const pureKeypairs: CodexExportPureKey[] = [];
  for (const k of input.pureKeypairs) {
    const privateKey = await deps.open(k.encryptedPrivateKey);
    pureKeypairs.push({
      id: k.id,
      ...(k.label !== undefined ? { label: k.label } : {}),
      publicKey: k.publicKey,
      encryptedPrivateKey: await deps.reseal(privateKey),
    });
    tick();
  }

  const now = deps.now ?? ((): string => new Date().toISOString());

  return {
    ok: true,
    export: {
      version: '1.2',
      exportedAt: now(),
      kadenaWallets,
      // Present-but-empty: the Ouronet importer rejects a file that omits these.
      ouronetWallets: [],
      addressBook: [],
      uiSettings: {},
      pureKeypairs,
    },
  };
}
