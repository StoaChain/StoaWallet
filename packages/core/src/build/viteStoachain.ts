// Shared Vite build-correctness layer for the @stoachain triplet, reused by
// both apps (extension + mobile). It exists because the vendored
// `@stoachain/kadena-stoic-legacy` package ships an `exports` map whose
// `import`/`require` conditions point at `dist/<subpath>/index.js` ESM entries
// that re-`export *` from sibling `.cjs` files. Browser ESM cannot named-import
// from CJS, and esbuild's prebundler drops most named exports while following
// `export *` chains through CJS (cold boot fails with "does not provide an
// export named 'kadenaDecrypt'"). The fix is to alias each bare subpath ENTRY
// directly to its `.cjs` file, which esbuild treats as pure CommonJS with
// well-defined named-export semantics.
//
// `@stoachain/stoa-core` is pure ESM (no `.cjs` siblings) and resolves fine
// without an alias, so it is intentionally absent here.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AliasOptions, ResolveOptions } from 'vite';

const LEGACY_PKG = '@stoachain/kadena-stoic-legacy';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

// Stable specifier for the Buffer-global polyfill module. Apps and the later
// entry-wiring phase import THIS string as their first import; the alias below
// resolves it to the polyfill source regardless of the core package's
// `exports` map (which this build layer does not own).
export const POLYFILLS_SPECIFIER = '@stoawallet/core/build/polyfills';

// The bare subpaths that must redirect to their `.cjs` entry. Anchored regex
// (matched in buildStoachainAliases) ensures only the exact subpath is aliased
// — nested imports like `/hd-wallet/chainweaver` fall through to default
// resolution against the package `exports` map.
const LEGACY_CJS_SUBPATHS = ['hd-wallet', 'client', 'types', 'cryptography-utils'] as const;

/**
 * Resolve the on-disk root of the installed `@stoachain/kadena-stoic-legacy`.
 *
 * The package's `.` export declares only an `import` condition (no `require`),
 * so `require.resolve(pkg)` and `require.resolve(pkg + '/package.json')` both
 * throw ERR_PACKAGE_PATH_NOT_EXPORTED from CJS. The `./client` subpath DOES
 * declare a `require` condition, so we resolve that and walk up two directories
 * (`dist/client/index.js` -> `dist/client` -> `dist` -> package root).
 *
 * This is resolved dynamically — never a hardcoded `node_modules/.pnpm/...`
 * path, whose hash segment changes on every install.
 *
 * Resolution is anchored at THIS helper's directory (inside `packages/core`,
 * whose `node_modules` holds the `@stoachain/kadena-stoic-legacy` symlink),
 * NOT at the consuming app — the app depends on the legacy package only
 * transitively through `@stoawallet/core`, so it is not present in the app's
 * own `node_modules`.
 */
function resolveLegacyPackageRoot(): string {
  const require = createRequire(path.join(SELF_DIR, 'noop.js'));
  const clientEntry = require.resolve(`${LEGACY_PKG}/client`);
  return path.dirname(path.dirname(path.dirname(clientEntry)));
}

/**
 * Build the anchored-regex aliases that redirect the four bare
 * kadena-stoic-legacy subpaths to their compiled `.cjs` entries.
 *
 * Each target `.cjs` is asserted to exist at config-evaluation time; a missing
 * one throws a clear error rather than surfacing later as an opaque Rollup
 * "unresolved import".
 */
export function buildStoachainAliases(): AliasOptions {
  const pkgRoot = resolveLegacyPackageRoot();

  const aliases = LEGACY_CJS_SUBPATHS.map((subpath) => {
    const cjsTarget = path.join(pkgRoot, 'dist', subpath, 'index.cjs');
    if (!existsSync(cjsTarget)) {
      throw new Error(
        `[viteStoachain] expected ${LEGACY_PKG}/${subpath} .cjs entry at ` +
          `"${cjsTarget}" but it does not exist. The vendored package layout ` +
          `changed; update LEGACY_CJS_SUBPATHS or rebuild kadena-stoic-legacy.`,
      );
    }
    return {
      find: new RegExp(`^@stoachain/kadena-stoic-legacy/${subpath}$`),
      replacement: cjsTarget,
    };
  });

  // Resolve the polyfill source next to this helper. `import.meta.url` keeps
  // this correct whether the helper runs from `src/` (Vite's TS loader) or a
  // compiled `dist/` location — never a hardcoded path.
  const polyfillSource = path.join(SELF_DIR, 'polyfills.ts');
  const polyfillTarget = existsSync(polyfillSource)
    ? polyfillSource
    : path.join(SELF_DIR, 'polyfills.js');

  return [
    // Stable specifier -> polyfill source, so the polyfill resolves without
    // depending on the core package `exports` map (owned elsewhere).
    { find: POLYFILLS_SPECIFIER, replacement: polyfillTarget },
    // Several @stoachain modules do `import { Buffer } from "node:buffer"`.
    // Vite dev tolerates this via its browser-external shim, but Rollup's
    // production bundler cannot resolve a named export from that stub and
    // fails. Redirect to the `buffer` npm polyfill so dev and prod agree.
    { find: 'node:buffer', replacement: 'buffer' },
    ...aliases,
  ];
}

/**
 * Full `resolve` config for an app's Vite config. Combines the @stoachain
 * aliases with a React dedupe.
 *
 * `dedupe: ["react", "react-dom"]` is mandatory: aliasing subpaths to `.cjs`
 * triggers fresh esbuild prebundles that can pull in a second React copy,
 * producing the classic "Invalid hook call" crash because the two Reacts are
 * different module instances.
 */
export function stoachainResolve(): ResolveOptions & { alias: AliasOptions } {
  return {
    dedupe: ['react', 'react-dom'],
    alias: buildStoachainAliases(),
  };
}
