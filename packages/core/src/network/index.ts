export { configureNode } from './configureNode';
export type { ConfigureNodeDeps } from './configureNode';

export { getNodePreference, setNodePreference } from './nodePreference';
export type { NodePreference } from './nodePreference';

// Live node-failover status reads (re-exported from the SDK) for the active-node
// display — the configured `{primary,fallback}` and the live `active`/`isOnPrimary`.
export { getCurrentNodeStatus, getNodeConfig } from './nodeStatus';
export type { NodeConfig, NodeStatus } from './nodeStatus';

export {
  validateCustomNodeUrl,
  probeCustomNode,
  validateAndProbe,
  PROBE_TIMEOUT_MS,
} from './customNodeValidation';
export type {
  ValidateUrlResult,
  ProbeResult,
  ValidateAndProbeResult,
  NodeInfo,
  NodeInfoReadDeps,
  ProbeOptions,
} from './customNodeValidation';

// The shared selector (mapping + setNodeConfig-before-initNodeFailover ordering)
// imported by BOTH the runtime applier below and the startup `configureNode`.
export { applySelector } from './applySelector';
export type { ApplySelectorDeps } from './applySelector';

// The runtime node-preference applier: applies a preference WITHOUT restart,
// validates+probes a custom URL before applying (retaining the prior config on
// failure), persists success-only, and reverts to default in one action. The
// apply path never throws and never logs the URL.
export {
  applyNodePreference,
  applyAndPersistNodePreference,
  revertToDefault,
} from './applyNodePreference';
export type { ApplyResult, ApplyFailureReason, ApplyOptions } from './applyNodePreference';
