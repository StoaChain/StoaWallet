// Single source of truth for the Capacitor `webDir` (RR#8).
//
// `capacitor.config.ts` declares this as the directory Capacitor copies into the
// native Android/iOS WebView shell, and `vite.config.ts` sets `build.outDir` to
// the SAME value. Exporting one constant guarantees the two can never drift —
// if Capacitor's webDir pointed at a directory Vite never wrote, `cap sync`
// would silently ship a stale or empty bundle.
//
// It is deliberately NOT `dist/`: the package's `tsconfig.json` already emits
// type-check output to `dist/`, so the WebView bundle gets its own directory to
// avoid the two build steps clobbering each other's output.
export const MOBILE_WEB_DIR = 'dist-web';
//# sourceMappingURL=webDir.js.map