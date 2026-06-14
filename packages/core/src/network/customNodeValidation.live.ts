/**
 * Live (network-backed) read seam for {@link probeCustomNode}.
 *
 * This is the ONLY place the custom-node probe touches the network: a plain
 * `GET {origin}/info` `fetch`, modelled on the SDK failover health check
 * (`stoa-core/network/nodeFailover` — `GET /info` with a bounded timeout). It is
 * kept OUT of the package barrel so the barrel-reachable validation orchestrator
 * never statically imports a network call; the orchestrator imports this lazily
 * for its default path.
 *
 * Browser-safe: it imports no `node:*` module — only the global `fetch` — so it
 * runs unchanged in the extension popup, the service worker, and Capacitor.
 *
 * The candidate origin is never logged here (untrusted user input); a non-ok
 * HTTP status throws so the orchestrator collapses it to the `unreachable`
 * discriminated result without the URL escaping into a caught Error message.
 */
import type { NodeInfo, NodeInfoReadDeps } from './customNodeValidation';

/** Build the production `/info` read seam over the global `fetch`. */
export function makeLiveNodeInfoReadDeps(): NodeInfoReadDeps {
  return {
    async readNodeInfo(origin: string, signal: AbortSignal): Promise<NodeInfo> {
      const res = await fetch(`${origin}/info`, { signal });
      if (!res.ok) {
        throw new Error(`node /info returned HTTP ${res.status}`);
      }
      return (await res.json()) as NodeInfo;
    },
  };
}
