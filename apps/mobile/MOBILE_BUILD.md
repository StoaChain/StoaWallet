# StoaWallet — Mobile (Capacitor) build & native scaffolding

The mobile app wraps the **same** `packages/ui` React UI as the Chrome extension
inside a native Android/iOS WebView via Capacitor. It is **not** a rewrite — the
web bundle Vite produces is copied verbatim into the native shells.

## Identity (immutable)

| Field    | Value                  | Why it cannot change |
| -------- | ---------------------- | -------------------- |
| `appId`  | `com.stoachain.wallet` | Becomes the Android `applicationId` / iOS bundle identifier. Keys app signing and store-upgrade identity — changing it after publish orphans the install base. |
| `appName`| `StoaWallet`           | Display name. |
| `webDir` | `dist-web`             | The directory Capacitor copies into the native shells. Declared once in `webDir.ts` as `MOBILE_WEB_DIR` and consumed by **both** `capacitor.config.ts` (`webDir`) and `vite.config.ts` (`build.outDir`) so they can never drift. |

## Pinned plugin set (Capacitor 8.x — exact, no carets)

| Plugin | Version | Role |
| ------ | ------- | ---- |
| `@capacitor/core` | `8.4.0` | Runtime bridge |
| `@capacitor/cli` (dev) | `8.4.0` | `cap` CLI |
| `@capacitor/android` (dev) | `8.4.0` | Android platform |
| `@capacitor/ios` (dev) | `8.4.0` | iOS platform |
| `@capacitor/app` | `8.1.0` | App lifecycle (background/foreground → auto-lock) |
| `capacitor-secure-storage-plugin` | `0.13.0` | Vault blob in Android Keystore / iOS Keychain (NOT `@capacitor/preferences` — that is not for secrets) |
| `@aparajita/capacitor-biometric-auth` | `10.0.0` | Biometric unlock (STRONG class). NOTE: does NOT provide a current-set binding on its own — see the release-blocker note below |
| `@capacitor-mlkit/barcode-scanning` | `8.1.0` | QR address scanning (official MLKit plugin) |

> **🚫 RELEASE BLOCKER — biometric current-set binding (do NOT ship without it):**
> Biometric unlock MUST NOT ship to production until the sealed secure item is
> bound to the **current enrolled biometric set at the native layer**. The
> shipped code enforces only a SOFTWARE biometry-**type** check (in
> `CapacitorBiometricUnlock.ts`): it snapshots the biometry TYPE category
> (`biometryType`/`biometryTypes`) at enable-time and re-checks it on unlock, so
> it trips ONLY on a type change (fingerprint↔face) or total loss of enrollment.
> It **cannot** detect an attacker **adding their own same-type fingerprint** —
> the realistic local-attacker scenario — so it is **defense-in-depth only, NOT a
> true current-set guarantee.**
>
> `@aparajita/capacitor-biometric-auth` performs biometric **authentication** but
> does not store the credential blob, and `capacitor-secure-storage-plugin`
> (which does) cannot express the native access-control flags that bind a stored
> item to the current set:
>   - iOS: `kSecAccessControlBiometryCurrentSet`
>   - Android: `setUserAuthenticationRequired(true)` +
>     `setInvalidatedByBiometricEnrollment(true)` (STRONG biometric class)
>
> Closing this requires replacing/extending the secure-storage layer with one
> that sets those flags AND verifying the binding on-device. Until that lands and
> is verified, biometric unlock is a **non-shippable** feature. (In practice this
> gap stays invisible to users because the ENABLE affordance is not built until
> Phase 10 Settings — see FIX 3 note below — so `isAvailable()` returns false and
> the button stays hidden.)

## Biometric unlock — reachability & revocation gaps (read before shipping biometrics)

Two deliberate gaps in the biometric feature, both made explicit so neither is a
silent dead path:

1. **ENABLE affordance — deferred to Phase 10 Settings.** The opt-in that calls
   `enableBiometric(currentPassword)` belongs in the Settings screen, which is not
   yet built. Until it lands, no password is ever sealed, so
   `CapacitorBiometricUnlock.isAvailable()` returns `false` and the UnlockScreen
   biometric button stays hidden. The biometric feature is therefore **not
   end-to-end reachable today** — do not advertise it as shipping until Phase 10.

