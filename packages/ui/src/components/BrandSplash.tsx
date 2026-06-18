import { type ReactNode } from 'react';

import logoUrl from '../assets/logo.png';
import styles from './BrandSplash.module.css';

/**
 * The premium brand splash shared by the unlock + onboarding surfaces. It
 * reproduces the StoaChain website hero in pure CSS: a glowing centred logo, a
 * gold-gradient "StoaWallet" wordmark, an optional tagline, and a content slot
 * for the screen-specific heading + form. The gold-orb glow + dark radial scrim
 * background lives ONLY here — it is the splash-only treatment DESIGN.md permits
 * on unlock/onboarding and forbids behind the live wallet tabs, so the live
 * shell never mounts this wrapper.
 *
 * No new dependency: the entrance animation is a CSS @keyframes fade/slide, the
 * glow is a blurred radial, and the logo is a bundler-resolved asset URL — so it
 * renders identically in the extension popup/tab/side-panel and the Capacitor
 * mobile wrap, and touches no `chrome.*`.
 */
export interface BrandSplashProps {
  /**
   * Optional short tagline rendered under the wordmark (the onboarding landing
   * borrows the hero's spirit, e.g. "An economy built to endure"). Omitted on
   * the unlock screen, where the screen's own heading carries the message.
   */
  readonly tagline?: string;
  /** The screen-specific heading + form composed into the splash. */
  readonly children: ReactNode;
}

export function BrandSplash({ tagline, children }: BrandSplashProps): ReactNode {
  return (
    <div className={styles.splash}>
      <div className={styles.orb} aria-hidden="true" />
      <div className={styles.scrim} aria-hidden="true" />

      <div className={styles.column}>
        <div className={styles.logoWrap}>
          <span className={styles.logoGlow} aria-hidden="true" />
          <img className={styles.logo} src={logoUrl} alt="StoaWallet" />
        </div>

        <span className={styles.wordmark}>StoaWallet</span>

        {tagline !== undefined && (
          <p className={styles.tagline}>{tagline}</p>
        )}

        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
