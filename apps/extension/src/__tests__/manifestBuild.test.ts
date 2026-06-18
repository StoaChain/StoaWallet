import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Store-readiness build validation for the MV3 @crxjs production emit.
 *
 * A clean `vite build` exit code alone does not prove the SHIPPED artifact is a
 * valid, least-privilege, wallet-class MV3 extension. This suite production-
 * builds the extension once, then asserts on the EMITTED `dist/` so the things
 * a Chrome Web Store reviewer (and the human installing an unpacked dev build)
 * actually load are verified: a parseable manifest at version 3, a strict CSP
 * with no remote/eval, exactly the two RPC hosts the wallet talks to, the
 * storage+idle permissions the auto-lock needs, a resolved popup document with
 * its script, a module service-worker bundle, and every referenced icon file.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const DIST = path.join(APP_ROOT, 'dist');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');

interface Manifest {
  manifest_version: number;
  name: string;
  version: string;
  description?: string;
  action?: { default_popup?: string };
  background?: { service_worker?: string; type?: string };
  icons?: Record<string, string>;
  permissions?: string[];
  host_permissions?: string[];
  content_security_policy?: { extension_pages?: string };
  content_scripts?: unknown;
  externally_connectable?: unknown;
}

let manifest: Manifest;
let manifestRaw: string;

function distPath(rel: string): string {
  return path.join(DIST, rel.replace(/^\/+/, ''));
}

beforeAll(() => {
  rmSync(DIST, { recursive: true, force: true });
  // Build through the workspace filter so the real shipped pipeline runs.
  execFileSync('pnpm', ['--filter', '@stoawallet/extension', 'build:ext'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  manifestRaw = readFileSync(path.join(DIST, 'manifest.json'), 'utf8');
  manifest = JSON.parse(manifestRaw) as Manifest;
}, 320_000);

describe('MV3 manifest production emit', () => {
  it('emits a JSON-parseable manifest declaring MV3 so Chrome loads it as a v3 extension', () => {
    expect(() => JSON.parse(manifestRaw)).not.toThrow();
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('StoaWallet');
    expect(manifest.version).toMatch(/^\d+\.\d+/);
    expect(typeof manifest.description).toBe('string');
    expect(manifest.description!.length).toBeGreaterThan(0);
  });

  it('declares a wallet-class CSP with no remote script and no unsafe-eval, so injected/remote code cannot run', () => {
    const csp = manifest.content_security_policy?.extension_pages ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(csp).not.toMatch(/unsafe-inline/);
    expect(csp).not.toMatch(/https?:\/\//);
  });

  it('requests EXACTLY the two StoaChain RPC hosts and never a broad wildcard, enforcing least privilege', () => {
    expect(manifest.host_permissions).toEqual([
      'https://node1.stoachain.com/*',
      'https://node2.stoachain.com/*',
    ]);
    const joined = (manifest.host_permissions ?? []).join(' ');
    expect(joined).not.toContain('<all_urls>');
    expect(joined).not.toContain('*://*/*');
  });

  it('requests only storage, idle and sidePanel permissions (idle drives the auto-lock; sidePanel opens the docked wallet panel), never tabs/scripting/webRequest', () => {
    const perms = manifest.permissions ?? [];
    // The least-privilege trio: storage (vault), idle (auto-lock), sidePanel (the
    // wallet's own docked panel — grants no page read/inject). Exact-equality so a
    // silently-added permission would fail here.
    expect([...perms].sort()).toEqual(['idle', 'sidePanel', 'storage']);
    for (const dangerous of ['tabs', 'scripting', 'webRequest', 'webRequestBlocking']) {
      expect(perms).not.toContain(dangerous);
    }
  });

  it('wires the dApp bridge as a scoped MAIN+ISOLATED content-script pair, with externally_connectable still absent', () => {
    // The dApp surface arrived (Phase 9): a MAIN-world inpage provider + an
    // ISOLATED relay, both document_start and scoped to the StoaChain allow-list.
    const scripts = (manifest.content_scripts as Array<Record<string, unknown>>) ?? [];
    expect(scripts.length).toBeGreaterThanOrEqual(2);
    expect(scripts.some((s) => s.world === 'MAIN')).toBe(true);
    expect(scripts.some((s) => s.world !== 'MAIN')).toBe(true);
    for (const s of scripts) {
      expect(s.matches).toEqual(['https://*.stoachain.com/*']);
      expect(s.run_at).toBe('document_start');
    }
    // RR#8: the page still reaches the SW only via the relay hop, never directly.
    expect(manifest.externally_connectable).toBeUndefined();
    // RR#4: @crxjs's content-script loader requires the chunk be web-accessible,
    // but the entry is SCOPED to the StoaChain dApp allow-list — never <all_urls>.
    const war = JSON.stringify(
      (manifest as unknown as Record<string, unknown>).web_accessible_resources ?? [],
    );
    expect(war).not.toContain('<all_urls>');
    expect(war).not.toContain('*://*/*');
  });

  it('points the popup action at a built HTML document whose script chunk also exists', () => {
    const popup = manifest.action?.default_popup;
    expect(popup).toBeDefined();
    const popupHtmlPath = distPath(popup!);
    expect(existsSync(popupHtmlPath)).toBe(true);
    const html = readFileSync(popupHtmlPath, 'utf8');
    const scriptSrc = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
    expect(scriptSrc, 'popup HTML must reference a built script').toBeDefined();
    expect(existsSync(distPath(scriptSrc!))).toBe(true);
  });

  it('emits a module service worker whose bundle file exists, so the background context boots', () => {
    expect(manifest.background?.type).toBe('module');
    const sw = manifest.background?.service_worker;
    expect(sw).toBeDefined();
    expect(existsSync(distPath(sw!))).toBe(true);
  });

  it('emits every referenced icon size as a real file so the store-readiness check passes', () => {
    const icons = manifest.icons ?? {};
    expect(Object.keys(icons).map(Number).sort((a, b) => a - b)).toEqual([16, 32, 48, 128]);
    for (const rel of Object.values(icons)) {
      const iconPath = distPath(rel);
      expect(existsSync(iconPath), `icon ${rel} must exist in dist`).toBe(true);
      // Real PNG signature — not a zero-byte or placeholder text file.
      const head = readFileSync(iconPath).subarray(0, 8);
      expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
  });
});
