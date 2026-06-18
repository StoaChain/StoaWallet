import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  InMemoryKeyVault,
  InMemoryStorageAdapter,
} from '@stoawallet/core/testing';
import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WalletProvider } from '../../context/WalletContext';
import { WalletApp } from '../WalletApp';

/**
 * The redesigned shell: a floating BOTTOM nav with exactly 5 destinations —
 * Stoa · UrStoa · Fiat-Ramp · Advanced · Settings. The body renders the active
 * destination above the bar; Stoa is the default. UrStoa and Advanced are
 * placeholders this increment (rebuilt in increments 2 and 4); Fiat-Ramp is a
 * coming-soon panel; Settings renders the real NodeSettings.
 */

const PASSWORD = 'correct horse battery staple';
const MNEMONIC =
  'flat portion other shield engine fly original desert network riot shop own evidence august belt steel into embody bounce parrot naive cruel word gown';

async function seedWallet(
  storage: InMemoryStorageAdapter,
  keyVault: InMemoryKeyVault,
) {
  const { KeyringManager } = await import('@stoawallet/core');
  const manager = new KeyringManager({ storage, keyVault });
  await manager.importWallet(MNEMONIC, PASSWORD);
  await manager.lock();
}

async function renderUnlocked() {
  const storage = new InMemoryStorageAdapter();
  const keyVault = new InMemoryKeyVault();
  await seedWallet(storage, keyVault);

  render(
    <WalletProvider storage={storage} keyVault={keyVault}>
      <WalletApp />
    </WalletProvider>,
  );

  const input = (await screen.findByLabelText(/password/i, {
    selector: 'input',
  })) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, PASSWORD);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    screen.getByRole('button', { name: /^unlock$/i }).click();
  });
  await screen.findByRole('tab', { name: /^stoa$/i });
}

function navTab(name: RegExp) {
  return screen.getByRole('tab', { name });
}

describe('WalletApp — floating bottom nav', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders exactly the 5 bottom-nav destinations', async () => {
    await renderUnlocked();
    const tabs = screen.getAllByRole('tab');
    const labels = tabs.map((t) => t.textContent ?? '');
    // The five named destinations are present and there are exactly five.
    expect(tabs).toHaveLength(5);
    expect(labels.some((l) => /stoa/i.test(l) && !/urstoa/i.test(l))).toBe(true);
    expect(labels.some((l) => /urstoa/i.test(l))).toBe(true);
    expect(labels.some((l) => /fiat/i.test(l))).toBe(true);
    expect(labels.some((l) => /advanced/i.test(l))).toBe(true);
    expect(labels.some((l) => /settings/i.test(l))).toBe(true);
  });

  it('defaults to the Stoa destination (the dual-balance home)', async () => {
    await renderUnlocked();
    // Stoa is the default body: the all-chain balance hero renders without any
    // nav interaction.
    expect(await screen.findByTestId('stoa-tab')).toBeInTheDocument();
    expect(navTab(/^stoa$/i)).toHaveAttribute('aria-selected', 'true');
  });

  it('routes the body to Fiat-Ramp coming-soon when its nav button is selected', async () => {
    await renderUnlocked();
    await act(async () => {
      navTab(/fiat/i).click();
    });
    expect(screen.queryByTestId('stoa-tab')).toBeNull();
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('routes the body to the Advanced tab (account & seed management) when selected', async () => {
    await renderUnlocked();
    await act(async () => {
      navTab(/advanced/i).click();
    });
    expect(screen.queryByTestId('stoa-tab')).toBeNull();
    expect(screen.getByTestId('advanced-tab')).toBeInTheDocument();
  });

  it('routes the body to the real NodeSettings when Settings is selected', async () => {
    await renderUnlocked();
    await act(async () => {
      navTab(/settings/i).click();
    });
    // The real settings surface renders its node-endpoint selector heading.
    expect(
      await screen.findByRole('heading', { name: /node/i }),
    ).toBeInTheDocument();
  });

  it('keeps the header brand and Lock, and shows the active account in the balance card', async () => {
    await renderUnlocked();
    expect(screen.getByText(/stoawallet/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^lock$/i }),
    ).toBeInTheDocument();
    // The active account now lives in the Stoa balance card's account line (it
    // moved out of the header into the card; the AccountSwitcher add control was
    // removed — it returns in a later increment).
    expect(await screen.findByTestId('card-account')).toBeInTheDocument();
  });

  it('uses the ❖ gold glyph for Stoa and the ✦ silver glyph for UrStoa in the nav', async () => {
    await renderUnlocked();
    // The brand identity carries into the nav: Stoa's nav icon is the gold ❖
    // mark and UrStoa's is the silver ✦ mark (the other three keep inline SVGs).
    const stoaTab = navTab(/^stoa$/i);
    const urstoaTab = navTab(/urstoa/i);
    expect(stoaTab.textContent).toContain('❖');
    expect(urstoaTab.textContent).toContain('✦');
  });
});

/**
 * Bottom-nav ANCHORING layout contract (asserted on the module-CSS source, since
 * jsdom does not apply CSS-module rules to computed layout). The bug this guards:
 * with `position: sticky; bottom: 12px` in a `min-height:100%` shell the nav
 * landed at the END of the content on tabs taller/shorter than the popup instead
 * of the popup's bottom edge. The fix pins it as a normal-flow flex child after
 * the `flex:1` body inside a fixed-height, non-scrolling shell.
 */
describe('WalletApp — bottom-nav anchoring (module CSS contract)', () => {
  const CSS_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'WalletApp.module.css',
  );
  const css = readFileSync(CSS_PATH, 'utf8');

  /** Extract a single rule block's body by its leading selector. */
  function ruleBody(selector: string): string {
    const m = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
    return m?.[1] ?? '';
  }

  it('pins the bottom nav as a flex child, never position:sticky (would float mid-content)', () => {
    const nav = ruleBody('.bottomNav');
    // A sticky nav reattaches to the scroll edge of the body — on a tall/short tab
    // that is NOT the popup's bottom edge. The fix makes it a non-shrinking flow
    // child so it always sits at the bottom after the flex:1 body.
    expect(nav).not.toMatch(/position\s*:\s*sticky/);
    expect(nav).toMatch(/flex-shrink\s*:\s*0/);
  });

  it('fills the fixed-height surface with a non-scrolling shell so the body is the only scroll region', () => {
    const shell = ruleBody('.shell');
    // height:100% (not min-height) makes the shell exactly fill the fixed popup /
    // side-panel surface; overflow:hidden keeps the shell itself from scrolling so
    // only .body scrolls and the nav stays pinned.
    expect(shell).toMatch(/height\s*:\s*100%/);
    expect(shell).not.toMatch(/min-height\s*:\s*100%/);
    expect(shell).toMatch(/overflow\s*:\s*hidden/);
  });

  it('drops the 88px bottom-padding overlay hack now the nav no longer overlays the body', () => {
    const body = ruleBody('.body');
    // The nav is a sibling, not an overlay, so the body needs no 88px clearance.
    expect(body).toMatch(/flex\s*:\s*1/);
    expect(body).not.toMatch(/88px/);
  });
});
