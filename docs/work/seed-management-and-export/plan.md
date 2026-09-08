# Plan — topic 1: `vault-export`

Covers AC1-AC5 from `design.md`.

All test commands run **on the Linux host**, never on the Windows `Z:` mount:

```
ssh -i "Z:/.secrets/stoabox" -p 22222 ancientbox@192.168.2.152 \
  'export PATH=$HOME/.local/bin:$PATH; cd /home/ancientbox/ClaudeWS/StoaChain/daimons/StoaWallet && <cmd>'
```

## Wave 1

- [x] T1: Add a pure `buildCodexExport(input, deps)` that turns vault wallets +
      pure keypairs into the Codex export object — `version: '1.2'`,
      `kadenaWallets[]` (`id`, `name`, `seedType`, `secret`, `accounts[]` of
      `{index, publicKey, derivationPath}`), `pureKeypairs[]` (`id`, `label`,
      `publicKey`, `encryptedPrivateKey`) — re-sealing each secret through an
      injected `reseal` seam and reporting one progress tick per seed and per
      key against a total covering both — done when: `pnpm exec vitest run
      packages/core/src/codex/__tests__/buildCodexExport.test.ts` passes with
      tests proving (a) the emitted object carries NO plaintext mnemonic or
      private key anywhere in its JSON, (b) every seed and key is re-sealed
      through `reseal` exactly once, (c) progress ticks once per item and ends
      exactly at the total, (d) a vault with no wallets produces no export.
  - files: `packages/core/src/codex/buildCodexExport.ts`,
    `packages/core/src/codex/index.ts`,
    `packages/core/src/codex/__tests__/buildCodexExport.test.ts`

## Wave 2 (depends on Wave 1)

- [x] T2: Add `KeyringManager.exportCodex(exportPassword, onProgress?)` that
      requires an unlocked wallet (throwing `WalletLockedError` otherwise),
      decrypts every seed phrase and pure private key at the WALLET password,
      re-seals them at the EXPORT password via `smartEncrypt(..., '2')`, and
      returns the export JSON string — done when: `pnpm exec vitest run
      packages/core/src/keyring/__tests__/KeyringManager.exportCodex.test.ts`
      passes with tests proving (a) a locked manager throws `WalletLockedError`
      and produces nothing, (b) the exported JSON round-trips: feeding it to
      `onboardFromCodex` on a FRESH manager at the export password reproduces
      the same seed mnemonics and pure keys, (c) the export password differs
      from the wallet password and the wallet password alone cannot open the
      export, (d) progress ticks reach the item total.
  - files: `packages/core/src/keyring/KeyringManager.ts`,
    `packages/core/src/keyring/__tests__/KeyringManager.exportCodex.test.ts`

## Wave 3 (depends on Wave 2)

- [x] T3: Route export through the background so the popup never needs the
      unlocked secret: add an `exportCodex` request (with `progressId`) and an
      `ExportCodexResponse` to `protocol.ts`, a `case 'exportCodex'` in the
      router that rejects when locked and broadcasts `codexProgress` ticks, and
      a `BackgroundKeyVaultProxy.exportCodex(exportPassword, onProgress?)` that
      subscribes to those ticks — mirroring the existing `importCodex` rail —
      done when: `pnpm exec vitest run apps/extension/src/__tests__` passes and
      `pnpm exec tsc --noEmit -p apps/extension` is clean, with a test proving
      the proxy forwards the export password and surfaces a `locked` refusal.
  - files: `apps/extension/src/messaging/protocol.ts`,
    `apps/extension/src/background/router.ts`,
    `apps/extension/src/popup/BackgroundKeyVaultProxy.ts`,
    `apps/extension/src/__tests__/exportCodex.protocol.test.ts`

## Wave 4 (depends on Wave 3)

- [x] T4: Surface export in the UI: `WalletContext.exportCodex(walletPassword,
      exportPassword, onProgress?)` routing to the remote vault when present and
      the local manager otherwise, and an `ExportWalletPanel` in the Advanced tab
      that takes the wallet password + an export password with confirmation,
      shows the determinate progress bar, and hands the user the file via a Blob
      `<a download>` named `stoawallet-codex-<date>.json` — done when: `pnpm
      exec vitest run packages/ui/src/advanced/__tests__/ExportWalletPanel.test.tsx`
      passes with tests proving (a) the panel refuses to submit until both
      export passwords match, (b) a successful export triggers a download whose
      filename matches that pattern, (c) a wrong wallet password surfaces an
      error and produces no download.
  - files: `packages/ui/src/context/WalletContext.tsx`,
    `packages/ui/src/advanced/ExportWalletPanel.tsx`,
    `packages/ui/src/advanced/AdvancedTab.tsx`,
    `packages/ui/src/advanced/AdvancedTab.module.css`,
    `packages/ui/src/advanced/__tests__/ExportWalletPanel.test.tsx`

## Gate (AC9)

- [x] T5: Confirm the topic did not regress the store package — done when `pnpm
      test` in `apps/extension` reports the 32 store-readiness/manifest tests
      passing and `pnpm run build:ext` completes with `dist/manifest.json`
      emitted.
  - files: none (verification only)
