import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  EXPECTED_CONTENT_SCRIPTS,
  REQUIRED_ICON_SIZES,
  auditStoreReadiness,
  readPngDimensions,
} from '../security/storeReadiness';

/**
 * Store-readiness + wallet-class security-posture validation over the SHIPPED
 * `dist/` artifact.
 *
 * Where the T7.3 build suite proves the build emits a parseable least-privilege
 * manifest, this suite locks the validator as a REUSABLE, repeatable gate that a
 * release script (or a Chrome Web Store reviewer's mental checklist) can run: it
 * resolves every @crxjs path to a real file, reads each icon's PNG IHDR to prove
 * the pixel dimensions match the declared size, and rejects any loosened CSP or
 * widened permission set. It deliberately reads the committed `dist/manifest.json`
 * rather than rebuilding, so the gate is fast and side-effect free.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const DIST = path.join(APP_ROOT, 'dist');

/**
 * The shipped manifest, loaded in `beforeAll`. Sibling build suites (T7.3/T7.4)
 * rmSync+rebuild this same `dist/` in their own `beforeAll`, so reading at module
 * collection time would race; loading here — and rebuilding if the manifest is
 * absent — keeps this validator suite robust to a concurrent rebuild.
 */
let REAL_MANIFEST: Record<string, unknown>;

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
  REAL_MANIFEST = JSON.parse(
    readFileSync(path.join(DIST, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
}, 320_000);

/** Deep clone so each negative case mutates an isolated copy of the real manifest. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('auditStoreReadiness — happy path (the real shipped artifact)', () => {
  it('passes the real wallet-class manifest, CSP, permissions, and on-disk icons with no errors', () => {
    const result = auditStoreReadiness(REAL_MANIFEST, DIST);
    // A green release gate proves the shipped dist/ is store-ready; any error
    // here is a real regression a reviewer would reject.
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('confirms every required icon size resolves to a real PNG of the exact declared pixel dimensions', () => {
    // Drives the expectation from the file on disk: a 32x32 file mislabeled as
    // 128 would fail because IHDR width/height are read from the bytes.
    for (const size of REQUIRED_ICON_SIZES) {
      const rel = (REAL_MANIFEST.icons as Record<string, string>)[String(size)];
      const dims = readPngDimensions(path.join(DIST, rel.replace(/^\/+/, '')));
      expect(dims).toEqual({ width: size, height: size });
    }
  });
});

describe('auditStoreReadiness — (a) manifest version', () => {
  it('FAILS a manifest_version of 2 because Chrome would not load it as an MV3 extension', () => {
    const m = clone(REAL_MANIFEST);
    m.manifest_version = 2;
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/manifest_version/i);
  });
});

describe('auditStoreReadiness — (b)/(c) referenced files + icon sizes', () => {
  it('FAILS when a required icon size is missing from the manifest, since the store rejects incomplete icon sets', () => {
    const m = clone(REAL_MANIFEST);
    delete (m.icons as Record<string, string>)['128'];
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/icon.*128/i);
  });

  it('FAILS when a referenced popup/icon file does not exist in dist, since Chrome would 404 the asset', () => {
    const m = clone(REAL_MANIFEST);
    (m.action as Record<string, string>).default_popup = 'does-not-exist.html';
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/does-not-exist\.html/);
  });

  it('FAILS when the service worker is not declared as a module, since the import-based SW would not boot', () => {
    const m = clone(REAL_MANIFEST);
    (m.background as Record<string, string>).type = 'classic';
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/module/i);
  });
});

describe('auditStoreReadiness — (d) wallet-class CSP', () => {
  it('FAILS a CSP that adds unsafe-eval, because a key-holder must never eval code it did not ship', () => {
    const m = clone(REAL_MANIFEST);
    (m.content_security_policy as Record<string, string>).extension_pages =
      "script-src 'self' 'unsafe-eval'; object-src 'self'";
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/unsafe-eval/);
  });

  it('FAILS a CSP that whitelists a remote https script origin, since remote code defeats the wallet sandbox', () => {
    const m = clone(REAL_MANIFEST);
    (m.content_security_policy as Record<string, string>).extension_pages =
      "script-src 'self' https://evil.example.com; object-src 'self'";
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/remote|http/i);
  });

  it('FAILS a CSP missing script-src self entirely, since that is the baseline wallet-class restriction', () => {
    const m = clone(REAL_MANIFEST);
    (m.content_security_policy as Record<string, string>).extension_pages = "object-src 'self'";
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/script-src/i);
  });
});

describe('auditStoreReadiness — (e) least privilege (RR#5 / RR#8)', () => {
  it('FAILS host_permissions containing <all_urls>, since a wallet must request a finite RPC allow-list', () => {
    const m = clone(REAL_MANIFEST);
    (m.host_permissions as string[]) = ['<all_urls>'];
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/all_urls|host_permission/i);
  });

  it('FAILS host_permissions containing a *://*/* wildcard for the same least-privilege reason', () => {
    const m = clone(REAL_MANIFEST);
    (m.host_permissions as string[]) = ['*://*/*'];
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/wildcard|\*:\/\/\*/i);
  });

  it('FAILS when a dangerous permission like scripting or tabs is requested, widening the attack surface', () => {
    const m = clone(REAL_MANIFEST);
    (m.permissions as string[]) = ['storage', 'idle', 'scripting'];
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/scripting/i);
  });

  it('FAILS when externally_connectable is present (RR#8), since no page may message the wallet yet', () => {
    const m = clone(REAL_MANIFEST);
    m.externally_connectable = { matches: ['https://node1.stoachain.com/*'] };
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/externally_connectable/i);
  });

  it('FAILS when content_scripts is ABSENT, since the dApp provider bridge requires it (XP-17)', () => {
    const m = clone(REAL_MANIFEST) as Record<string, unknown>;
    delete m.content_scripts;
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/content_scripts/i);
  });

  it('FAILS when a content script broadens matches to <all_urls>, since injection must stay scoped (RR#6)', () => {
    const m = clone(REAL_MANIFEST) as Record<string, unknown>;
    (m.content_scripts as Array<Record<string, unknown>>)[0].matches = ['<all_urls>'];
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/all_urls|matches/i);
  });

  it('FAILS when a content script runs at document_end, since the provider must exist before feature-detect (RR#5)', () => {
    const m = clone(REAL_MANIFEST) as Record<string, unknown>;
    (m.content_scripts as Array<Record<string, unknown>>)[0].run_at = 'document_end';
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/run_at|document_start/i);
  });

  it('FAILS when the MAIN-world inpage script is dropped, since window.stoa would never be defined (RR#4)', () => {
    const m = clone(REAL_MANIFEST) as Record<string, unknown>;
    m.content_scripts = (m.content_scripts as Array<Record<string, unknown>>).filter(
      (s) => s.world !== 'MAIN',
    );
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/MAIN/);
  });

  it('FAILS when web_accessible_resources exposes a resource via <all_urls>, since that is a fingerprint (RR#4)', () => {
    const m = clone(REAL_MANIFEST) as Record<string, unknown>;
    m.web_accessible_resources = [{ resources: ['dapp/inpage.js'], matches: ['<all_urls>'] }];
    const result = auditStoreReadiness(m, DIST);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/all_urls|web_accessible/i);
  });

  it('pins EXPECTED_CONTENT_SCRIPTS to "required" — the XP-17 relaxation Phase 9 made to permit the scoped bridge', () => {
    // The documented XP-17 relaxation point: content_scripts flipped from
    // forbidden (undefined) to REQUIRED-and-scoped ('required').
    expect(EXPECTED_CONTENT_SCRIPTS).toBe('required');
  });
});

