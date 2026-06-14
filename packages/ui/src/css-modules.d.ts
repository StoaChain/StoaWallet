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
