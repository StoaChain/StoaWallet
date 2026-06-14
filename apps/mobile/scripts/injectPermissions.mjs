// Re-runnable native permission injector (RR#9).
//
// `npx cap add android` / `cap add ios` GENERATE the native projects, and any
// later `cap sync`/`cap copy` can regenerate parts of them — so the native
// AndroidManifest.xml and iOS Info.plist must NEVER be hand-edited as a source
// of truth. This script is the source of truth instead: it idempotently injects
// every native permission the wallet's Capacitor plugins require, and is safe to
// re-run after every `cap add`/`cap sync`.
//
// Injected permissions and WHY:
//   - CAMERA (Android) + camera hardware feature + NSCameraUsageDescription
//     (iOS): @capacitor-mlkit/barcode-scanning opens the camera to scan a
//     recipient address QR.
//   - NSFaceIDUsageDescription (iOS): @aparajita/capacitor-biometric-auth uses
//     Face ID to gate wallet unlock. (Android biometric needs no manifest
//     permission on API 28+; the plugin declares USE_BIOMETRIC itself.)
//   - capacitor-secure-storage-plugin needs no extra manifest permission — it
//     uses the Android Keystore / iOS Keychain, which are available without a
//     declared permission.
//
// The mechanism is two pure string transforms (one per platform) plus a thin
// file-walking CLI. The pure transforms are unit-tested; the CLI is the
// documented post-`cap add` patch step (`pnpm --filter @stoawallet/mobile
// permissions:inject`).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ANDROID_CAMERA_PERMISSION =
  '<uses-permission android:name="android.permission.CAMERA" />';
// The barcode scanner uses the camera; declaring the feature as not-required
// keeps the app installable on camera-less devices while letting the Play Store
// surface it correctly.
const ANDROID_CAMERA_FEATURE =
  '<uses-feature android:name="android.hardware.camera" android:required="false" />';

const IOS_CAMERA_KEY = 'NSCameraUsageDescription';
const IOS_CAMERA_COPY =
  'StoaWallet uses the camera to scan a recipient address QR code when you send Stoa Coin.';
const IOS_FACEID_KEY = 'NSFaceIDUsageDescription';
const IOS_FACEID_COPY =
  'StoaWallet uses Face ID to unlock your wallet without re-entering your seed passphrase.';

function injectAndroid(source) {
  let out = source;
  // Insert the <uses-permission>/<uses-feature> as direct children of <manifest>,
  // immediately after the opening <manifest ...> tag — but only if absent, so
  // re-running never duplicates them.
  const manifestOpen = out.match(/<manifest\b[^>]*>/);
  if (manifestOpen == null) {
    throw new Error('injectAndroid: no <manifest> element found in source');
  }
  const insertAt = manifestOpen.index + manifestOpen[0].length;
  const additions = [];
  if (!out.includes('android.permission.CAMERA')) {
    additions.push(ANDROID_CAMERA_PERMISSION);
  }
  if (!out.includes('android.hardware.camera')) {
    additions.push(ANDROID_CAMERA_FEATURE);
  }
  if (additions.length === 0) {
    return out;
  }
  const block = `\n    ${additions.join('\n    ')}`;
  out = out.slice(0, insertAt) + block + out.slice(insertAt);
  return out;
}

function injectIos(source) {
  let out = source;
  const dictOpen = out.indexOf('<dict>');
  if (dictOpen === -1) {
    throw new Error('injectIos: no <dict> element found in Info.plist source');
  }
  const insertAt = dictOpen + '<dict>'.length;
  const entries = [];
  if (!out.includes(IOS_CAMERA_KEY)) {
    entries.push(`<key>${IOS_CAMERA_KEY}</key>\n\t<string>${IOS_CAMERA_COPY}</string>`);
  }
  if (!out.includes(IOS_FACEID_KEY)) {
    entries.push(`<key>${IOS_FACEID_KEY}</key>\n\t<string>${IOS_FACEID_COPY}</string>`);
  }
  if (entries.length === 0) {
    return out;
  }
  const block = `\n\t${entries.join('\n\t')}`;
  out = out.slice(0, insertAt) + block + out.slice(insertAt);
  return out;
}

/**
 * Pure, idempotent permission injector. Given a platform and the current
 * manifest/plist XML, returns the XML with every required permission present
 * exactly once. Re-running on its own output is a no-op.
 *
 * @param {{ platform: 'android' | 'ios', source: string }} args
 * @returns {string}
 */
export function injectNativePermissions({ platform, source }) {
  if (platform === 'android') {
    return injectAndroid(source);
  }
  if (platform === 'ios') {
    return injectIos(source);
  }
  throw new Error(`injectNativePermissions: unknown platform "${platform}"`);
}

// CLI: patch the generated native projects in place. Run AFTER `cap add` and
// after any `cap sync` that may have regenerated them. Missing native projects
// are skipped with a notice (they only exist once `cap add` has run on a host
// with the Android SDK / Xcode).
function patchFile(filePath, platform) {
  if (!existsSync(filePath)) {
    process.stdout.write(
      `[injectPermissions] skip ${platform}: ${filePath} not found ` +
        `(run "npx cap add ${platform}" first on a host with the SDK)\n`,
    );
    return;
  }
  const before = readFileSync(filePath, 'utf8');
  const after = injectNativePermissions({ platform, source: before });
  if (after !== before) {
    writeFileSync(filePath, after);
    process.stdout.write(`[injectPermissions] patched ${platform}: ${filePath}\n`);
  } else {
    process.stdout.write(`[injectPermissions] ${platform} already current: ${filePath}\n`);
  }
}

function main() {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  patchFile(
    path.join(appRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
    'android',
  );
  patchFile(path.join(appRoot, 'ios', 'App', 'App', 'Info.plist'), 'ios');
}

// Only run the file-walking CLI when invoked directly, not when imported by the
// test for the pure transform.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
