import { afterEach, describe, expect, it, vi } from 'vitest';
import { KADENA_NETWORK } from '@stoachain/stoa-core/constants';

import {
  validateCustomNodeUrl,
  probeCustomNode,
  validateAndProbe,
  type NodeInfoReadDeps,
  type NodeInfo,
} from '../customNodeValidation';

/**
 * Build a node-info read seam double returning a fixed `/info` payload.
 * Mirrors the REAL Chainweb `/info` shape: `nodeVersion` is the ChainwebVersion
 * (the network name); a Stoa node reports `nodeVersion === "stoa"`.
 */
function makeInfoDeps(info: NodeInfo): NodeInfoReadDeps {
  return { readNodeInfo: vi.fn(async () => info) };
}

const STOA_INFO: NodeInfo = {
  nodeVersion: KADENA_NETWORK,
  nodeApiVersion: '0.0',
  nodeChains: ['0', '1', '2'],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateCustomNodeUrl (shape — pure, no network)', () => {
  it('rejects a non-URL string as malformed-url because new URL() cannot parse it', () => {
    const result = validateCustomNodeUrl('not a url at all');
    expect(result).toEqual({ ok: false, reason: 'malformed-url' });
  });

  it('rejects an http:// URL as insecure-scheme because signed payloads must not travel plaintext', () => {
    const result = validateCustomNodeUrl('http://node.example.com');
    expect(result).toEqual({ ok: false, reason: 'insecure-scheme' });
  });

  it('rejects a javascript: URL as insecure-scheme to close the untrusted-input/XSS footgun', () => {
    const result = validateCustomNodeUrl('javascript:alert(1)');
    expect(result).toEqual({ ok: false, reason: 'insecure-scheme' });
  });

  it('rejects a data: URL as insecure-scheme (non-https schemes are not allow-listed)', () => {
    expect(validateCustomNodeUrl('data:text/plain,hi')).toEqual({
      ok: false,
      reason: 'insecure-scheme',
    });
  });

  it('rejects a file: URL as insecure-scheme (non-https schemes are not allow-listed)', () => {
    expect(validateCustomNodeUrl('file:///etc/passwd')).toEqual({
      ok: false,
      reason: 'insecure-scheme',
    });
  });

  it('accepts an https URL and returns the ORIGIN only, discarding path/query/fragment', () => {
    const result = validateCustomNodeUrl('https://node.example.com/path?q=1#frag');
    expect(result).toEqual({ ok: true, url: 'https://node.example.com' });
  });

  it('preserves a non-default port in the origin-only normalized URL', () => {
    const result = validateCustomNodeUrl('https://host:8443/x');
    expect(result).toEqual({ ok: true, url: 'https://host:8443' });
  });
});

describe('probeCustomNode (reachability + network identity — stubbed read)', () => {
  it('returns unreachable when the node-info read rejects (fetch failure / timeout)', async () => {
    const deps: NodeInfoReadDeps = {
      readNodeInfo: vi.fn(async () => {
        throw new Error('secret-bearing-network-failure');
      }),
    };

    const result = await probeCustomNode('https://node.example.com', { deps });

    expect(result).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('returns wrong-network when a reachable node reports a non-stoa nodeVersion', async () => {
    const deps = makeInfoDeps({ ...STOA_INFO, nodeVersion: 'mainnet01' });

    const result = await probeCustomNode('https://node.example.com', { deps });

    expect(result).toEqual({ ok: false, reason: 'wrong-network' });
  });

  it('returns ok when a reachable node reports the stoa network (nodeVersion === KADENA_NETWORK)', async () => {
    const deps = makeInfoDeps(STOA_INFO);

    const result = await probeCustomNode('https://node.example.com', { deps });

    expect(result).toEqual({ ok: true });
  });

  it('resolves to unreachable (non-error early return) when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const readNodeInfo = vi.fn(async () => STOA_INFO);

    const result = await probeCustomNode('https://node.example.com', {
      deps: { readNodeInfo },
      signal: controller.signal,
    });

    // RR#7: abort resolves as a documented non-error early return, NOT a thrown
    // AbortError. The read is never issued for an already-aborted signal.
    expect(result).toEqual({ ok: false, reason: 'unreachable' });
    expect(readNodeInfo).not.toHaveBeenCalled();
  });

  it('resolves to unreachable when the signal aborts mid-flight instead of throwing', async () => {
    const controller = new AbortController();
    const readNodeInfo = vi.fn(
      async () =>
        new Promise<NodeInfo>((_resolve, reject) => {
          // The seam observes the abort and rejects with an AbortError, exactly
          // as a fetch with the forwarded signal would.
          controller.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );

    const pending = probeCustomNode('https://node.example.com', {
      deps: { readNodeInfo },
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, reason: 'unreachable' });
  });
});

describe('validateAndProbe (shape → probe chain)', () => {
  it('short-circuits on a shape failure WITHOUT issuing the network read', async () => {
    const readNodeInfo = vi.fn(async () => STOA_INFO);

    const result = await validateAndProbe('http://node.example.com', {
      deps: { readNodeInfo },
    });

    expect(result).toEqual({ ok: false, reason: 'insecure-scheme' });
    expect(readNodeInfo).not.toHaveBeenCalled();
  });

  it('probes the origin-only normalized URL after the shape check passes', async () => {
    const readNodeInfo = vi.fn(async () => STOA_INFO);

    const result = await validateAndProbe('https://node.example.com/path?q=1', {
      deps: { readNodeInfo },
    });

    // The success carries the origin-only normalized URL — the exact string
    // T10.3 hands to setNodeConfig — and the read was issued against that origin.
    expect(result).toEqual({ ok: true, url: 'https://node.example.com' });
    expect(readNodeInfo).toHaveBeenCalledWith(
      'https://node.example.com',
      expect.anything(),
    );
  });
});

describe('never-log-carelessly discipline', () => {
  it('writes the candidate URL to no console.* method across every shape and probe path', async () => {
    const URL_SECRET = 'https://attacker.example.com:8443/leak?token=abc';
    const HOST_SUBSTR = 'attacker.example.com';
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => undefined),
    );

    validateCustomNodeUrl('http://attacker.example.com');
    validateCustomNodeUrl(URL_SECRET);
    validateCustomNodeUrl('not a url attacker.example.com');

    await probeCustomNode(URL_SECRET, {
      deps: {
        readNodeInfo: vi.fn(async () => {
          throw new Error('boom attacker.example.com');
        }),
      },
    });
    await probeCustomNode(URL_SECRET, {
      deps: makeInfoDeps({ ...STOA_INFO, nodeVersion: 'mainnet01' }),
    });
    await validateAndProbe(URL_SECRET, { deps: makeInfoDeps(STOA_INFO) });

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        const serialized = call.map((a) => String(a)).join(' ');
        expect(serialized).not.toContain(HOST_SUBSTR);
      }
    }
  });
});
