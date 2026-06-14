import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Store-readiness + wallet-class security-posture validator for the shipped MV3
 * `dist/` artifact.
 *
 * This is a reusable, side-effect-free gate (no rebuild, no logging of secrets):
 * give it a parsed manifest object and the dist root, and it returns the list of
 * reasons the artifact is NOT store-ready. An empty error list means a Chrome Web
 * Store reviewer — and the least-privilege posture a key-holding wallet demands —
 * would accept the build.
 */

/** The four icon sizes a Chrome Web Store MV3 listing requires. */
export const REQUIRED_ICON_SIZES = [16, 32, 48, 128] as const;

/**
 * Permissions that widen a wallet's attack surface and must never appear in this
 * build. `tabs`/`scripting` can read/inject into pages; `webRequest*` can observe
 * or rewrite traffic.
 */
const FORBIDDEN_PERMISSIONS = ['tabs', 'scripting', 'webRequest', 'webRequestBlocking'] as const;

/** Broad host patterns that defeat the finite RPC allow-list (RR#5). */
const FORBIDDEN_HOST_PATTERNS = ['<all_urls>', '*://*/*'] as const;

/**
 * XP-17 relaxation point (Phase 9 / T9.8). The build now ships the dApp-provider
 * bridge as TWO scoped content scripts: a `world:"MAIN"` inpage provider and an
 * ISOLATED-world relay, both at `run_at:"document_start"` on the documented
 * StoaChain dApp-origin allow-list. This is the EXPECTED shape the validator
 * enforces — a content_scripts block that deviates (broad matches, wrong world,
 * wrong run_at, or absent entirely) FAILS the gate.
 *
 * `null` (vs the prior `undefined`) marks that content_scripts is now REQUIRED:
 * the shape is validated structurally below, not by identity-comparison.
 */
export const EXPECTED_CONTENT_SCRIPTS: 'required' = 'required';

/** The canonical scoped dApp-origin allow-list every content script must use (RR#6). */
const EXPECTED_CONTENT_SCRIPT_MATCHES = ['https://*.stoachain.com/*'] as const;

/** Content scripts must inject before the dApp feature-detects the wallet (RR#5). */
const EXPECTED_RUN_AT = 'document_start';

interface ContentScriptShape {
  matches?: unknown;
  js?: unknown;
  run_at?: unknown;
  all_frames?: unknown;
  world?: unknown;
}

export interface PngDimensions {
  width: number;
  height: number;
}

export interface StoreReadinessResult {
  ok: boolean;
  errors: string[];
}

interface ManifestShape {
  manifest_version?: unknown;
  action?: { default_popup?: unknown };
  background?: { service_worker?: unknown; type?: unknown };
  icons?: Record<string, unknown>;
  permissions?: unknown;
  host_permissions?: unknown;
  content_security_policy?: { extension_pages?: unknown };
  content_scripts?: unknown;
  externally_connectable?: unknown;
  web_accessible_resources?: unknown;
}

/** The dApp-approval surface document, relative to dist root (framing-sensitive). */
const APPROVAL_SURFACE_REL = 'src/approval/approval.html';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Read the pixel dimensions from a PNG's IHDR chunk. Returns `null` if the file
 * is not a real PNG, so a renamed placeholder or wrong-format icon is detectable
 * rather than silently trusted.
 */
