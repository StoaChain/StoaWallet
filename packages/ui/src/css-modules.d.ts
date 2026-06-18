/// <reference path="../node_modules/@testing-library/jest-dom/types/vitest.d.ts" />

/**
 * Ambient declaration so TypeScript resolves CSS Module imports
 * (`import styles from './X.module.css'`) to a class-name lookup map. Vite/
 * Vitest perform the real transform at build/test time; this only satisfies the
 * type checker.
 *
 * The reference above pulls in jest-dom's matcher augmentation so `tsc` sees
 * `toBeInTheDocument`, `toBeDisabled`, etc. on Vitest's `expect`. The runtime
 * registration lives in `vitest.setup.ts`, which sits outside `src/` and is
 * therefore never compiled by this project's tsconfig.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

/**
 * Side-effect import of a GLOBAL stylesheet (`import './theme.css'`). It has no
 * named/default export — importing it only injects the rules. Vite/Vitest handle
 * the real transform; this satisfies `tsc`.
 */
declare module '*.css';

/**
 * Static image imports (`import logoUrl from './logo.png'`). Vite/Vitest resolve
 * the asset to a bundled URL string at build/test time; the brand logo on the
 * unlock/onboarding splash is loaded this way so it works identically in the
 * popup, expand tab, side panel, and the Capacitor mobile wrap. This declaration
 * only satisfies the type checker — the real URL is produced by the bundler.
 */
declare module '*.png' {
  const url: string;
  export default url;
}
