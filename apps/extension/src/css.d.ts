/**
 * Ambient declaration so `tsc` resolves a global stylesheet side-effect import
 * (`import './popup.css'`) inside this app's tsconfig scope. Vite performs the
 * real transform + bundling at build time; this only satisfies the type checker.
 * (packages/ui has its own copy of this for the shared theme.css import.)
 */
declare module '*.css';