export function readPngDimensions(filePath: string): PngDimensions | null {
  if (!existsSync(filePath)) return null;
  const buf = readFileSync(filePath);
  if (buf.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return null;
  }
  // IHDR is the first chunk: 8-byte signature, 4-byte length, 4-byte "IHDR"
  // type, then width (offset 16) and height (offset 20) as big-endian uint32.
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Resolve a manifest-relative path (leading slashes stripped) under dist root. */
function distPath(distRoot: string, rel: string): string {
  return path.join(distRoot, rel.replace(/^\/+/, ''));
}

export function auditStoreReadiness(
  manifest: ManifestShape,
  distRoot: string,
): StoreReadinessResult {
  const errors: string[] = [];

  // (a) MV3.
  if (manifest.manifest_version !== 3) {
    errors.push(`manifest_version must be 3 (got ${String(manifest.manifest_version)})`);
  }

  // (b) Popup document exists.
  const popup = manifest.action?.default_popup;
  if (typeof popup !== 'string') {
    errors.push('action.default_popup is missing');
  } else if (!existsSync(distPath(distRoot, popup))) {
    errors.push(`action.default_popup references a missing file: ${popup}`);
  }

  // (b) Module service worker bundle exists.
  const sw = manifest.background?.service_worker;
  if (manifest.background?.type !== 'module') {
    errors.push('background.service_worker must declare type:"module"');
  }
  if (typeof sw !== 'string') {
    errors.push('background.service_worker is missing');
  } else if (!existsSync(distPath(distRoot, sw))) {
    errors.push(`background.service_worker references a missing file: ${sw}`);
  }

  // (b)/(c) Every required icon size is declared, exists, and is a PNG of the
  // exact declared pixel dimensions.
  const icons = manifest.icons ?? {};
  for (const size of REQUIRED_ICON_SIZES) {
    const rel = icons[String(size)];
    if (typeof rel !== 'string') {
      errors.push(`icons is missing required size ${size}`);
      continue;
    }
    const iconPath = distPath(distRoot, rel);
    const dims = readPngDimensions(iconPath);
    if (dims === null) {
      errors.push(`icon ${size} (${rel}) is missing or not a valid PNG`);
    } else if (dims.width !== size || dims.height !== size) {
      errors.push(
        `icon ${size} (${rel}) is ${dims.width}x${dims.height}, expected ${size}x${size}`,
      );
    }
  }

  // (d) Wallet-class CSP: must restrict scripts to self, never eval, never a
  // remote origin.
  const csp = manifest.content_security_policy?.extension_pages;
  if (typeof csp !== 'string') {
    errors.push('content_security_policy.extension_pages is missing');
  } else {
    if (!csp.includes("script-src 'self'")) {
      errors.push("CSP must contain script-src 'self'");
    }
    if (/unsafe-eval/.test(csp)) {
      errors.push("CSP must not contain 'unsafe-eval'");
    }
    if (/unsafe-inline/.test(csp)) {
      errors.push("CSP must not contain 'unsafe-inline'");
    }
    if (/https?:\/\//.test(csp)) {
      errors.push('CSP must not whitelist a remote http(s) script source');
    }
  }

  // (e) Least privilege — finite host allow-list (RR#5).
  const hostPerms = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
  for (const host of hostPerms) {
    for (const bad of FORBIDDEN_HOST_PATTERNS) {
      if (typeof host === 'string' && host.includes(bad)) {
        errors.push(`host_permissions must not contain the wildcard ${bad}`);
      }
    }
  }

  // (e) No dangerous permissions.
  const perms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const bad of FORBIDDEN_PERMISSIONS) {
    if (perms.includes(bad)) {
      errors.push(`permissions must not contain ${bad}`);
    }
  }

  // (e) RR#8 — no externally_connectable. The page reaches the SW only via the
  // content-script relay hop, never directly.
  if (manifest.externally_connectable !== undefined) {
    errors.push('externally_connectable must be absent (RR#8)');
  }

  // (e) XP-17 — the dApp content_scripts must be present and match the scoped,
  // dual-world, document_start shape. A deviation widens the injection surface.
  auditContentScripts(manifest.content_scripts, errors);

  // (e) RR#4 — if web_accessible_resources is used at all, it must be scoped: a
  // resource exposed to <all_urls> (or *://*/*) is a fingerprintable surface.
  auditWebAccessibleResources(manifest.web_accessible_resources, errors);

  // (d)/(e) FRAMING — the dApp-approval surface must ship frame-ancestors 'none'
  // and a sensor-locking Permissions-Policy (the T7.8 forward contract).
  auditApprovalFraming(distRoot, errors);

  return { ok: errors.length === 0, errors };
}

/**
 * Validate the dApp content_scripts (XP-17): exactly the MAIN-world inpage
 * provider + the ISOLATED-world relay, both scoped to the StoaChain dApp allow-
 * list and injected at document_start. Anything absent, broadly-matched, or in
 * the wrong world fails — that is the whole injection attack surface.
 */
