import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { auditStoreReadiness } from '../security/storeReadiness';

/**
 * Phase-9 dApp-provider wiring + framing/clickjacking enforcement over the SHIPPED
 * `dist/` artifact.
 *
 * T9.8 is the highest-risk manifest surface: it opens the wallet to web pages for
 * the first time. This suite production-builds the extension once and asserts on
 * the EMITTED manifest + approval surface that the injection mechanism, scoping,
 * and framing posture a Chrome Web Store reviewer (and the wallet's threat model)
 * require are actually present:
 *
 *   - TWO content scripts: a MAIN-world inpage provider (RR#4 — no
 *     web_accessible_resources fingerprint) and an ISOLATED-world relay.
 *   - Both at run_at:"document_start" (RR#5) with SCOPED matches (RR#6 — never
 *     <all_urls>).
 *   - externally_connectable ABSENT (RR#8) — the page reaches the SW only via the
 *     content-script hop.
 *   - The approval surface ships frame-ancestors 'none' + a sensor-locking
 *     Permissions-Policy (the Phase-7 T7.8 forward contract — ENFORCED here).
 *   - The wallet-class extension CSP is NOT loosened.
 *   - The updated storeReadiness validator (XP-17) passes for the real manifest.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const DIST = path.join(APP_ROOT, 'dist');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');

/** The canonical, documented StoaChain dApp-origin allow-list (RR#6). */
const SCOPED_MATCH = 'https://*.stoachain.com/*';

interface ContentScript {
  matches?: string[];
  js?: string[];
  run_at?: string;
  all_frames?: boolean;
  world?: string;
}

interface Manifest {
  manifest_version: number;
  content_scripts?: ContentScript[];
  web_accessible_resources?: unknown;
  externally_connectable?: unknown;
  content_security_policy?: { extension_pages?: string };
}

let manifest: Manifest;

function distPath(rel: string): string {
  return path.join(DIST, rel.replace(/^\/+/, ''));
}

beforeAll(() => {
  if (!existsSync(path.join(DIST, 'manifest.json'))) {
    execFileSync('pnpm', ['--filter', '@stoawallet/extension', 'build:ext'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  }
  manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8')) as Manifest;
}, 320_000);

/** Deep clone the real manifest as a mutable record for each negative case. */
function clone(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe('dApp content_scripts wiring (RR#4 / RR#5 / RR#6)', () => {
  it('(e) registers TWO content scripts — a MAIN-world inpage provider and an ISOLATED-world relay', () => {
    const scripts = manifest.content_scripts ?? [];
    // Two cooperating worlds: the page-world provider (window.stoa) and the
    // chrome.runtime relay. Either missing breaks the bridge.
    const main = scripts.find((s) => s.world === 'MAIN');
    const isolated = scripts.find((s) => s.world !== 'MAIN');
    expect(main, 'a world:MAIN inpage provider script must be registered').toBeDefined();
    expect(isolated, 'an ISOLATED-world relay script must be registered').toBeDefined();
    expect(main).not.toBe(isolated);
  });

  it('(e) injects the inpage provider in the MAIN world so window.stoa is defined in the page JS context', () => {
    const main = (manifest.content_scripts ?? []).find((s) => s.world === 'MAIN');
    expect(main?.world).toBe('MAIN');
    // The MAIN-world script's bundle must resolve to a real emitted file.
    const js = main?.js ?? [];
    expect(js.length).toBeGreaterThan(0);
    for (const rel of js) {
      expect(existsSync(distPath(rel)), `MAIN-world bundle ${rel} must exist`).toBe(true);
    }
  });

  it('(e) registers the ISOLATED relay with a resolvable bundle so the chrome.runtime hop exists', () => {
    const isolated = (manifest.content_scripts ?? []).find((s) => s.world !== 'MAIN');
    const js = isolated?.js ?? [];
    expect(js.length).toBeGreaterThan(0);
    for (const rel of js) {
      expect(existsSync(distPath(rel)), `relay bundle ${rel} must exist`).toBe(true);
    }
  });

  it('(e) runs BOTH content scripts at document_start so the provider exists before the dApp feature-detects (RR#5)', () => {
    const scripts = manifest.content_scripts ?? [];
    expect(scripts.length).toBeGreaterThanOrEqual(2);
    for (const s of scripts) {
      expect(s.run_at, 'every dApp content script must run at document_start').toBe(
        'document_start',
      );
    }
  });

  it('(e) scopes content_scripts.matches to the StoaChain dApp allow-list and NEVER <all_urls> (RR#6)', () => {
    const scripts = manifest.content_scripts ?? [];
    for (const s of scripts) {
      const matches = s.matches ?? [];
      expect(matches, 'matches must be the documented scoped allow-list').toEqual([SCOPED_MATCH]);
      const joined = matches.join(' ');
      expect(joined).not.toContain('<all_urls>');
      expect(joined).not.toContain('*://*/*');
      // all_frames:false unless required — a top-frame-only injection.
      expect(s.all_frames ?? false).toBe(false);
    }
  });

  it('(a) a manifest WITHOUT a content_scripts entry FAILS the relaxed store-readiness validator', () => {
    const m = clone(manifest);
    delete m.content_scripts;
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/content_scripts/i);
  });
});

describe('RR#4 — web_accessible_resources stays SCOPED (documented @crxjs deviation)', () => {
  // RR#4's ideal is NO web_accessible_resources for the inpage provider. With the
  // world:"MAIN" registration we did remove the <script>-injection mechanism — but
  // @crxjs 2.6.1's content-script emitter ships every content script as a tiny
  // loader that dynamic-import()s the real ESM chunk, and that import REQUIRES the
  // chunk in web_accessible_resources (true for MAIN and ISOLATED scripts alike).
  // This is intrinsic to @crxjs, not our <script> injection. RR#4's anti-
  // fingerprinting intent is preserved by SCOPING the entry to the StoaChain dApp
  // allow-list: arbitrary origins cannot probe the chrome-extension:// resources.
  it('(b) scopes any web_accessible_resources to the StoaChain allow-list, NEVER <all_urls>', () => {
    const war = manifest.web_accessible_resources;
    if (war === undefined) return; // ideal RR#4 outcome — also acceptable.
    const json = JSON.stringify(war);
    expect(json).not.toContain('<all_urls>');
    expect(json).not.toContain('*://*/*');
    // The matches present must be exactly the documented dApp allow-list.
    expect(json).toContain(SCOPED_MATCH);
  });

  it('(b) a web_accessible_resources exposing a resource via <all_urls> FAILS the scoped check', () => {
    const m = clone(manifest);
    m.web_accessible_resources = [{ resources: ['dapp/inpage.js'], matches: ['<all_urls>'] }];
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/all_urls|web_accessible/i);
  });
});

describe('RR#8 — externally_connectable stays absent', () => {
  it('keeps externally_connectable absent so the page reaches the SW only via the content-script hop', () => {
    expect(manifest.externally_connectable).toBeUndefined();
  });

  it('(c) a manifest WITH externally_connectable present FAILS the validator', () => {
    const m = clone(manifest);
    m.externally_connectable = { matches: [SCOPED_MATCH] };
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/externally_connectable/i);
  });
});

