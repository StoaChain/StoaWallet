// Browser polyfill for the Node.js `Buffer` global.
//
// The @stoachain triplet (kadena-stoic-legacy hd-wallet signing +
// cryptography-utils, stoa-core) references `Buffer` as a global in ~21 files.
// The only polyfill in the dependency tree is unreachable via the package
// `exports` map and gets tree-shaken by Rollup because the upstream packages
// declare `sideEffects: false`. Vite's dev-server esbuild prebundler happens
// to evaluate it, but the production Rollup build does not — so crypto paths
// work in `vite dev` yet throw "Buffer is not defined" on the built bundle.
//
// This module makes the polyfill explicit and bundler-independent. It MUST be
// the first import of each app entry so it runs before any @stoachain import.
import { Buffer } from 'buffer';

globalThis.Buffer = globalThis.Buffer ?? Buffer;
