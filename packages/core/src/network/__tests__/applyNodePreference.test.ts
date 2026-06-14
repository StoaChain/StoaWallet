import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KADENA_NETWORK } from '@stoachain/stoa-core/constants';

import {
  getActivePactUrl,
  getActiveSpvUrl,
  getNodeConfig,
  resetNodeFailover,
  setNodeConfig,
} from '@stoachain/stoa-core/network';

import {
  applyNodePreference,
  applyAndPersistNodePreference,
  revertToDefault,
  applySelector,
} from '../applyNodePreference';
import type { NodeInfoReadDeps, NodeInfo } from '../customNodeValidation';
import type { NodePreference } from '../nodePreference';
import type { StorageAdapter } from '../../storage';
import { NODE_PREFERENCE_KEY } from '../../storage/storageKeys';

/**
 * node1's canonical host from the SDK — applying setNodeConfig("node1") and
 * reading back the configured primary — so assertions never hardcode the host.
 */
function sdkNode1Host(): string {
  setNodeConfig('node1');
  const host = getNodeConfig().primary;
  resetNodeFailover();
  return host;
}

/** node2's canonical host from the SDK. */
function sdkNode2Host(): string {
  setNodeConfig('node2');
  const host = getNodeConfig().primary;
  resetNodeFailover();
  return host;
}

/** In-memory StorageAdapter double recording every write for persistence assertions. */
function makeStorage(
  initial: Record<string, string | Uint8Array> = {},
): StorageAdapter {
  const store = new Map<string, string | Uint8Array>(Object.entries(initial));
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, val) => {
      store.set(key, val);
    },
    remove: async (key) => {
      store.delete(key);
    },
  };
}

const STOA_INFO: NodeInfo = {
  nodeVersion: KADENA_NETWORK,
  nodeApiVersion: '0.0',
  nodeChains: ['0', '1', '2'],
};

/** A probe seam reporting a healthy Stoa node, so a custom apply succeeds. */
function healthyProbeDeps(): NodeInfoReadDeps {
  return { readNodeInfo: vi.fn(async () => STOA_INFO) };
}

/** A probe seam whose read rejects, so a custom apply fails with `unreachable`. */
function unreachableProbeDeps(): NodeInfoReadDeps {
  return {
    readNodeInfo: vi.fn(async () => {
      throw new Error('network-down');
    }),
  };
}

/** Stub the SDK's only network call (the `/info` health probe) as healthy. */
function stubHealthyInfoProbe(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true }) as Response),
  );
}

describe('applySelector (shared mapping + ordering — RR#8)', () => {
  beforeEach(() => {
    resetNodeFailover();
    stubHealthyInfoProbe();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetNodeFailover();
  });

  it('maps "default" to setNodeConfig("node1") then initNodeFailover, in that order', async () => {
    const calls: string[] = [];
    const deps = {
      setNodeConfig: vi.fn((selected: string) => {
        calls.push(`set:${selected}`);
      }),
      initNodeFailover: vi.fn(async () => {
        calls.push('init');
      }),
    };

    await applySelector({ kind: 'default' }, deps);

    // Ordering is load-bearing: failover-init reads the configured primary,
    // so setNodeConfig MUST land before init or the wrong primary boots.
    expect(calls).toEqual(['set:node1', 'init']);
  });

  it('maps "node2" to setNodeConfig("node2") then initNodeFailover', async () => {
    const calls: string[] = [];
    const deps = {
      setNodeConfig: vi.fn((selected: string) => {
        calls.push(`set:${selected}`);
      }),
      initNodeFailover: vi.fn(async () => {
        calls.push('init');
      }),
    };

    await applySelector({ kind: 'node2' }, deps);

    expect(calls).toEqual(['set:node2', 'init']);
  });

  it('maps "custom" to setNodeConfig("custom", customUrl) then initNodeFailover', async () => {
    const calls: string[] = [];
    const setNodeConfig = vi.fn((selected: string, url?: string) => {
      calls.push(`set:${selected}:${url ?? ''}`);
    });
    const deps = {
      setNodeConfig,
      initNodeFailover: vi.fn(async () => {
        calls.push('init');
      }),
    };

    await applySelector(
      { kind: 'custom', customUrl: 'https://node.example.com' },
      deps,
    );

    expect(calls).toEqual(['set:custom:https://node.example.com', 'init']);
    expect(setNodeConfig).toHaveBeenCalledWith(
      'custom',
      'https://node.example.com',
    );
  });
});

