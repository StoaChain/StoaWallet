import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getActivePactUrl,
  getActiveSpvUrl,
  getCurrentNodeStatus,
  getNodeConfig,
  resetNodeFailover,
  setNodeConfig,
} from '@stoachain/stoa-core/network';

import { configureNode } from '../configureNode';
import type { StorageAdapter } from '../../storage';
import { NODE_PREFERENCE_KEY } from '../../storage/storageKeys';

/**
 * node1's canonical host is derived from the SDK itself — applying
 * setNodeConfig("node1") and reading back the configured primary — so the
 * assertions below never hardcode the literal host. If the SDK ever renames
 * the seed node, these tests track it instead of asserting a stale string.
 */
function sdkNode1Host(): string {
  setNodeConfig('node1');
  const host = getNodeConfig().primary;
  resetNodeFailover();
  return host;
}

/** node2's canonical host from the SDK — used to prove a node2 pref was honored. */
function sdkNode2Host(): string {
  setNodeConfig('node2');
  const host = getNodeConfig().primary;
  resetNodeFailover();
  return host;
}

/** The custom origin the SDK derives from a given custom URL (origin-only). */
function sdkCustomHost(url: string): string {
  setNodeConfig('custom', url);
  const host = getNodeConfig().primary;
  resetNodeFailover();
  return host;
}

/** In-memory StorageAdapter double — records persisted preference blobs. */
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

/** A StorageAdapter seeded with a JSON-serialized NodePreference blob. */
function storageWithPref(
  pref: Record<string, unknown>,
): StorageAdapter {
  return makeStorage({ [NODE_PREFERENCE_KEY]: JSON.stringify(pref) });
}

/**
 * Stub the SDK health probe. The SDK's only network call is
 * `fetch(`${host}/info`)`; we intercept it and (a) record which host was
 * probed so call-ordering is observable, and (b) return a controllable
 * health verdict so active/primary state is deterministic.
 */
function stubInfoProbe(opts: { healthy: boolean; probedHosts: string[] }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const host = url.replace(/\/info$/, '');
      opts.probedHosts.push(host);
      return { ok: opts.healthy } as Response;
    }),
  );
}