2. **`clearBiometric()` — revocation hook not yet wired (no host flow exists).**
   `clearBiometric()` MUST be invoked from the wallet-**reset** and
   password-**change** flows so the sealed password is revoked when the vault is
   re-keyed (RR#2) — otherwise a stale biometric secret could unlock a changed
   vault. Those flows do **not** exist in the codebase yet (there is no
   `resetWallet` / `changePassword` action in `KeyringManager` or `WalletContext`).
   **When they land, call `biometric.clearBiometric()` from each** (or pass a
   callback through the mobile entry that the reset/password-change action
   invokes). The contract is pinned in
   `src/biometric/__tests__/clearBiometricContract.test.ts`; update it to drive the
   real flow once it exists.

   See also the **release-blocker** note above: even with enable + revocation
   wired, biometric unlock cannot ship until the native current-set ACL backs the
   sealed item.

## Toolchain prerequisites (NOT available in CI here)

The web build (`build:web`) runs anywhere Node runs. Generating and building the
**native** projects requires a full mobile toolchain that is absent from this
workspace (Windows, no Android SDK / Gradle-compatible JDK, no Xcode):

- **Android:** JDK 21, Android SDK (API 34+), Gradle (provided by the generated
  wrapper). Set `ANDROID_HOME`.
- **iOS:** macOS + Xcode 15+, CocoaPods.

`npx cap add android` / `npx cap add ios` and the Gradle/`xcodebuild` artifact
builds therefore **cannot run here** and are documented below for a host that
has the toolchain.

## Build & regeneration commands

```bash
# 1. Build the WebView bundle into dist-web/ (the Capacitor webDir).
pnpm --filter @stoawallet/mobile build:web

# 2. (Once, on a host with the SDK/Xcode) generate the native projects.
#    These land in apps/mobile/android and apps/mobile/ios — both gitignored;
#    they are regenerable and must NOT be committed or hand-edited.
cd apps/mobile
npx cap add android
npx cap add ios

# 3. Copy the web bundle + plugin native code into the native projects.
pnpm --filter @stoawallet/mobile cap:sync     # == npx cap sync

# 4. Inject native permissions (re-runnable, idempotent). Run AFTER every
#    `cap add` and after any `cap sync` that regenerated the native manifests.
pnpm --filter @stoawallet/mobile permissions:inject

# 5. Open in the native IDE to build/run the signed artifact.
npx cap open android   # Android Studio
npx cap open ios       # Xcode
```

## Release pipeline (named scripts — the only valid order)

The release sequence is encoded as named scripts in `apps/mobile/package.json`
so a host WITH the toolchain runs it straight from the package, and so the order
can never be improvised. `build:web` is the only step that runs in THIS
workspace; `sync`, `build:android`, and `build:ios` require the native toolchain
(see prerequisites above) and are toolchain-gated — the scripts exist and document
their prerequisite even where the toolchain is absent.

| Step | Script | Command | Runs here? | Produces |
| ---- | ------ | ------- | ---------- | -------- |
| 1 | `build:web` | `vite build` | Yes | `dist-web/` WebView bundle (the Capacitor `webDir`) |
| 2 | `sync` | `cap sync` | No (needs native projects) | Copies `webDir` + plugin native code into `android/` + `ios/` |
| 3 | `build:android` | `gradlew assembleDebug` → `gradlew bundleRelease` | No (needs Android SDK + JDK 21) | debug `.apk` + store `.aab` |
| 4 | `build:ios` | `xcodebuild ... archive` → `xcodebuild -exportArchive` | No (needs macOS + Xcode) | signed `.ipa` |

Strict order: **`build:web` → `sync` → `build:android` / `build:ios`.** Running
`sync` before `build:web` ships a stale or empty shell; running a native build
before `sync` ships the previous bundle.

```bash
pnpm --filter @stoawallet/mobile build:web      # 1
pnpm --filter @stoawallet/mobile sync           # 2  (== cap sync)
pnpm --filter @stoawallet/mobile build:android  # 3  (Android SDK + JDK 21)
pnpm --filter @stoawallet/mobile build:ios      # 4  (macOS + Xcode)
```

### Android artifacts — `.aab` vs `.apk`

| Artifact | Script step | Use |
| -------- | ----------- | --- |
| `.aab` (Android App Bundle) | `gradlew bundleRelease` | The **Play Store** upload format. Google re-signs per-device APKs from it; this is the publish artifact. |
| `.apk` (Android Package) | `gradlew assembleDebug` | Sideload / direct-install for **test** distribution (QA, internal devices). NOT the Play Store format. |

### iOS artifact

`xcodebuild ... archive` produces an `.xcarchive`; `xcodebuild -exportArchive`
with an `exportOptions.plist` exports the signed `.ipa` for App Store / TestFlight.

## Native permission injection (re-runnable — never hand-edit native files)

Because `cap add`/`cap sync` regenerate the native manifests, the
`AndroidManifest.xml` and iOS `Info.plist` are **not** a source of truth.
`scripts/injectPermissions.mjs` is — it idempotently injects, and is safe to
re-run:

| Platform | Injected | For |
| -------- | -------- | --- |
| Android  | `<uses-permission android:name="android.permission.CAMERA"/>` + `<uses-feature android:name="android.hardware.camera" android:required="false"/>` | Barcode/QR scanning |
| iOS      | `NSCameraUsageDescription` (non-empty copy) | Barcode/QR scanning |
| iOS      | `NSFaceIDUsageDescription` (non-empty copy) | Biometric unlock |

Notes:
- Android biometric needs no manifest permission on API 28+; the biometric
  plugin declares `USE_BIOMETRIC` itself.
- `capacitor-secure-storage-plugin` needs no extra permission — the Android
  Keystore / iOS Keychain require none.
- The biometric plugin's `BiometricAuth` config block (strong strength, no
  device-credential fallback) is declared in `capacitor.config.ts` and applied
  by `cap sync`.