describe('applyNodePreference (runtime apply over the REAL SDK)', () => {
  beforeEach(() => {
    resetNodeFailover();
    stubHealthyInfoProbe();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetNodeFailover();
  });

  it('applies "default" -> setNodeConfig("node1") and the configured primary becomes node1', async () => {
    const node1 = sdkNode1Host();

    const result = await applyNodePreference({ kind: 'default' });

    expect(result.ok).toBe(true);
    expect(getNodeConfig().primary).toBe(node1);
  });

  it('applies "node2" -> the configured primary becomes node2', async () => {
    const node2 = sdkNode2Host();

    const result = await applyNodePreference({ kind: 'node2' });

    expect(result.ok).toBe(true);
    expect(getNodeConfig().primary).toBe(node2);
  });

  it('applies a healthy "custom" node to BOTH pact and spv endpoints (same custom host)', async () => {
    const customUrl = 'https://custom.example.com';

    const result = await applyNodePreference(
      { kind: 'custom', customUrl },
      { probeDeps: healthyProbeDeps() },
    );

    expect(result.ok).toBe(true);
    const chainId = '0';
    // A custom node is a single origin serving both pact (transactions) and
    // spv (proofs); both active URLs must resolve to the custom host.
    expect(getActivePactUrl(chainId).startsWith(customUrl)).toBe(true);
    expect(getActiveSpvUrl(chainId).startsWith(customUrl)).toBe(true);
  });

  it('retains the prior working config when a custom probe returns unreachable (never points at a broken endpoint)', async () => {
    // Establish a known-good prior config (node2) first.
    await applyNodePreference({ kind: 'node2' });
    const priorConfig = getNodeConfig();

    const result = await applyNodePreference(
      { kind: 'custom', customUrl: 'https://broken.example.com' },
      { probeDeps: unreachableProbeDeps() },
    );

    expect(result).toEqual({ ok: false, reason: 'unreachable' });
    // The failed apply did NOT touch setNodeConfig — the prior config is intact.
    expect(getNodeConfig()).toEqual(priorConfig);
  });

  it('returns malformed-url for an unparseable custom URL without issuing a probe or touching config', async () => {
    await applyNodePreference({ kind: 'node2' });
    const priorConfig = getNodeConfig();
    const readNodeInfo = vi.fn(async () => STOA_INFO);

    const result = await applyNodePreference(
      { kind: 'custom', customUrl: 'not a url' },
      { probeDeps: { readNodeInfo } },
    );

    expect(result).toEqual({ ok: false, reason: 'malformed-url' });
    expect(readNodeInfo).not.toHaveBeenCalled();
    expect(getNodeConfig()).toEqual(priorConfig);
  });

  it('returns insecure-scheme for an http custom URL and retains the prior config', async () => {
    await applyNodePreference({ kind: 'node2' });
    const priorConfig = getNodeConfig();

    const result = await applyNodePreference(
      { kind: 'custom', customUrl: 'http://node.example.com' },
      { probeDeps: healthyProbeDeps() },
    );

    expect(result).toEqual({ ok: false, reason: 'insecure-scheme' });
    expect(getNodeConfig()).toEqual(priorConfig);
  });

  it('round-trips a port-bearing https://host:8443 custom URL through setNodeConfig without throwing (RR#11)', async () => {
    const customUrl = 'https://host.example.com:8443';

    const result = await applyNodePreference(
      { kind: 'custom', customUrl },
      { probeDeps: healthyProbeDeps() },
    );

    expect(result.ok).toBe(true);
    // The origin-only normalized URL preserves the port; the SDK accepts it.
    expect(getNodeConfig().primary.startsWith(customUrl)).toBe(true);
  });

  it('never throws and never writes the custom URL to any console.* method', async () => {
    const URL_SECRET = 'https://secret.example.com:9443/leak?token=abc';
    const HOST_SUBSTR = 'secret.example.com';
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => undefined),
    );

    await expect(
      applyNodePreference(
        { kind: 'custom', customUrl: URL_SECRET },
        { probeDeps: unreachableProbeDeps() },
      ),
    ).resolves.toEqual({ ok: false, reason: 'unreachable' });

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const serialized = call.map((a) => String(a)).join(' ');
        expect(serialized).not.toContain(HOST_SUBSTR);
      }
    }
  });
});

