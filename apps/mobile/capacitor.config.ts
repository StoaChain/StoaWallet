import type { CapacitorConfig } from '@capacitor/cli';

import { MOBILE_WEB_DIR } from './webDir';

// Capacitor wrapper config for the Android/iOS shells. The SAME packages/ui
// React app the extension ships runs here inside the native WebView — this file
// only describes how the native shell wraps that bundle, never duplicating UI.
//
// `appId` is IMMUTABLE: it becomes the Android `applicationId` and the iOS
// bundle identifier, which key app signing and store-upgrade identity. Changing
// it after first publish orphans the install base, so it is fixed here and
// asserted in tests.
//
// `webDir` comes from the shared MOBILE_WEB_DIR constant that `vite.config.ts`
// also uses for `build.outDir`; this is the single source of truth that keeps
// `cap sync` copying the directory Vite actually wrote.
const config: CapacitorConfig = {
  appId: 'com.stoachain.wallet',
  appName: 'StoaWallet',
  webDir: MOBILE_WEB_DIR,
  plugins: {
    // Biometric unlock config. NOTE: this block requests STRONG-class biometric
    // auth and disables device-credential fallback, but it does NOT bind the
    // sealed secret to the CURRENT enrolled set — `capacitor-secure-storage-plugin`
    // cannot express `kSecAccessControlBiometryCurrentSet` /
    // `setInvalidatedByBiometricEnrollment(true)`. The app-layer check in
    // CapacitorBiometricUnlock detects a biometry TYPE change (fingerprint↔face /
    // lost enrollment) ONLY; an attacker ADDING their own same-type fingerprint is
    // NOT detected. A true current-set guarantee at the native layer is a RELEASE
    // BLOCKER — see CapacitorBiometricUnlock.ts and MOBILE_BUILD.md.
    BiometricAuth: {
      androidBiometricStrength: 'strong',
      allowDeviceCredential: false,
    },
  },
};

export default config;
