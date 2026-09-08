# Seed management and vault export

Pre-launch additions. Two independent gaps found while preparing the Chrome Web
Store submission: the wallet cannot be backed up, and it cannot grow beyond the
single koala seed it onboards with.

## Problem

### There is no way to preserve a wallet

Storage is `chrome.storage.local`. Removing the extension or clearing browser
data wipes it. There is **no export of any kind**; the only import paths are a
24-word phrase or a Codex file.

Exposure is uneven:

- **Seed-origin wallet** — recoverable only if the user wrote down their 24
  words.
- **Codex-origin wallet** — the original Codex file is a real recovery path, but
  anything added *after* onboarding is not in it: extra derived accounts, pasted
  pure keys, advanced accounts, address book, node preference.

For a wallet shipping to strangers, "your funds are gone if Chrome clears site
data" is not an acceptable failure mode.

### Seeds cannot be added, and only koala can be created

The vault model already supports three seed types (`koala` = 24-word BIP39,
`chainweaver` and `eckowallet` = 12-word Kadena) and is genuinely multi-seed —
`KeyringManager.importWallet` APPENDS and leaves existing wallets intact. What is
missing sits above that:

- `onboard()` hardcodes `seedType: 'koala'`
  (`packages/core/src/keyring/KeyringManager.ts:737`), so a seed created or
  restored in the wallet is always koala. Non-koala seeds can only arrive via
  Codex import.
- There is **no UI affordance to add a seed after onboarding** —
  `CreateWalletFlow` / `ImportWalletFlow` render only at first run.
- There is **no keypair generator** (the `pact -g` equivalent). Pure keypairs
  enter only via Codex import or `PasteKeyModal`, and that flow *validates a
  pasted key against public keys the Codex already expects* — it cannot mint new
  ones.

## Decisions

1. **Export format: Codex-shaped, seeds + pure keys.** Password-sealed, in the
   same format the wallet already imports. Chosen over a bespoke full-vault
   backup because it reuses the battle-tested importer (version-gated, dedupes by
   public key, merge-aware, and verified additive), interoperates with OuronetUI,
   and re-importing one's own export safely no-ops.
   - Accepted limitation: it carries seeds and pure keys, NOT address book,
     advanced accounts, or settings. Those are conveniences; the keys are the
     funds. A settings-inclusive backup can follow later.
2. **Export is password-sealed with its own password**, not the wallet password —
   the file leaves the device, so its secret must be one the user chooses for
   that purpose.
3. **Export requires the wallet password** to run. It decrypts every seed, so it
   must prove ownership first, exactly like any other secret-touching op.
4. **Seed creation gains a type picker** (koala 24-word / chainweaver 12-word /
   eckowallet 12-word), backed by the SDK's
   `KadenaWalletBuilder.generateMnemonic(12 | 24)` and
   `isValidMnemonic(mnemonic, seedType)`.
5. **Keypair generation uses the SDK's `genKeyPair()`**
   (`@stoachain/kadena-stoic-legacy/cryptography-utils`) — a random Ed25519
   keypair — stored as a vault pure keypair. No hand-rolled key generation.
6. **Export runs on the full-tab surface**, not the popup: the popup closes on
   focus loss, which would abort a download mid-flight. No new manifest
   permission is required (a Blob + `<a download>` from an extension page needs
   none), which keeps the store-review surface unchanged.

## Acceptance criteria

- AC1: An unlocked wallet can export a Codex-shaped file after entering its
  wallet password and choosing a separate export password.
- AC2: The exported file re-imports into a fresh wallet and yields the same
  seeds and pure keys.
- AC3: Re-importing an export into the wallet it came from adds nothing and
  leaves the vault byte-identical.
- AC4: The export file never contains a plaintext mnemonic or private key.
- AC5: Export shows determinate progress, since it runs one KDF round per seed.
- AC6: A user can add a further seed after onboarding — created or restored —
  and existing seeds survive untouched.
- AC7: Seed creation and restore let the user pick koala / chainweaver /
  eckowallet, and the phrase is validated against the chosen type's rules.
- AC8: A user can generate a fresh Ed25519 keypair which appears as a vault pure
  keypair usable for signing.
- AC9: The 32 store-readiness/manifest tests still pass and the extension still
  builds a store-ready ZIP.

## Topics

Planned in turn:

1. **`vault-export`** — Codex-shaped password-sealed export with progress.
   Covers AC1-AC5. Highest priority: it is the one that loses funds.
2. **`seed-management`** — add-a-seed after onboarding plus the seed-type
   picker. Covers AC6, AC7.
3. **`keypair-generator`** — the `pact -g` equivalent. Covers AC8.

AC9 gates every topic.

## Out of scope

- A settings-inclusive full-vault backup format (address book, advanced
  accounts, node preference). Deliberately deferred; see decision 1.
- Encrypting the export at the wallet password. The file leaves the device;
  reusing the unlock password would spread it to backups and cloud drives.
- Importing non-Codex third-party wallet formats.

## Constraints

- All install/build/test runs happen on the Linux host over SSH; the Windows
  `Z:` mount cannot create the symlinks pnpm needs.
- Chainweaver/eckowallet seeds are stored as encrypted MNEMONICS like koala
  (`encryptPhrase`), even though their signing path differs — so export re-seals
  mnemonics uniformly across all three types.
