/**
 * Ambient declaration so `tsc` resolves a global stylesheet side-effect import
 * (`import './mobile.css'`) inside this app's tsconfig scope. Vite performs the
 * real transform + bundling at build time; this only satisfies the type checker.
 * (packages/ui + apps/extension have their own copies for their stylesheet imports.)
 */
declare module '*.css';
