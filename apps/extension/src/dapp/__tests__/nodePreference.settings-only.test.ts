import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DAppPermissionStore } from '../permissionStore';
import { RequestRateLimiter } from '../rateLimiter';
import {
  createDappRouter,
  type ApprovalGateway,
  type CommandSigner,
  type DappTabMessenger,
} from '../dappRouter';
import type { StorageAdapter } from '@stoawallet/core';

/**
 * RR#1 NEGATIVE GATE — the node-preference applier is SETTINGS-UI-ONLY.
 *
 * Phase-10 introduced a runtime node-preference applier
 * (`setNodePreference` / `applyAndPersistNodePreference` / `revertToDefault`).
 * RR#1 mandates it be reachable ONLY from the trusted Settings context — NEVER
 * from the Phase-9 dApp provider, any `window.stoa` method, or a deep-link/URL.
 * A hostile page that could redirect the wallet's node would defeat the entire
 * custom-node trust boundary (it could point the wallet at an attacker's node).
 *
 * This file proves the isolation two ways:
 *   1. BEHAVIOR — the real dApp router exposes ONLY the fixed eckoWALLET `kda_*`
 *      set and rejects any other method by default; no `kda_*` (or smuggled)
 *      method maps to a node-preference mutation.
 *   2. SOURCE — no file under `apps/extension/src/dapp/*` (router, inpage
 *      provider, content script, signer) imports or references the applier
 *      symbols. The Settings context (`packages/ui/src/settings/SettingsContext.tsx`)
 *      is the ONLY non-test consumer.
 */

const DAPP_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..');

/** Reject-by-default storage double (no node-config calls expected at all). */
function memAdapter(): StorageAdapter {
  const store = new Map<string, string | Uint8Array>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async remove(key) {
      store.delete(key);
    },
  };
}

const RUNTIME_ID = 'stoawallet-extension-id';

async function buildRouter(): Promise<ReturnType<typeof createDappRouter>> {
  const adapter = memAdapter();
  const store = await DAppPermissionStore.load(adapter);
  const limiter = new RequestRateLimiter();
  const approvals: ApprovalGateway = {
    open: () => {
      throw new Error('approval gateway must not be reached by an unknown method');
    },
  };
  const signer: CommandSigner = {
    sign: () => {
      throw new Error('signer must not be reached by an unknown method');
    },
  };
  const messenger: DappTabMessenger = { sendToTab: () => undefined };

  return createDappRouter({
    store,
    limiter,
    adapter,
    approvals,
    signer,
    messenger,
    runtimeId: RUNTIME_ID,
    networkId: 'stoachain',
    grantedAccounts: [],
  });
}

/** The applier symbols that MUST NOT appear anywhere in the dapp surface. */
const FORBIDDEN_APPLIER_SYMBOLS = [
  'setNodePreference',
  'applyAndPersistNodePreference',
  'applyNodePreference',
  'revertToDefault',
  'setNodeConfig',
] as const;

/** The fixed eckoWALLET method set the router is allowed to route (and ONLY this). */
const ALLOWED_KDA_METHODS = [
  'kda_connect',
  'kda_checkStatus',
  'kda_disconnect',
  'kda_getNetwork',
  'kda_requestSign',
  'kda_requestQuickSign',
] as const;

describe('node-preference applier is reachable ONLY from Settings (RR#1 negative gate)', () => {
  const verifiedSender = {
    id: RUNTIME_ID,
    origin: 'https://good.test',
    tab: { id: 7 },
  } as chrome.runtime.MessageSender;

  it('rejects an UNKNOWN method by default — there is no node-config/node-preference route on the dApp surface', async () => {
    const router = await buildRouter();

    // A page that tries to smuggle a node-preference mutation through the dApp
    // channel hits the reject-by-default arm: the method is not in the union, so
    // it is refused WITHOUT touching any node config (the gateway/signer doubles
    // throw if reached, so a silent mis-route would surface as an error, not a pass).
    const response = await router.handle(
      {
        id: 'r1',
        method: 'kda_setNodeConfig' as never,
        data: { customUrl: 'https://attacker.example.com' },
      } as never,
      verifiedSender,
    );

    expect(response.status).toBe('fail');
    expect(response).toMatchObject({ reason: 'invalid-request' });
  });

  it('the router switch handles ONLY the fixed kda_* set — no node-preference case label is present', () => {
    const routerSrc = readFileSync(path.join(DAPP_DIR, 'dappRouter.ts'), 'utf8');

    // Enumerate the `case 'kda_*':` labels actually present in the switch. They
    // must be exactly the allowed eckoWALLET set — a node-preference case would
    // show up here and fail the equality.
    const caseLabels = Array.from(
      routerSrc.matchAll(/case\s+'(kda_[A-Za-z]+)'/g),
      (m) => m[1],
    );
    const uniqueSorted = [...new Set(caseLabels)].sort();
    expect(uniqueSorted).toEqual([...ALLOWED_KDA_METHODS].sort());

    // Defense in depth: the router source references no applier symbol at all.
    for (const symbol of FORBIDDEN_APPLIER_SYMBOLS) {
      expect(routerSrc).not.toContain(symbol);
    }
  });

  it('NO dapp source file imports or references the node-preference applier symbols (Settings-only)', () => {
    const dappFiles = readdirSync(DAPP_DIR).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );

    // Sanity: the scan actually covered the high-risk surface (router, inpage
    // provider, content script, signer) — an empty list would vacuously pass.
    expect(dappFiles).toEqual(
      expect.arrayContaining([
        'dappRouter.ts',
        'inpage.ts',
        'contentScript.ts',
        'backgroundCommandSigner.ts',
      ]),
    );

    for (const file of dappFiles) {
      const src = readFileSync(path.join(DAPP_DIR, file), 'utf8');
      for (const symbol of FORBIDDEN_APPLIER_SYMBOLS) {
        expect(
          src.includes(symbol),
          `${file} must NOT reference the node-preference applier symbol "${symbol}" — it is Settings-only`,
        ).toBe(false);
      }
    }
  });
});
