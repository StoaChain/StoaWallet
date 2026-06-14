# BeeDev
Stack: react
Use /bee:new-spec to start a new feature.
Use /bee:progress to see current state.
Always use Context7 MCP for framework documentation lookups.

# StoaWallet

Barebone crypto wallet for **StoaChain** (a Kadena/Chainweb fork: 10 braided chains, Pact 5,
ED25519 keys, native "Stoa Coin"). Web-first React UI shipped as a Chrome MV3 extension now,
and later wrapped by Capacitor into Android/iOS — the SAME UI, not a rewrite.

## Architecture (locked)
- `packages/core` — wraps `@stoachain/*`; keyring, 24-word Koala/Chainweaver derivation, signing,
  RPC, crosschain. Single `KeyVault` interface, two impls (extension service worker vs Capacitor
  secure storage).
- `packages/ui` — shared React screens (unlock, balances×10, send, receive, crosschain).
- `apps/extension` — Vite + @crxjs, Chrome MV3 (popup + background service worker).
- `apps/mobile` — Capacitor wrapping `packages/ui` into Android/iOS.

## Reuse, don't rebuild (external local sources)
- `D:\_Claude\StoaOuronet\stoa-js\packages\` — `@stoachain/stoa-core` (crypto/signing/wallet/reads/
  pact/network/gas), `kadena-stoic-legacy` (hd-wallet + chainweaver derivation, chainweb client),
  `ouronet-core` (pact/coin contract), `ouronet-codex` (identity/naming, optional).
- `D:\_Claude\StoaOuronet\OuronetUI\src\` — reference web wallet: `components/auth/recover-seed`
  (24-word), `components/cross-chain/{CrossChainTransfer,ContinuationExecutor}` (SPV continuation),
  `lib/signing`, `kadena/wallet`.

## Build quirks (critical)
- Published npm `@stoachain/*` are BROKEN (under-declared deps). Use the local sibling-monorepo
  build path. Build order: kadena-stoic-legacy → stoa-core → ouronet-core → ouronet-codex.
- Node >=22.12. Pact 500 responses lack CORS headers (OuronetUI ships a cf-worker CORS proxy).

## Node infrastructure
- Pact API: `node1.stoachain.com` (= stoaNodePrime)
- Reads/supply (CORS-open): `apiexplorer.stoachain.com`
- Explorer: `explorer.stoachain.com`
