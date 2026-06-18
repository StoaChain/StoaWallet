# StoaWallet

A **self-custody** crypto wallet for **StoaChain** (a Kadena/Chainweb fork: 10
braided chains, Pact 5, ED25519 keys, native "Stoa Coin"). One React UI
(`packages/ui`) shipped two ways — a **Chrome MV3 extension** today, and
**Android/iOS** via a Capacitor wrapper of the *same* UI. Keys are generated and
stored **only on the device**, encrypted with your password; they are never sent
anywhere. Publisher: **AncientHoldings GmbH**.

> Status: feature-complete (Stoa send/receive, same- & cross-chain transfers,
> miner aggregation, UrStoa transfer/stake/unstake/collect, multi-seed + Ouronet
> Codex import). **Fiat Ramp is coming soon.** Not yet on the Chrome Web Store —
> until then, [load it locally](#load-it-in-chrome-unpacked--before-the-store-listing).

## Monorepo layout

| Path | What |
| ---- | ---- |
| `packages/core` | Keyring, 24-word derivation, signing, RPC, crosschain, UrStoa — wraps the local `@stoachain/*` SDK behind a `KeyVault` interface. |
| `packages/ui` | The shared React screens (unlock, balances, send, cross-chain, miner, UrStoa, advanced/codex). |
| `apps/extension` | Vite + @crxjs Chrome MV3 build (popup + background service worker). |
| `apps/mobile` | Capacitor wrapper that runs the same `packages/ui` bundle in Android/iOS. |

## Prerequisites

- **Node ≥ 22.12** and **pnpm**.
- **The sibling `StoaOuronet` repo**, checked out next to this one, because the
  published `@stoachain/*` npm packages are broken — the build uses the **local
  sibling monorepo** instead:

  ```
  <parent>/
    StoaWallet/      ← this repo
    StoaOuronet/     ← sibling (provides @stoachain/* via file: deps)
  ```

  Build the sibling packages once, **in this order** (they depend on each other):
  `kadena-stoic-legacy → stoa-core → ouronet-core → ouronet-codex`
  (in `StoaOuronet/stoa-js/packages/`). Without this, `pnpm install` here can't
  resolve the `file:` dependencies.

## Install, build, test

```bash
pnpm install                              # from the repo root
pnpm exec vitest run                      # full test suite
pnpm -C apps/extension run build:ext      # build the extension → apps/extension/dist
```

The build output `apps/extension/dist/` is git-ignored (it's a build artifact),
so you build it locally before loading it.

## Load it in Chrome (unpacked) — before the store listing

Until StoaWallet is published to the Chrome Web Store, run it as an **unpacked
extension**:

1. **Build it** (produces the loadable folder):
   ```bash
   pnpm -C apps/extension run build:ext
   ```
   This writes the extension to **`apps/extension/dist`**.
2. Open Chrome and go to **`chrome://extensions`**.
3. Turn on **Developer mode** (toggle, top-right).
4. Click **Load unpacked** and select the **`apps/extension/dist`** folder
   (select the folder itself — it contains `manifest.json`).
5. The StoaWallet icon appears in the toolbar — click the puzzle-piece and **pin**
   it for easy access. Click it to open the popup, or use **Open in side panel**.

**After you pull changes or rebuild:** re-run `build:ext`, then click the **reload
↻** icon on the StoaWallet card in `chrome://extensions`. (Chrome does not
auto-reload an unpacked extension when its files change.)

Notes:
- The folder must contain `manifest.json` at its root — that's `dist/`, **not**
  `apps/extension/`.
- If you only have the built `dist` (e.g. it was shared with you), you can skip
  the build and just load that folder in step 4.
- It runs entirely locally and talks only to the StoaChain nodes
  (`node1`/`node2.stoachain.com`) and the read/explorer host — see
  [`PRIVACY.md`](PRIVACY.md).

## Mobile (Android/iOS)

The same UI wraps into native apps via Capacitor. Native builds require the
platform toolchain (Android SDK / Xcode) on your machine — see
[`apps/mobile/MOBILE_BUILD.md`](apps/mobile/MOBILE_BUILD.md).

## Publishing

Store-submission runbook (accounts, D-U-N-S, versioning, Chrome zip, Play/App
Store steps, listing copy, checklist): [`RELEASE.md`](RELEASE.md). Current launch
scope: **Chrome + Android** (iOS deferred).

## Security

Self-custody: your 24-word recovery phrase and keys live encrypted on your device
and are never transmitted. In the extension, decrypted key material stays in the
**background service worker** — never in the popup/page. Your only backup is the
recovery phrase you wrote down (and, for imported seeds, the original Ouronet
Codex file). See [`PRIVACY.md`](PRIVACY.md).
