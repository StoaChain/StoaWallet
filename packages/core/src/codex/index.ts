/**
 * Codex interop barrel — importing an Ouronet Codex export into this wallet's
 * vault. Pure mapper (injected crypto seams); no storage I/O, no SDK transport.
 */
export {
  importCodex,
  type CodexExport,
  type ImportCodexDeps,
  type ImportCodexResult,
  type ImportCodexMerge,
  type ExistingWalletView,
  type ImportCodexOutcome,
  type ImportCodexFailure,
} from './importCodex';