describe('readPngDimensions', () => {
  it('reads width/height from a real PNG IHDR so a placeholder or wrong-size file is detectable', () => {
    const dims = readPngDimensions(path.join(DIST, 'public/icons/icon-48.png'));
    expect(dims).toEqual({ width: 48, height: 48 });
  });

  it('returns null for a non-PNG file so the auditor can flag a fake icon rather than trust the extension', () => {
    // Own the fixture in a temp dir so a sibling suite rebuilding dist/ cannot
    // delete it out from under this assertion.
    const tmp = mkdtempSync(path.join(tmpdir(), 'stoa-png-'));
    const notPng = path.join(tmp, 'fake-icon.png');
    writeFileSync(notPng, 'this is plainly not a PNG');
    expect(readPngDimensions(notPng)).toBeNull();
  });
});

describe('framing/clickjacking audit doc (SECURITY.md)', () => {
  const SECURITY_MD = path.join(APP_ROOT, 'SECURITY.md');

  it('exists as a committed artifact so the framing posture is reviewable, not tribal knowledge', () => {
    expect(existsSync(SECURITY_MD)).toBe(true);
  });

  it('names the Phase-9 dApp-provider page as THE framing-sensitive web-served surface', () => {
    const doc = readFileSync(SECURITY_MD, 'utf8');
    expect(doc).toMatch(/Phase[ -]?9/);
    expect(doc).toMatch(/dApp/i);
  });

  it('records the binding web-surface requirements: frame-ancestors none and a sensor Permissions-Policy', () => {
    const doc = readFileSync(SECURITY_MD, 'utf8');
    expect(doc).toMatch(/frame-ancestors\s+'none'/);
    expect(doc).toMatch(/Permissions-Policy/i);
  });
});