The pure injection transform is unit-tested in
`src/__tests__/capacitorBuild.test.ts` (idempotency + non-empty iOS copy).

## Signing — where credentials plug in (referenced, NEVER committed)

Signing/provisioning is **out of CI scope**: the pipeline STRUCTURE is defined
here so a release is reproducible by someone WITH the credentials, without any
credential ever living in the repo. The native projects (`android/`, `ios/`) are
gitignored and regenerated, so signing config is referenced by an
**untracked, host-local** file that the regenerated project reads.

### Android signing plug-in point

`build:android`'s `bundleRelease` produces a **signed** `.aab` only when the
generated `android/app/build.gradle` declares a `signingConfigs` block whose
`release` config reads from a **`keystore.properties`** file. That file is
host-local and **gitignored** (never committed):

```properties
# apps/mobile/android/keystore.properties  (gitignored — provide on the release host)
storeFile=/abs/path/to/upload.keystore
storePassword=…
keyAlias=upload
keyPassword=…
```

`android/app/build.gradle` (in the regenerated, gitignored native project) wires it:

```gradle
def keystoreProps = new Properties()
def keystoreFile = rootProject.file("keystore.properties")
if (keystoreFile.exists()) { keystoreProps.load(new FileInputStream(keystoreFile)) }
android {
  signingConfigs {
    release {
      storeFile file(keystoreProps['storeFile'])
      storePassword keystoreProps['storePassword']
      keyAlias keystoreProps['keyAlias']
      keyPassword keystoreProps['keyPassword']
    }
  }
  buildTypes { release { signingConfig signingConfigs.release } }
}
```

The release host supplies `keystore.properties` + the `*.keystore`/`*.jks` it
points at; neither is in the repo.

### iOS signing plug-in point

`build:ios` signs through **Xcode signing** (Signing & Capabilities → team +
distribution certificate + provisioning profile, managed in the Apple Developer
account, NOT in the repo). The `-exportArchive` step reads an
**`exportOptions.plist`** that names the signing method/team:

```xml
<!-- exportOptions.plist  (gitignored — provide on the macOS release host) -->
<dict>
  <key>method</key><string>app-store</string>
  <key>teamID</key><string>YOUR_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
```

The signing certificate (`*.p12`) and provisioning profile (`*.mobileprovision`)
live in the macOS keychain / Apple Developer account, never in the repo.

## Secrets — never commit

`.gitignore` excludes keystores (`*.keystore`, `*.jks`), iOS certs (`*.p12`),
provisioning profiles (`*.mobileprovision`), `keystore.properties`,
`exportOptions.plist`, the generated `android/`+`ios/` projects, and the
`dist-web/` build output. Signing material is **referenced, NOT committed** — a
single leaked keystore or provisioning profile is an irreversible credential
compromise. Never log or commit signing material. A test
(`src/__tests__/nativeBuildPipeline.test.ts`) scans the tracked tree and fails
if any keystore / `.jks` / `.p12` / `.mobileprovision` / `keystore.properties`
is committed.
```
