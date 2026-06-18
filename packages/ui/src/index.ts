import { coreInfo, type CoreInfo } from '@stoawallet/core';

/**
 * Placeholder surface for the shared StoaWallet UI package.
 *
 * The real screens (unlock, balances, send, receive, crosschain) live here
 * later and are rendered by both apps/extension and apps/mobile. For now this
 * re-exports core metadata to prove cross-package type resolution works.
 */
export interface UiInfo {
  readonly name: string;
  readonly core: CoreInfo;
}

export const uiInfo: UiInfo = {
  name: '@stoawallet/ui',
  core: coreInfo,
};

// Shared onboarding/wallet React context — the surface the unlock/balances/
// send/receive/crosschain flows consume. Apps inject their concrete
// StorageAdapter + KeyVault via `WalletProvider`.
export {
  WalletProvider,
  useWallet,
  type WalletContextValue,
  type WalletProviderProps,
  type WalletActionResult,
  type WalletActionReason,
  type OnboardingMode,
  type ExistingWalletSummary,
  type ActiveWalletSummary,
  type ContextAddAdvancedResult,
  type ContextResolveForeignKeyResult,
  type ContextResolveAdvancedSigningResult,
  type RemoteVault,
  type RemoteUnlockResult,
  type RemoteAccount,
  type RemoteSignOutcome,
  type RemoteUrStoaOutcome,
  type RemoteWalletSummary,
  type RemotePureKeypair,
  type RemoteImportCodexResult,
  type ContextUrStoaResult,
  type ContextUrStoaStakeParams,
  type ContextUrStoaCollectParams,
  type ContextUrStoaTransferParams,
} from './context/WalletContext';

// The composed root shell BOTH apps mount (extension popup + Capacitor mobile).
// Renders onboarding / unlock / tabbed-home off the wallet context — no router.
export { WalletApp } from './app/WalletApp';

// MV3 SW-lifecycle guard: re-derives the unlocked-state from the background (the
// single source of truth) on popup open + tracks a mid-session "session expired".
export {
  useSessionGuard,
  type SessionGuard,
  type SessionGuardStatus,
} from './app/useSessionGuard';

// Shared form controls. PasswordInput: a controlled password field with a local
// show/hide reveal toggle, used by every password-entry screen (create/import/unlock).
export { PasswordInput, type PasswordInputProps } from './components/PasswordInput';

// The premium brand splash (logo + gold-orb background + wordmark + content
// slot) shared by the unlock + onboarding surfaces. Splash-only treatment.
export { BrandSplash, type BrandSplashProps } from './components/BrandSplash';

// Onboarding flows (create / import) and wallet screens (unlock / account switcher).
export { CreateWalletFlow, type CreateWalletFlowProps } from './onboarding/CreateWalletFlow';
export { ImportWalletFlow, type ImportWalletFlowProps } from './onboarding/ImportWalletFlow';
export { UnlockScreen, type UnlockScreenProps } from './wallet/UnlockScreen';
export { AccountSwitcher, type AccountSwitcherProps } from './wallet/AccountSwitcher';

// Design tokens (DESIGN.md palette + canonical token glyphs ❖/✦). `theme.css` carries the CSS vars.
export { palette, status, tokenGlyphs, fontSans, type TokenSymbol } from './theme/tokens';
export { TokenGlyph, type TokenGlyphProps } from './theme/TokenGlyph';

// Balances (Phase 3): per-chain Stoa Coin balances + aggregate total for the active account.
export {
  classifyChainBalance,
  aggregateTotal,
  type ChainBalanceStatus,
  type ChainBalanceReadResult,
  type AggregateTotal,
} from './balances/balanceModel';
export {
  useBalances,
  type GetBalancesFn,
  type UseBalancesOptions,
  type UseBalancesResult,
} from './balances/useBalances';
export { ChainBalanceRow, type ChainBalanceRowProps } from './balances/ChainBalanceRow';
export { BalancesView, type BalancesViewProps } from './balances/BalancesView';