describe('applyAndPersistNodePreference (validate -> apply -> persist, success-only)', () => {
  beforeEach(() => {
    resetNodeFailover();
    stubHealthyInfoProbe();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetNodeFailover();
  });

  it('persists a non-custom preference on success', async () => {
    const adapter = makeStorage();

    const result = await applyAndPersistNodePreference({ kind: 'node2' }, adapter);

    expect(result.ok).toBe(true);
    expect(await adapter.get(NODE_PREFERENCE_KEY)).toBe(
      JSON.stringify({ kind: 'node2' }),
    );
  });

  it('persists a healthy custom preference (with its origin-only URL) on success', async () => {
    const adapter = makeStorage();

    const result = await applyAndPersistNodePreference(
      { kind: 'custom', customUrl: 'https://custom.example.com/ignored-path' },
      adapter,
      { probeDeps: healthyProbeDeps() },
    );

    expect(result.ok).toBe(true);
    // Persists the origin-only normalized URL the apply path actually used.
    expect(await adapter.get(NODE_PREFERENCE_KEY)).toBe(
      JSON.stringify({ kind: 'custom', customUrl: 'https://custom.example.com' }),
    );
  });

  it('does NOT persist a rejected custom URL (a broken endpoint never reaches storage)', async () => {
    const adapter = makeStorage();

    const result = await applyAndPersistNodePreference(
      { kind: 'custom', customUrl: 'https://broken.example.com' },
      adapter,
      { probeDeps: unreachableProbeDeps() },
    );

    expect(result).toEqual({ ok: false, reason: 'unreachable' });
    expect(await adapter.get(NODE_PREFERENCE_KEY)).toBeNull();
  });
});

describe('custom node is its OWN fallback — no silent node2 leak (C-1 regression lock)', () => {
  beforeEach(() => {
    resetNodeFailover();
    stubHealthyInfoProbe();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetNodeFailover();
  });

  it('a healthy custom apply makes the custom origin BOTH the primary AND the fallback (never node2)', async () => {
    const node2 = sdkNode2Host();
    const customUrl = 'https://custom.example.com';

    const result = await applyNodePreference(
      { kind: 'custom', customUrl },
      { probeDeps: healthyProbeDeps() },
    );

    expect(result.ok).toBe(true);
    const config = getNodeConfig();
    // The privacy guarantee: a custom node is its own fallback. If anyone reverts
    // the SDK patch (FALLBACK_HOST = NODE2_HOST), `fallback` becomes node2 and the
    // wallet would silently leak the user's queries to a default node — failing here.
    expect(config.primary).toBe(customUrl);
    expect(config.fallback).toBe(customUrl);
    expect(config.fallback).not.toBe(node2);
    expect(node2).not.toBe(customUrl); // distinct hosts so the no-leak check has teeth
  });

  it('a port-bearing custom origin is also its own fallback (no node2 leak on non-default ports)', async () => {
    const node2 = sdkNode2Host();
    const customUrl = 'https://host.example.com:8443';

    const result = await applyNodePreference(
      { kind: 'custom', customUrl },
      { probeDeps: healthyProbeDeps() },
    );

    expect(result.ok).toBe(true);
    const config = getNodeConfig();
    expect(config.primary).toBe(customUrl);
    expect(config.fallback).toBe(customUrl);
    expect(config.fallback).not.toBe(node2);
  });
});

describe('revertToDefault (one-call restore of node1/node2 failover)', () => {
  beforeEach(() => {
    resetNodeFailover();
    stubHealthyInfoProbe();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetNodeFailover();
  });

  it('applies node1 and persists {kind:"default"} in a single action', async () => {
    const node1 = sdkNode1Host();
    // Start from a non-default persisted state to prove the revert overwrites it.
    const adapter = makeStorage({
      [NODE_PREFERENCE_KEY]: JSON.stringify({ kind: 'node2' }),
    });

    const result = await revertToDefault(adapter);

    expect(result.ok).toBe(true);
    expect(getNodeConfig().primary).toBe(node1);
    const persisted = await adapter.get(NODE_PREFERENCE_KEY);
    expect(persisted).toBe(JSON.stringify({ kind: 'default' } satisfies NodePreference));
  });

  it('restores the node1-primary / node2-fallback failover pair after a custom node was in effect (revert-restores-failover contract)', async () => {
    const node1 = sdkNode1Host();
    const node2 = sdkNode2Host();
    // A custom node (its own fallback, NO node2) was the prior live config.
    await applyNodePreference(
      { kind: 'custom', customUrl: 'https://custom.example.com' },
      { probeDeps: healthyProbeDeps() },
    );
    const adapter = makeStorage();

    const result = await revertToDefault(adapter);

    expect(result.ok).toBe(true);
    // Revert restores the default preset: node1 primary, node2 fallback. The
    // custom-only "no fallback" config is fully unwound, so normal failover resumes.
    const config = getNodeConfig();
    expect(config.primary).toBe(node1);
    expect(config.fallback).toBe(node2);
  });
});
