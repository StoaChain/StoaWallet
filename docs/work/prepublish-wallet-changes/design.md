# Pre-publish wallet changes

Changes wanted before StoaWallet's first Chrome Web Store submission. The store
package already builds (`stoawallet-0.1.0.zip`, 518 tests passing, 32
store-readiness checks green); these land before the listing goes live so the
first published version is the one users keep.

## Problem

Five items were requested. Exploration found two already exist:

- **Auto-lock countdown** — already built and mounted
  (`packages/ui/src/security/AutoLockCountdown.tsx`, mounted at
  `packages/ui/src/app/WalletApp.tsx:418`). Renders a `🔒 m:ss` chip, polls the
  background every 10s, turns amber under 30s. No work needed.
- **First-run create/restore** — already built
  (`packages/ui/src/app/WalletApp.tsx:256`), though the restore button reads
  "Import existing" rather than naming the 24 words.

The remaining three need work, and one has a hidden prerequisite.

### Codex import exists but is unreachable at first run

The full pipeline is built (UI panel → context → proxy → protocol → router →
`KeyringManager.importCodex` → pure mapper). It handles multiple seeds, multiple
accounts, pure keypairs, same-seed merging, and is idempotent. But it is buried
in the Advanced tab behind an unchecked checkbox, and
`KeyringManager.importCodex` (`packages/core/src/keyring/KeyringManager.ts:371`)
throws `WalletLockedError` unless a wallet is already unlocked — it re-seals
imported seeds with the **wallet** password held in memory.

### The import delay is real and unreported

Per seed, `KeyringManager.ts:396-397` runs two password-based KDF operations:
`smartDecrypt` with the codex password, then `encryptPhrase` re-sealing with the
wallet password. Same per pure keypair. The loops
(`packages/core/src/codex/importCodex.ts:237` and `:294`) are sequential, so a
12-seed codex performs 24 KDF rounds back to back. The user sees only a static
"Importing…" label and cannot tell whether the password was accepted.

### The Advanced toggle does not persist

`packages/ui/src/advanced/AdvancedTab.tsx:71` is `useState(false)` — ephemeral
React state that resets on every popup open. Nothing can auto-tick it until it
becomes a persisted preference.

### There is no way to reset the wallet

No reset, wipe, or clear-all exists anywhere. Worse, `UnlockScreen` shows
"Stored wallet is corrupted / unreadable"
(`packages/ui/src/wallet/UnlockScreen.tsx:23`) with **no recovery action** — a
dead end a shipping wallet must not have.

## Decisions

1. **Codex onboarding path** — set wallet password (creates the vault) → pick
   codex file + codex password → import. The password step is unavoidable
   without re-architecting how the vault is sealed, and re-architecting sealing
   is out of scope for a pre-publish change.
2. **Advanced mode** — forced on with the toggle disabled for codex-**origin**
   wallets; auto-ticked but still togglable for seed wallets that import a codex
   later.
3. **Reset friction** — re-enter the wallet password **and** type `RESET`.
   Reset is irreversible; unrecovered funds are gone permanently.
4. **Progress granularity** — per seed and per pure keypair, reported as
   completed/total, because that is where the KDF cost actually sits.
5. **Reuse the proven progress rail** — mirror `SignProgress`
   (`apps/extension/src/messaging/protocol.ts:148-157`) rather than invent a new
   broadcast mechanism.

## Acceptance criteria

- AC1: The Advanced-mode toggle survives closing and reopening the popup.
- AC2: The first-run screen offers three options; the restore button names the
  24-word phrase.
- AC3: Choosing "Import Codex" at first run reaches a working import without the
  user first creating a wallet by another route.
- AC4: During codex import the UI shows determinate progress that advances per
  seed, so a correct password is visible immediately.
- AC5: A wallet created via codex import has Advanced mode on and cannot turn it
  off.
- AC6: A seed wallet that imports a codex later has Advanced mode turned on
  automatically but can still turn it off.
- AC7: Reset clears every persisted key — the 11 registry keys and the derived
  `stoawallet:miner:aggregation:<chainId>` family — locks the vault, and returns
  the user to the first-run screen.
- AC8: Reset requires both the wallet password and typing `RESET`.
- AC9: The corrupt-vault unlock state offers reset as a recovery action.
- AC10: The 32 store-readiness/manifest tests still pass and the extension still
  builds a store-ready ZIP.

## Topics

The work is too large for one plan. It splits into three topics, planned in
turn:

1. **`advanced-mode`** — persist the Advanced toggle, mark wallet origin in the
   vault, and enforce the forced-on / auto-on rules. Covers AC1, AC5, AC6.
   Prerequisite for topic 2. *(planned)*
2. **`codex-onboarding`** — third first-run option and the determinate import
   progress bar. Covers AC2, AC3, AC4.
3. **`wallet-reset`** — reset from scratch plus the corrupt-vault escape hatch.
   Covers AC7, AC8, AC9. Independent of the other two.

AC10 (store-readiness tests green, ZIP still builds) gates every topic.

## Out of scope

- **Any "codex service / codex address" concept.** No such thing exists in this
  repo — `packages/core/src/keyring/vault.ts:51` explicitly drops codex
  lifecycle — and it has not been described. Not implemented, not guessed at.
- **On-chain account discovery** during codex import (deriving keys and querying
  the chain for funded accounts). A separate feature; today's import reads
  accounts verbatim from the codex JSON.
- Re-architecting vault sealing so codex import works without a wallet password.

## Constraints

- All install/build/test runs happen on the Linux host over SSH; the Windows
  `Z:` mount cannot create the symlinks pnpm needs.
- `deserializeVault` must stay backward-tolerant when the origin field is added.
  There are no published users, so no data migration is required.