// AmountDisplay: the canonical 12-decimal STOA/UrStoa money renderer. European
// separators (`.` thousands, `,` decimal), the full 12 decimals split 3-full /
// 9-half size, a token glyph alongside, null→dash. Operates on the decimal STRING
// (never `Number`), so a 12-decimal balance keeps every digit.
export { AmountDisplay, type AmountDisplayProps } from './components/AmountDisplay';

// The Stoa tab: the native Stoa-coin home — a 10-chain selector, the active
// account line, the dual balance (all-chain SUM hero + selected-chain sub), a
// refresh, and the Send/Receive/Cross-chain/Miner actions opened as routed
// sub-views. Mounted as the default destination of the bottom-nav HOME shell.
export { StoaTab, type StoaTabProps } from './stoa/StoaTab';

// Receive (Phase 4): active k: address as text + QR + copy.
export { ReceiveView } from './receive/ReceiveView';
// Send same-chain gasless (Phase 4): state hook + form.
export {
  useSendSameChain,
  type SendState,
  type SendPreview,
  type SendParams,
  type UseSendSameChainOptions,
  type UseSendSameChainResult,
} from './send/useSendSameChain';
export { SendForm, type SendFormProps } from './send/SendForm';

// Cross-chain transfer (Phase 5): staged Step-0 burn → SPV proof → Step-1
// continuation state machine with durable anti-fund-stranding rehydrate.
export {
  useCrossChainTransfer,
  type CrossChainTransferState,
  type CrossChainTransferParams,
  type PersistedInflightTransfer,
  type UseCrossChainTransferOptions,
  type UseCrossChainTransferResult,
} from './crosschain/useCrossChainTransfer';

// Crosschain recovery (Phase 5): RESUME a stalled cross-chain transfer's step-1
// continuation — never restarts the burn, holds no key material.
export {
  useContinuationResume,
  type ResumeState,
  type ResumeCrossChainFn,
  type UseContinuationResumeOptions,
  type UseContinuationResumeResult,
} from './crosschain/useContinuationResume';
export {
  CrossChainTransferForm,
  type CrossChainTransferFormProps,
  type CrossChainRecoveryRoute,
} from './crosschain/CrossChainTransferForm';
export {
  ContinuationRecoveryView,
  type ContinuationRecoveryViewProps,
  type ContinuationRecoveryPrefill,
} from './crosschain/ContinuationRecoveryView';

// Advanced accounts (Phase 6): w:/r:/key-guarded account add + analysis + private-key paste.
export {
  useAdvancedAccounts,
  type AdvancedAddState,
  type UseAdvancedAccountsOptions,
  type UseAdvancedAccountsResult,
} from './advanced/useAdvancedAccounts';
export { AddAdvancedAccount, type AddAdvancedAccountProps } from './advanced/AddAdvancedAccount';
export { PasteKeyModal, type PasteKeyModalProps } from './advanced/PasteKeyModal';

// dApp approval surface (Phase 9): the in-popup connection + signature approval
// screen the router opens as a window. Reject-by-default; reuses UnlockScreen
// when the vault is locked; previews a GENERIC Pact command (code + signers +
// caps) before signing. Holds no key material.
export { ApprovalApp, type ApprovalAppProps } from './dapp/approval/ApprovalApp';
export {
  ConnectionApprovalView,
  type ConnectionApprovalViewProps,
} from './dapp/approval/ConnectionApprovalView';
export {
  SignatureApprovalView,
  type SignatureApprovalViewProps,
} from './dapp/approval/SignatureApprovalView';
export {
  decodePactPreview,
  decodePactPreviews,
  type PactPreview,
  type PactSigner,
  type PactCapability,
} from './dapp/approval/decodePactPreview';
export type {
  ApprovalPendingRequest,
  ApprovalDecision,
  ApprovalCommandSigData,
  ApprovalSig,
} from './dapp/approval/approvalTypes';