function auditContentScripts(scripts: unknown, errors: string[]): void {
  if (EXPECTED_CONTENT_SCRIPTS !== 'required') return;
  if (!Array.isArray(scripts) || scripts.length === 0) {
    errors.push('content_scripts must be present for the dApp provider bridge (XP-17)');
    return;
  }
  const entries = scripts as ContentScriptShape[];
  const hasMain = entries.some((s) => s.world === 'MAIN');
  const hasIsolated = entries.some((s) => s.world !== 'MAIN');
  if (!hasMain) {
    errors.push('content_scripts must include a world:"MAIN" inpage provider (RR#4)');
  }
  if (!hasIsolated) {
    errors.push('content_scripts must include an ISOLATED-world relay');
  }
  for (const s of entries) {
    const matches = Array.isArray(s.matches) ? (s.matches as unknown[]) : [];
    const joined = matches.join(' ');
    for (const bad of FORBIDDEN_HOST_PATTERNS) {
      if (joined.includes(bad)) {
        errors.push(`content_scripts.matches must not contain the wildcard ${bad} (RR#6)`);
      }
    }
    const scoped =
      matches.length === EXPECTED_CONTENT_SCRIPT_MATCHES.length &&
      EXPECTED_CONTENT_SCRIPT_MATCHES.every((m, i) => matches[i] === m);
    if (!scoped) {
      errors.push(
        `content_scripts.matches must be the scoped StoaChain dApp allow-list ${JSON.stringify(EXPECTED_CONTENT_SCRIPT_MATCHES)} (RR#6)`,
      );
    }
    if (s.run_at !== EXPECTED_RUN_AT) {
      errors.push(`content_scripts.run_at must be "${EXPECTED_RUN_AT}" (RR#5)`);
    }
  }
}

/**
 * RR#4 — web_accessible_resources is optional, but if present it must be scoped:
 * a resource matched against a broad wildcard is a page-observable extension
 * fingerprint. The MAIN-world injection means this should normally be ABSENT.
 */
function auditWebAccessibleResources(war: unknown, errors: string[]): void {
  if (war === undefined) return;
  const json = JSON.stringify(war);
  for (const bad of FORBIDDEN_HOST_PATTERNS) {
    if (json.includes(bad)) {
      errors.push(`web_accessible_resources must not be exposed via the wildcard ${bad} (RR#4)`);
    }
  }
}

/**
 * Extract the `content` of a `<meta http-equiv="NAME">` tag. The attribute value
 * is captured up to its OWN delimiting quote — CSP / Permissions-Policy values
 * legitimately contain single quotes (`'none'`, `'self'`), so a naive
 * `[^"']+` capture would truncate at the first inner quote.
 */
function readMetaContent(html: string, httpEquiv: string): string | null {
  const tag = html.match(
    new RegExp(`<meta\\s+http-equiv=["']${httpEquiv}["'][^>]*?>`, 'i'),
  )?.[0];
  if (!tag) return null;
  const dbl = tag.match(/content="([^"]*)"/i)?.[1];
  if (dbl !== undefined) return dbl;
  return tag.match(/content='([^']*)'/i)?.[1] ?? null;
}

/**
 * Read the shipped approval surface and assert its framing headers. The signing
 * prompt is the highest-risk web-facing document: a frameable prompt is a
 * clickjacking vector that maps to unauthorized signing, so frame-ancestors
 * 'none' AND the sensor Permissions-Policy are mandatory (the T7.8 contract).
 */
function auditApprovalFraming(distRoot: string, errors: string[]): void {
  const approvalPath = distPath(distRoot, APPROVAL_SURFACE_REL);
  if (!existsSync(approvalPath)) {
    errors.push(`approval surface ${APPROVAL_SURFACE_REL} is missing from the build`);
    return;
  }
  const html = readFileSync(approvalPath, 'utf8');
  const csp = readMetaContent(html, 'Content-Security-Policy');
  if (!csp || !/frame-ancestors\s+'none'/.test(csp)) {
    errors.push("approval surface CSP must set frame-ancestors 'none' (clickjacking)");
  }
  const pp = readMetaContent(html, 'Permissions-Policy');
  if (!pp) {
    errors.push('approval surface must set a sensor-locking Permissions-Policy');
  } else {
    for (const sensor of ['camera', 'microphone', 'geolocation', 'usb']) {
      if (!pp.includes(`${sensor}=()`)) {
        errors.push(`approval surface Permissions-Policy must deny ${sensor}`);
      }
    }
  }
}