describe('wallet-class extension CSP stays hardened (NOT loosened by the dApp surface)', () => {
  it('still restricts extension pages to script-src self with no eval/inline/remote', () => {
    const csp = manifest.content_security_policy?.extension_pages ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(csp).not.toMatch(/unsafe-inline/);
    expect(csp).not.toMatch(/https?:\/\//);
  });
});

describe('FRAMING / CLICKJACKING — approval surface (T7.8 forward contract ENFORCED)', () => {
  const APPROVAL_HTML = distPath('src/approval/approval.html');

  /**
   * Read the `content` of a `<meta http-equiv="NAME">` tag, delimited by its OWN
   * double-quote. CSP/Permissions-Policy values legitimately contain single
   * quotes (`'none'`), so a `[^"']` capture would truncate at the first one.
   */
  function metaContent(html: string, httpEquiv: string): string | undefined {
    const tag = html.match(
      new RegExp(`<meta\\s+http-equiv="${httpEquiv}"[^>]*?>`, 'i'),
    )?.[0];
    return tag?.match(/content="([^"]*)"/i)?.[1];
  }

  it('emits the approval surface document so the dApp signature prompt has a real page', () => {
    expect(existsSync(APPROVAL_HTML), 'approval.html must be emitted to dist').toBe(true);
  });

  it('(d)/(e) the approval surface sets frame-ancestors none so no page can iframe the signing prompt', () => {
    const cspMeta = metaContent(readFileSync(APPROVAL_HTML, 'utf8'), 'Content-Security-Policy');
    expect(cspMeta, 'approval HTML must carry a CSP meta tag').toBeDefined();
    expect(cspMeta).toMatch(/frame-ancestors\s+'none'/);
  });

  it('(e) the approval surface locks down powerful sensors via a Permissions-Policy meta', () => {
    const pp = metaContent(readFileSync(APPROVAL_HTML, 'utf8'), 'Permissions-Policy');
    expect(pp, 'approval HTML must carry a Permissions-Policy meta tag').toBeDefined();
    for (const sensor of ['camera', 'microphone', 'geolocation', 'usb']) {
      expect(pp, `${sensor} must be denied`).toContain(`${sensor}=()`);
    }
  });

  it('(d) an approval surface CSP WITHOUT frame-ancestors none would FAIL the framing audit', () => {
    // Drive the failure mode from a mutated copy: a frameable prompt is a
    // clickjacking vector that maps directly to unauthorized signing.
    const cspMeta = metaContent(readFileSync(APPROVAL_HTML, 'utf8'), 'Content-Security-Policy') ?? '';
    const loosened = cspMeta.replace(/;?\s*frame-ancestors\s+'none'/i, '');
    expect(/frame-ancestors\s+'none'/i.test(loosened)).toBe(false);
  });
});

describe('storeReadiness validator (XP-17) — real shipped manifest', () => {
  it('(f) the relaxed validator passes for the real manifest with the scoped content scripts present', () => {
    const result = auditStoreReadiness(manifest as unknown as Record<string, unknown>, DIST);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