// Settings (Phase 10): the node-endpoint surface. `SettingsProvider` wraps the
// T10.3 runtime applier behind the INJECTED StorageAdapter (extension/mobile swap
// the concrete adapter); `NodeSettings` is the default/node2/custom selector with
// apply / revert / current-active-node / per-reason feedback / trust warning. The
// `<WalletApp>` shell mounts it under a "Settings" tab using `useWallet().storage`.
export {
  SettingsProvider,
  useSettings,
  type SettingsContextValue,
  type SettingsProviderProps,
  type SettingsDeps,
} from './settings/SettingsContext';
export { NodeSettings } from './settings/NodeSettings';
export {
  useNodeApply,
  type NodeApplyState,
  type UseNodeApplyResult,
} from './settings/useNodeApply';

// Miner aggregation (Phase 11): the state hook composing the pre-scan → T11.1
// buildSweepPlan → T11.2 aggregateAcrossChains into a per-chain React state
// machine, with up-front keypair resolution (XP-1), TIMEOUT-as-pending recovery
// routing, and XP-5 rehydrate/reconcile. Holds no key material; logs no secrets.
export {
  useMinerAggregation,
  type ChainEntry,
  type MinerRecoveryRoute,
  type ResolveSweepSignersResult,
  type AggregateAcrossChainsFn,
  type MinerResumeCrossChainFn,
  type UseMinerAggregationOptions,
  type UseMinerAggregationResult,
} from './miner/useMinerAggregation';
// The miner-aggregation VIEW (Phase 11): composes the hook into a target selector
// + funded-source cards (full-balance MAX), a gasless disclosure, per-chain staged
// progress, the PENDING→Continue-tab recovery route, and the RR#5 three-way
// (aggregated/pending/failed) result. Mounted under a "Miner" tab in `<WalletApp>`.
export {
  MinerAggregationView,
  type MinerAggregationViewProps,
} from './miner/MinerAggregationView';