describe('configureNode', () => {
  beforeEach(() => {
    resetNodeFailover();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetNodeFailover();
  });

  it('applies the node1 default BEFORE the startup health probe runs when no preference is persisted (empty StorageAdapter)', async () => {
    const node1 = sdkNode1Host();
    const probedHosts: string[] = [];
    stubInfoProbe({ healthy: true, probedHosts });

    await configureNode(makeStorage());

    // An empty adapter => getNodePreference returns {kind:"default"} =>
    // setNodeConfig("node1") BEFORE initNodeFailover. The probe hitting node1
    // proves the override landed before init; had init run first, the probe
    // would have hit the SDK-default node2 host and selected the wrong primary.
    expect(probedHosts).toContain(node1);
    expect(getNodeConfig().primary).toBe(node1);
  });

  it('routes both pact and spv endpoints through node1 when the default primary probes healthy', async () => {
    const node1 = sdkNode1Host();
    stubInfoProbe({ healthy: true, probedHosts: [] });

    await configureNode(makeStorage());

    const chainId = '0';
    // Healthy probe => active stays on the configured primary (node1), so
    // BOTH transaction (pact) and proof (spv) URLs must resolve to node1.
    expect(getActivePactUrl(chainId).startsWith(node1)).toBe(true);
    expect(getActiveSpvUrl(chainId).startsWith(node1)).toBe(true);
    expect(getCurrentNodeStatus().active).toBe(node1);
  });

  it('tolerates the transient active-fallback state: a failing node1 probe leaves primary === node1 and passes the self-check', async () => {
    const node1 = sdkNode1Host();
    stubInfoProbe({ healthy: false, probedHosts: [] });

    // node1 probe fails => SDK legitimately flips ACTIVE to node2, but the
    // CONFIGURED primary must remain node1. The self-check pins `primary`,
    // not `active`, so this must NOT throw.
    await expect(configureNode(makeStorage())).resolves.toBeUndefined();

    expect(getNodeConfig().primary).toBe(node1);
    expect(getCurrentNodeStatus().active).not.toBe(node1);
  });

  it('applies a persisted {kind:"node2"} preference and self-checks node2 as the configured primary (not a hardcoded node1)', async () => {
    const node1 = sdkNode1Host();
    const node2 = sdkNode2Host();
    const probedHosts: string[] = [];
    stubInfoProbe({ healthy: true, probedHosts });

    // A node2 preference must configure node2 as primary and STILL pass the
    // self-check, because the self-check validates the SELECTED primary — not a
    // hardcoded node1 literal. Distinct hosts ensure a no-op apply can't pass.
    await expect(
      configureNode(storageWithPref({ kind: 'node2' })),
    ).resolves.toBeUndefined();

    expect(node2).not.toBe(node1);
    expect(getNodeConfig().primary).toBe(node2);
    expect(probedHosts).toContain(node2);
  });

  it('applies a persisted {kind:"custom"} preference via setNodeConfig("custom", url) BEFORE initNodeFailover, resolving pact/spv to the custom host', async () => {
    const customUrl = 'https://custom.example.com';
    const customHost = sdkCustomHost(customUrl);
    const probedHosts: string[] = [];
    stubInfoProbe({ healthy: true, probedHosts });

    await expect(
      configureNode(storageWithPref({ kind: 'custom', customUrl })),
    ).resolves.toBeUndefined();

    const chainId = '0';
    // The custom origin is the configured primary; healthy probe keeps it
    // active, so pact + spv both route to the custom host. Probe-first ordering
    // is proved by the probe targeting the custom host (not the SDK default).
    expect(getNodeConfig().primary).toBe(customHost);
    expect(getActivePactUrl(chainId).startsWith(customHost)).toBe(true);
    expect(getActiveSpvUrl(chainId).startsWith(customHost)).toBe(true);
    expect(probedHosts).toContain(customHost);
  });

  it('boots a persisted custom node as its OWN fallback — never node2 (startup no-leak regression lock)', async () => {
    const node2 = sdkNode2Host();
    const customUrl = 'https://custom.example.com';
    const customHost = sdkCustomHost(customUrl);
    stubInfoProbe({ healthy: true, probedHosts: [] });

    await configureNode(storageWithPref({ kind: 'custom', customUrl }));

    const config = getNodeConfig();
    // The startup path must reproduce the runtime no-leak guarantee: a persisted
    // custom node is its own fallback. A reverted SDK patch would make `fallback`
    // node2, silently routing the user's queries to a default node at boot.
    expect(config.primary).toBe(customHost);
    expect(config.fallback).toBe(customHost);
    expect(config.fallback).not.toBe(node2);
    expect(node2).not.toBe(customHost); // distinct hosts give the no-leak check teeth
  });

  it('delegates the apply in order: reads the preference, then setNodeConfig, then initNodeFailover', async () => {
    stubInfoProbe({ healthy: true, probedHosts: [] });

    const calls: string[] = [];
    const adapter = makeStorage();
    const get = adapter.get;
    adapter.get = async (key) => {
      if (key === NODE_PREFERENCE_KEY) calls.push('getPreference');
      return get(key);
    };

    await configureNode(adapter, {
      setNodeConfig: (...args) => {
        calls.push('setNodeConfig');
        setNodeConfig(...args);
      },
      initNodeFailover: async () => {
        calls.push('initNodeFailover');
      },
    });

    // The preference MUST be read first, then the mapping applied via
    // setNodeConfig, then failover initialized. Any other order risks booting
    // onto the wrong primary (init reads the configured primary at init time).
    const setIdx = calls.indexOf('setNodeConfig');
    const initIdx = calls.indexOf('initNodeFailover');
    expect(calls.indexOf('getPreference')).toBeLessThan(setIdx);
    expect(setIdx).toBeLessThan(initIdx);
  });

  it('boots cleanly to node1 when getNodePreference recovers a corrupt blob (degrade-safe, no throw)', async () => {
    const node1 = sdkNode1Host();
    stubInfoProbe({ healthy: true, probedHosts: [] });

    // A malformed persisted blob => getNodePreference returns
    // {kind:"default", recoveredFromCorrupt:true}. configureNode must still
    // boot to node1 rather than wedge on the corruption.
    const corrupt = makeStorage({ [NODE_PREFERENCE_KEY]: '{not valid json' });
    await expect(configureNode(corrupt)).resolves.toBeUndefined();

    expect(getNodeConfig().primary).toBe(node1);
  });

  it('does NOT re-run a network probe of the custom URL at boot beyond the failover health check', async () => {
    const customUrl = 'https://custom.example.com';
    const customHost = sdkCustomHost(customUrl);
    const probedHosts: string[] = [];
    stubInfoProbe({ healthy: true, probedHosts });

    await configureNode(storageWithPref({ kind: 'custom', customUrl }));

    // The custom URL was validated when the user accepted it; boot does NOT
    // re-probe it via the T10.2 validation path. The ONLY network touch is the
    // failover /info health check against the configured primary host.
    const customProbes = probedHosts.filter((h) => h === customHost);
    expect(customProbes.length).toBeGreaterThan(0);
    for (const h of probedHosts) {
      // No probe should target anything but the configured custom host (no
      // extra reachability re-probe of arbitrary endpoints).
      expect(h).toBe(customHost);
    }
  });

  it('fails loudly when the override does not land on the selected primary (wrong-primary selection must never pass silently)', async () => {
    stubInfoProbe({ healthy: true, probedHosts: [] });

    // Inject a setNodeConfig that ignores the requested selection and leaves
    // the SDK on its node2 default — simulating an override that silently
    // failed to take effect. The startup self-check MUST surface this loudly
    // rather than booting the wallet onto the wrong transaction host.
    await expect(
      configureNode(makeStorage(), { setNodeConfig: () => {} }),
    ).rejects.toThrow();
  });

  it('reports the actually-configured primary in the loud-failure message (diagnosable boot error)', async () => {
    stubInfoProbe({ healthy: true, probedHosts: [] });

    // The SDK default primary is node2; the error must name what it found so
    // a misconfigured boot is diagnosable from the message alone.
    let captured: unknown;
    try {
      await configureNode(makeStorage(), { setNodeConfig: () => {} });
    } catch (err) {
      captured = err;
    }
    expect((captured as Error).message).toContain(getNodeConfig().primary);
  });

  it('never logs the custom URL on a successful custom boot', async () => {
    const customUrl = 'https://secret-rpc.example.com';
    stubInfoProbe({ healthy: true, probedHosts: [] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await configureNode(storageWithPref({ kind: 'custom', customUrl }));

    for (const spy of [logSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('secret-rpc.example.com');
      }
    }
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
