# StoaWallet — Release & Publishing Runbook

Publisher: **AncientHoldings GmbH**. Three storefronts, one product (the same
`packages/ui` React app): the Chrome MV3 extension, the Android app, and the iOS
app. This is the single entry point; the **native** build mechanics live in
[`apps/mobile/MOBILE_BUILD.md`](apps/mobile/MOBILE_BUILD.md).

> **Launch scope (current decision): Chrome + Android only.** iOS is **deferred
> until the user base justifies Apple's $99/year** recurring membership. The iOS
> path below is kept ready (same UI bundle, `appId` reserved) so it can be turned
> on later with no rework — but it is NOT part of the first launch. Skip the Apple
> account, the Apple steps (§4 iOS), and the iOS checklist items for now.

---

## 0. Accounts the GmbH must create (only you can — they need legal identity + payment)

| Store | Account | Cost | Notes |
| ----- | ------- | ---- | ----- |
| Chrome Web Store | Chrome Web Store **Developer** (a Google account) | **$5** one-time | Register under a company Google account, not a personal one. |
| Google Play (Android) | **Play Console** — *organization* account | **$25** one-time | New org accounts require a **D-U-N-S number**. |
| Apple App Store (iOS) | **Apple Developer Program** — *Organization* enrollment | **$99 / year** | Requires a **D-U-N-S number** + authority to bind the company. **A crypto wallet must be published by an organization, not an individual** (App Store rule 3.1.5(b)). |

> **Start the D-U-N-S number now** — it's free from Dun & Bradstreet but can take
> 1–2 weeks, and it gates both Apple and Google org enrollment. It is the long pole.

Also required by **all three** before submission:
- **Privacy policy at a public URL** — host [`PRIVACY.md`](PRIVACY.md) (e.g. `https://stoachain.com/wallet/privacy`).
- **Support email + homepage URL.**

---

## 1. Pre-launch facts that gate the first publish (read before submitting)

- **`appId` / bundle id = `com.stoachain.wallet` is IMMUTABLE after first publish.**
  It keys Android `applicationId` + iOS bundle identifier + store-upgrade identity.
  The *publisher* shown in the stores is AncientHoldings GmbH (set on the account),
  independent of this id. **Confirm `com.stoachain.wallet` is final before step 3/4.**
- **Biometric unlock is intentionally NOT shipping yet** — there is no enable UI, so
  `isAvailable()` is false and the affordance stays hidden; mobile ships **password
  unlock only**. Do **not** advertise biometrics in any listing. (The native
  current-set ACL is a tracked release-blocker for *enabling* it later — see
  MOBILE_BUILD.md. It does not block launching the password-only wallet.)
- **Fiat Ramp is "coming soon"** — keep listing copy from promising it as live.

---

## 2. Versioning (bump every release, all surfaces together)

- **Extension**: `apps/extension/package.json` `version` → the manifest reads it
  (currently **0.1.0**). Web Store requires the new version > the published one.
- **Mobile**: bump `versionName` (semver) **and** integer `versionCode` (Android) /
  `CFBundleShortVersionString` + `CFBundleVersion` (iOS) in the generated native
  projects each upload — stores reject a re-used build number.

Keep all three in lockstep at the same semver (0.1.0 → 0.1.1 → …).

---

## 3. Publish the Chrome extension

```bash
# 1. Production build — dist/ is self-contained (the local @stoachain/* are bundled).
pnpm -C apps/extension run build:ext

# 2. Zip the CONTENTS of dist/ (not the folder itself).
#    Windows (PowerShell):
Compress-Archive -Path apps/extension/dist/* -DestinationPath stoawallet-0.1.0.zip -Force
#    macOS / Linux:
( cd apps/extension/dist && zip -r ../../../stoawallet-0.1.0.zip . )
```

