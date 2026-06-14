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
const config = {
    appId: 'com.stoachain.wallet',
    appName: 'StoaWallet',
    webDir: MOBILE_WEB_DIR,
    plugins: {
        // Bind biometric unlock to the CURRENT enrolled set: if the user adds or
        // removes a fingerprint/face, the stored credential is invalidated and the
        // wallet falls back to the seed passphrase. Without this an attacker who
        // enrolls their own biometric could unlock the vault.
        BiometricAuth: {
            androidBiometricStrength: 'strong',
            allowDeviceCredential: false,
        },
    },
};
export default config;
//# sourceMappingURL=capacitor.config.js.map