// UrStoa holdings/movement/staking/vault (Phase 12): the PURE amount/decimal/
// glyph domain root every core wrapper + UI consumer shares. The injection-safe
// 3-decimal (UrStoa) Pact-amount formatter, the `{ decimal }` hover-unwrap (NEVER
// String()), the fail-closed last-staker-floor `maxUnstake`, and the silver ✦ /
// gold ❖ token marks. No React state, no I/O.
export { formatUrStoaAmount, unwrapDecimal, URSTOA_DECIMALS } from './urstoa/amount';
export { maxUnstake, type MaxUnstakeResult } from './urstoa/maxUnstake';
export { UrStoaMark, StoaMark } from './urstoa/glyph';
// UrStoa holdings state hook (Phase 12): the active `k:` account's wallet/vault/
// earnings + live vault total on chain 0 (SINGLE account, not a 10-chain
// fan-out). Mirrors `useBalances`' cancellation/nonce guard, isLoading vs
// isRefreshing split, and lock-clears-stale discipline. null≠"0": a failed read
// or null vault balance is a DISTINCT `isUnknown`, never a coerced "0".
export {
  useUrStoaHoldings,
  type GetUrStoaHoldingsFn,
  type GetVaultTotalFn,
  type UseUrStoaHoldingsOptions,
  type UseUrStoaHoldingsResult,
} from './urstoa/useUrStoaHoldings';
// UrStoa stake/unstake state hook (Phase 12): the staged money-moving hook wiring
// the T12.3 core stake/unstake into React — resolves the active payment key +
// signing keypair through the WalletContext seam (XP-12; remote mode honestly
// `locked`), enforces the last-staker floor over the live vault total (fail-closed
// on unknown), bounds the amount by the wallet/staked balance, double-submit
// guarded, and fires the T12.6 holdings refresh on success. Holds no key material;
// logs no secrets.
export {
  useStakeUnstakeUrStoa,
  type StakeUnstakeState,
  type StakeUnstakeKind,
  type UrStoaOpSeam,
  type UseStakeUnstakeUrStoaOptions,
  type UseStakeUnstakeUrStoaResult,
} from './urstoa/useStakeUnstakeUrStoa';
// UrStoa native TRANSFER state hook (Phase 12): wires the T12.5 core transfer into
// React — recipient + amount validation (Phase-4), the RR#5 preview→confirm gate,
// the RR#6 double-submit/pending guard, XP-12 context signer resolution (honest
// `locked` in remote mode), and the T12.6 holdings refresh on success. Chain-0
// only (no chain selector); holds no key material, logs no secrets.
export {
  useTransferUrStoa,
  type TransferState,
  type TransferPreview,
  type TransferParams,
  type TransferUrStoaSeam,
  type UseTransferUrStoaOptions,
  type UseTransferUrStoaResult,
} from './urstoa/useTransferUrStoa';
// UrStoa Collect state hook (Phase 12): wires the T12.4 core Collect into React.
// Gates on NON-ZERO earnings via the T12.1 `{decimal}`-unwrap + a numeric `> 0`
// (never String()/truthiness — the Collect-wrongly-disabled guard, RR#7); resolves
// the active payment key + the active account's OWN keypair (RR#1) up-front through
// the SAME context seam Phase-11/Phase-4/T12.7 use (honest `locked` in extension
// remote mode — XP-12); double-submit/pending guarded; fires the T12.6 holdings
// refresh() on success. Holds no key material; logs no secrets.
export {
  useCollectUrStoa,
  type CollectState,
  type CollectUrStoaSeam,
  type UseCollectUrStoaOptions,
  type UseCollectUrStoaResult,
} from './urstoa/useCollectUrStoa';
// The UrStoa COLLECT action VIEW (Phase 12): composes `useCollectUrStoa` into the
// claimable-earnings figure (STOA, gold ❖) + a single gasless Collect control whose
// disabled state binds to the hook's `canCollect` (the unwrap + numeric>0 gate, never
// a view-side String()/truthiness — RR#7). Staged progress + distinct success(request
// key)/pending/error/locked panels. Presentation + the hook only; no core, no signing.
export { CollectUrStoa, type CollectUrStoaProps } from './urstoa/CollectUrStoa';
// The UrStoa AssetItem CARD (Phase 12): the chain-0 holdings panel composing the
// T12.6 `useUrStoaHoldings` hook — a WALLET + VAULT (staked) row in silver ✦ and
// a VAULT EARNINGS row in gold ❖ (STOA-denominated earnings use gold even on a
// UrStoa card). EXCLUDES the wrapped-balance/wrapped-id rows. Distinct loading /
// refreshing / unknown / error / idle states (null ≠ "0"). The Stake / Unstake /
// Collect / Transfer affordances fire the handler props the T12.11/12/13 modals
// plug into. Pure presentation; no core import, no signing, no telemetry.
export { UrStoaCard, type UrStoaCardProps } from './urstoa/UrStoaCard';
// UrStoa native TRANSFER modal (Phase 12): composes the T12.9 `useTransferUrStoa`
// hook into a recipient k: + decimal-aware amount form, the RR#5 preview→confirm
// gate (gasless sponsor + new-account keyset note disclosed), staged progress, and
// a distinct affordance per terminal state (success requestKey / gas-payer-rejected /
// insufficient-funds / pending — never a false success or auto-resubmit; `locked`
// routes to unlock). Chain-0 only (no chain selector). Opened by `UrStoaCard`'s
// `onTransfer` owner via `open`/`onClose`. Presentation + the hook only — no core
// import, no signing; logs no recipient/amount/key material.
export {
  TransferUrStoaModal,
  type TransferUrStoaModalProps,
} from './urstoa/TransferUrStoaModal';
// The UrStoa STAKE / UNSTAKE modal (Phase 12): presentation over the T12.7
// `useStakeUnstakeUrStoa` hook — a mode toggle, a decimal-aware amount input with
// a floor-aware "max" (REQ-21: `userStaked - 1.0` when sole staker; a distinct
// "vault total unavailable" affordance when the vault total is unknown, never a
// 0/full max), a gold gasless badge, a confirm driving the staged flow, and a
// per-state result panel (success/pending request key, distinct error, locked →
// unlock). The amount flows to the hook as a precise STRING (no Number round-trip).
// The T12.10 card opens it via its onStake/onUnstake affordances (initialKind).
// Holds no key material; logs no secrets.
export {
  StakeUnstakeUrStoaModal,
  type StakeUnstakeHoldings,
  type StakeUnstakeUrStoaModalProps,
} from './urstoa/StakeUnstakeUrStoaModal';
