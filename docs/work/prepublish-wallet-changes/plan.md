# Plan — topic 1: `advanced-mode`

Covers AC1, AC5, AC6 from `design.md`. Prerequisite for the `codex-onboarding`
topic.

All test commands run **on the Linux host**, never on the Windows `Z:` mount:

```
ssh -i "$USERPROFILE/.ssh/stoabox" -p 22222 ancientbox@192.168.2.152 \
  'export PATH=$HOME/.local/bin:$PATH; cd /home/ancientbox/ClaudeWS/StoaChain/daimons/StoaWallet && <cmd>'
```

## Wave 1

- [x] T1: Add `ADVANCED_MODE_KEY = 'stoawallet:advanced-mode'` to the storage-key
      registry, exported individually and included in the frozen `STORAGE_KEYS`
      map — done when: `pnpm exec vitest run
      packages/core/src/storage/__tests__/storageKeys.test.ts` passes with the
      registry test asserting the new key is present, is pairwise-distinct from
      the existing 10 keys, and is reachable both as a named export and via
      `STORAGE_KEYS`.
  - files: `packages/core/src/storage/storageKeys.ts`,
    `packages/core/src/storage/index.ts`,
    `packages/core/src/storage/__tests__/storageKeys.test.ts`

- [x] T2: Add an optional `origin?: 'seed' | 'codex'` field to `StoredWallet` in
      the vault model, with `deserializeVault` treating a wallet that has no
      `origin` field as `'seed'` and rejecting any other string value as a
      corrupt vault — done when: `pnpm exec vitest run
      packages/core/src/keyring/__tests__/vault.test.ts` passes with tests
      proving (a) a vault JSON written before this change (no `origin` key)
      round-trips and reads back as `'seed'`, (b) `origin: 'codex'` round-trips
      unchanged, (c) `origin: 'bogus'` is rejected by `deserializeVault`.
  - files: `packages/core/src/keyring/vault.ts`,
    `packages/core/src/keyring/__tests__/vault.test.ts`

- [x] T7: Update the stale whole-vault deep-equality expectation that T2's
      `origin` default breaks — `model.test.ts:106` asserts a deserialized vault
      `toEqual` a `legacyWallet()` fixture that has no `origin`, which now
      differs by the defaulted `origin: 'seed'`. Adjust the expectation to
      account for the default without weakening what the test checks (it must
      still fail if deserialization corrupts the rest of the wallet) — done
      when: `pnpm exec vitest run
      packages/core/src/advanced/__tests__/model.test.ts` passes. Added during
      Wave 1 execution: fallout from T2, owned by no original task. Runs after
      T2.
  - files: `packages/core/src/advanced/__tests__/model.test.ts`

## Wave 2 (depends on Wave 1)

- [x] T3: Add an advanced-mode preference module exposing
      `getAdvancedMode(adapter): Promise<boolean>` and
      `setAdvancedMode(adapter, enabled): Promise<void>`, persisting
      `JSON.stringify({ enabled })` under `ADVANCED_MODE_KEY`, defaulting to
      `false` when the value is absent, malformed, or not JSON — mirroring the
      shape of `packages/core/src/autolock/autoLockPreference.ts` — done when:
      `pnpm exec vitest run
      packages/core/src/advanced/__tests__/advancedModePreference.test.ts`
      passes with tests proving the default is `false` on an empty adapter, a
      round-trip of `true` reads back `true`, and a stored value of `"not json"`
      degrades to `false` rather than throwing.
  - files: `packages/core/src/advanced/advancedModePreference.ts`,
    `packages/core/src/advanced/index.ts`,
    `packages/core/src/advanced/__tests__/advancedModePreference.test.ts`

- [x] T4: Stamp `origin` when wallets are created: `KeyringManager.onboard` sets
      `origin: 'seed'` on the wallet it appends, and
      `KeyringManager.importCodex` sets `origin: 'codex'` on every brand-new
      wallet it appends (same-seed merges keep the existing wallet's `origin`
      untouched) — done when: `pnpm exec vitest run
      packages/core/src/keyring/__tests__/KeyringManager.test.ts
      packages/core/src/keyring/__tests__/KeyringManager.importCodex.test.ts`
      passes with tests proving an onboarded wallet persists `origin: 'seed'`, a
      codex-imported new wallet persists `origin: 'codex'`, and a codex import
      that merges into an existing seed wallet leaves that wallet's `origin` as
      `'seed'`.
  - files: `packages/core/src/keyring/KeyringManager.ts`,
    `packages/core/src/keyring/__tests__/KeyringManager.test.ts`,
    `packages/core/src/keyring/__tests__/KeyringManager.importCodex.test.ts`

## Wave 3 (depends on Wave 2)

- [x] T5: Replace the ephemeral `useState(false)` advanced toggle with the
      persisted preference and enforce the origin rules — `WalletContext`
      exposes `advancedMode: boolean`, `setAdvancedMode(enabled)` backed by T3,
      and `activeWalletOrigin: 'seed' | 'codex'` read from the active
      `StoredWallet`; `AdvancedTab` reads the persisted value instead of local
      state, renders the checkbox `disabled` and forced-checked when
      `activeWalletOrigin === 'codex'`, and calls `setAdvancedMode(true)` after
      a successful codex import into a seed-origin wallet (leaving it togglable)
      — done when: `pnpm exec vitest run packages/ui/src/advanced/__tests__/AdvancedTab.test.tsx
      packages/ui/src/context/__tests__` passes with tests proving (a) a toggle
      set to on and then remounted renders on, (b) with a codex-origin active
      wallet the checkbox is `disabled` and checked and clicking it does not
      change the stored value, (c) with a seed-origin wallet a successful codex
      import leaves the checkbox checked and still enabled, and clicking it then
      turns advanced off.
  - files: `packages/ui/src/context/WalletContext.tsx`,
    `packages/ui/src/advanced/AdvancedTab.tsx`,
    `packages/ui/src/advanced/__tests__/AdvancedTab.test.tsx`,
    `packages/ui/src/context/__tests__/WalletContext.advancedMode.test.tsx`

## Gate (AC10)

- [x] T6: Confirm the topic did not regress the store package — done when
      `pnpm test` in `apps/extension` reports the 32 store-readiness/manifest
      tests passing (`src/__tests__/storeReadiness.test.ts`,
      `src/__tests__/manifestBuild.test.ts`) and `pnpm run build:ext` completes
      with `dist/manifest.json` emitted.
  - files: none (verification only)
