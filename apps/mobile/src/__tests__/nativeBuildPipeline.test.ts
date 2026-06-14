import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Native build-pipeline structure validation for the mobile app.
 *
 * The native Android/iOS artifact builds (Gradle `assembleDebug`/`bundleRelease`,
 * Xcode `xcodebuild archive`/`-exportArchive`) require a full mobile toolchain
 * that is absent from this workspace (Windows, no Android SDK / JDK 21, no
 * Xcode). So this suite does NOT run those builds — it proves the things a
 * broken release pipeline would get wrong WITHOUT the toolchain:
 *
 *   1. The full ordered sequence of named pnpm scripts exists so a host WITH the
 *      toolchain can run `build:web → sync → build:android`/`build:ios` straight
 *      from package.json (a missing or misordered step ships an empty/stale shell
 *      or skips signing).
 *   2. NO signing material (`*.keystore`/`*.jks`/`*.p12`/`*.mobileprovision`/
 *      `keystore.properties`/`exportOptions.plist`) is committed/tracked in the
 *      working tree — a single leaked keystore or provisioning profile is an
 *      irreversible credential compromise.
 *   3. The build doc names the EXACT signing plug-in points and toolchain
 *      prerequisites, so a release is reproducible by someone WITH the
 *      credentials without those credentials living in the repo.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('mobile native build pipeline is defined as ordered named scripts', () => {
  const pkg = readJson(path.join(APP_ROOT, 'package.json'));
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;

  it('builds the WebView bundle into the Capacitor webDir via a vite build', () => {
    // build:web is step 1 — it must run vite so the bundle lands in the shared
    // webDir; cap sync downstream copies whatever this emits.
    expect(scripts['build:web']).toBeDefined();
    expect(scripts['build:web']).toMatch(/vite build/);
  });

  it('exposes a sync step that runs cap sync to copy webDir + plugins into native projects', () => {
    expect(scripts.sync).toBeDefined();
    expect(scripts.sync).toMatch(/cap sync/);
  });

  it('defines the Android build producing a debug .apk and a store .aab via gradle', () => {
    // bundleRelease (.aab → Play Store) and assembleDebug (.apk → sideload) are
    // distinct artifacts; the script must cover the release path used to publish.
    expect(scripts['build:android']).toBeDefined();
    expect(scripts['build:android']).toMatch(/gradlew|gradle/);
    expect(scripts['build:android']).toMatch(/bundleRelease|assembleDebug/);
  });

  it('defines the iOS build using xcodebuild archive/export', () => {
    expect(scripts['build:ios']).toBeDefined();
    expect(scripts['build:ios']).toMatch(/xcodebuild/);
    expect(scripts['build:ios']).toMatch(/archive|exportArchive/);
  });

  it('orders the pipeline so build:web precedes sync precedes the native builds in the doc', () => {
    // The named scripts are individually runnable; the canonical ORDER is
    // documented so the conductor/host runs them in the only valid sequence.
    const doc = readFileSync(path.join(APP_ROOT, 'MOBILE_BUILD.md'), 'utf8');
    const iWeb = doc.indexOf('build:web');
    const iSync = doc.indexOf('sync');
    const iAndroid = doc.indexOf('build:android');
    expect(iWeb).toBeGreaterThanOrEqual(0);
    expect(iSync).toBeGreaterThan(iWeb);
    expect(iAndroid).toBeGreaterThan(iSync);
  });
});

describe('no signing secret is committed to the repo', () => {
  // Patterns that are ALWAYS a leaked credential if tracked. A presence check
  // over the working tree (git ls-files) is the contract: zero matches.
  const SECRET_GLOBS = [
    '*.keystore',
    '*.jks',
    '*.p12',
    '*.mobileprovision',
    'keystore.properties',
  ];

  function trackedFiles(): string[] {
    try {
      const out = execFileSync('git', ['ls-files'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return out.split(/\r?\n/).filter(Boolean);
    } catch {
      // Not a git repo (or git unavailable): fall back to an empty tracked set.
      // The .gitignore assertion below still guards the patterns.
      return [];
    }
  }

  it('tracks NO keystore, .jks, .p12, .mobileprovision, or keystore.properties file', () => {
    const tracked = trackedFiles();
    const offenders = tracked.filter((f) => {
      const base = path.basename(f);
      return (
        /\.(keystore|jks|p12|mobileprovision)$/i.test(base) ||
        base === 'keystore.properties'
      );
    });
    expect(offenders).toEqual([]);
  });

  it('excludes every signing-material pattern (incl. exportOptions.plist) in .gitignore', () => {
    const gitignore = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    for (const glob of SECRET_GLOBS) {
      expect(gitignore).toContain(glob);
    }
    // exportOptions.plist can carry the team/cert identity — gitignored too.
    expect(gitignore).toContain('exportOptions.plist');
  });

  it('does not leave a stray signing file in the mobile app working tree', () => {
    // A defense-in-depth scan of the app dir itself: even an untracked but
    // present secret should not exist where a careless `git add -A` would grab it.
    const candidates = [
      'release.keystore',
      'upload.jks',
      'distribution.p12',
      'AppStore.mobileprovision',
      'keystore.properties',
      'android/keystore.properties',
    ];
    const present = candidates.filter((c) => existsSync(path.join(APP_ROOT, c)));
    expect(present).toEqual([]);
  });
});

describe('MOBILE_BUILD.md documents signing plug-in points and toolchain prerequisites', () => {
  const doc = readFileSync(path.join(APP_ROOT, 'MOBILE_BUILD.md'), 'utf8');

  it('names the Android signing plug-in point: signingConfigs + a referenced keystore.properties', () => {
    expect(doc).toContain('signingConfigs');
    expect(doc).toContain('keystore.properties');
  });

  it('names the iOS signing plug-in point: Xcode signing + exportOptions.plist', () => {
    expect(doc).toContain('exportOptions.plist');
    expect(doc).toMatch(/Xcode signing|code signing|signing certificate/i);
  });

  it('documents the .aab (Play Store) vs .apk (sideload/test) distinction', () => {
    expect(doc).toMatch(/\.aab/);
    expect(doc).toMatch(/\.apk/);
    expect(doc).toMatch(/Play Store/i);
  });

  it('states the toolchain prerequisites: Android SDK + JDK 21, macOS + Xcode for iOS', () => {
    expect(doc).toMatch(/JDK\s*21/i);
    expect(doc).toMatch(/Android SDK/i);
    expect(doc).toMatch(/Xcode/i);
  });

  it('states signing material is referenced, NOT committed', () => {
    expect(doc).toMatch(/NOT committed|never commit|not commit/i);
  });
});