3. Web Store dashboard → **New item** → upload the zip.
4. Fill the listing (copy in §5), set **privacy practices** (declare it handles
   *authentication info* / *financial info*; it does **not** transmit them), paste
   the **permission justifications** (§5), set the privacy-policy URL.
5. Submit for review. Crypto wallets are allowed; reviews can take days.

**Permissions shipped (already minimal — justifications in §5):** `storage`,
`idle`, `sidePanel`; host access only to `node1`/`node2.stoachain.com`; content
scripts scoped to `*.stoachain.com`; CSP with no `unsafe-eval`/remote code.

---

## 4. Publish Android + iOS

Native build mechanics, signing plug-in points, and permission injection are in
[`apps/mobile/MOBILE_BUILD.md`](apps/mobile/MOBILE_BUILD.md). The **store-side**
steps on top of that:

**Android (Play Console):**
1. Build the **signed `.aab`** (`build:web` → `cap sync` → `gradlew bundleRelease`
   with the host-local `keystore.properties`). Back up the upload keystore — losing
   it is unrecoverable.
2. Create the app, complete the **Data safety** form (keys: stored on-device,
   encrypted, not shared/collected; camera used only for QR), content rating,
   privacy-policy URL.
3. Roll out to **internal testing** first, then production.

**iOS (App Store Connect):**
1. `cap sync` → archive in Xcode → export `.ipa` via `exportOptions.plist` (team +
   distribution cert + App Store provisioning profile, all in the Apple account).
2. Upload → **TestFlight** → submit. Set the bundle id to `com.stoachain.wallet`,
   team to AncientHoldings GmbH.
3. **App Privacy** questionnaire: no data collected/linked; camera for QR only.

---

## 5. Store-listing copy (reuse across stores)

**Name:** StoaWallet
**Subtitle / short:** Self-custody wallet for StoaChain.
**Long description:**
> StoaWallet is a self-custody crypto wallet for StoaChain — a 10-chain braided
> network with ED25519 keys and the native Stoa Coin. Create or import a 24-word
> recovery phrase, hold and send Stoa across all 10 chains, do same-chain and
> cross-chain transfers, and manage UrStoa holdings (transfer, stake, unstake,
> collect). Your keys are generated and stored **only on your device**, encrypted
> with your password — they are never sent to any server. Gas is sponsored on
> supported actions. Import an existing Ouronet Codex to bring your seeds and
> accounts with you. (A Fiat Ramp is coming soon.)

**Single-purpose statement (Chrome):**
> A self-custody wallet for the StoaChain network: manage keys, balances, and
> transactions. It does not collect, transmit, or sell user data.

**Permission justifications (Chrome):**
- `storage` — persist the encrypted wallet vault and user settings locally.
- `idle` — drive the auto-lock timer so the wallet locks when the device is idle.
- `sidePanel` — let the user open the wallet in Chrome's docked side panel.
- host `node1`/`node2.stoachain.com` — submit/read StoaChain transactions (the
  exact RPC nodes; never a wildcard).
- content scripts on `*.stoachain.com` — expose the in-page dApp provider
  (`window.stoa`) to StoaChain dApps only.

**Category:** Productivity (Chrome) / Finance (App Store, Play).

---

## 6. Pre-submit checklist

- [ ] D-U-N-S number issued; Apple + Google org accounts created; Chrome dev account created.
- [ ] Privacy policy hosted at a public URL.
- [ ] Version bumped on all surfaces (extension manifest + native versionCode/build).
- [ ] `pnpm exec vitest run` green; `build:ext` clean; `dist/` has no `_`-prefixed paths.
- [ ] Extension zip uploaded; permissions justified; privacy practices declared.
- [ ] Android `.aab` signed (keystore backed up); Data safety form complete.
- [ ] iOS archive signed; App Privacy questionnaire complete; published as the org.
- [ ] Listings do NOT advertise biometrics or a live Fiat Ramp.
- [ ] `appId com.stoachain.wallet` confirmed final.
