import { STOA_AUTONOMIC_OURONETGASSTATION } from '@stoachain/ouronet-core/constants';
import { selectCapsSigningKey } from '@stoachain/stoa-core/guard';
import { getActivePactUrl } from '@stoachain/stoa-core/network';

import type { ChainProbeResult } from './verify';

/** A single Pact capability with its name and positional args (Pact-typed). */
interface ProbeCapability {
  readonly name: string;
  readonly args: ReadonlyArray<string | { int: number } | { decimal: string }>;
}

interface ProbeSigner {
  readonly publicKey: string;
  readonly capabilities: readonly ProbeCapability[];
}

/**
 * The deterministic shape of a gasless probe transaction: the gas station is
 * the sender, and the fresh account's key signs exactly the gas-payer cap.
 * Kept transport-agnostic so the construction is unit-testable without a node.
 */
export interface GaslessProbeTxSpec {
  readonly chainId: string;
  readonly senderAccount: string;
  readonly signers: readonly ProbeSigner[];
}

/**
 * The cap shape the on-chain `ouronet-ns.DALOS` gas-payer module gates on:
 * `(ouronet-ns.DALOS.GAS_PAYER "" 0 0.0)`. The eligibility check keys off this
 * exact name + args; any drift causes a submit-time rejection.
 */
const GAS_PAYER_CAP: ProbeCapability = {
  name: 'ouronet-ns.DALOS.GAS_PAYER',
  args: ['', { int: 0 }, { decimal: '0.0' }],
};

/**
 * Build the gasless probe transaction spec for one chain.
 *
 * The gas station (`STOA_AUTONOMIC_OURONETGASSTATION`) is the sender on EVERY
 * chain — gasless is not chain-0-restricted. The fresh account's own key signs
 * the GAS_PAYER cap. Mirroring the reference wallet's call shape,
 * `selectCapsSigningKey(null, codexPubs={accountPub}, pureSigningPubs=∅)`
 * deterministically picks "any codex key not used for pure signing" — the fresh
 * account's key — never a hardcoded choice.
 */
export function buildGaslessProbeTx(params: {
  chainId: string;
  accountPublicKey: string;
}): GaslessProbeTxSpec {
  const { key } = selectCapsSigningKey(
    null,
    new Set<string>([params.accountPublicKey]),
    new Set<string>(),
  );

  if (key === null) {
    throw new Error(
      'selectCapsSigningKey could not resolve a cap-signing key for the gasless probe.',
    );
  }

  return {
    chainId: params.chainId,
    senderAccount: STOA_AUTONOMIC_OURONETGASSTATION,
    signers: [{ publicKey: key, capabilities: [GAS_PAYER_CAP] }],
  };
}

/** Minimal `/local` result shape the probe needs to classify a verdict. */
interface LocalResult {
  result: { status: string; error?: unknown };
}

/** Subset of the kadena client this probe uses — the SIGNED `/local` preflight. */
interface PreflightClient {
  preflight: (tx: unknown, options?: unknown) => Promise<LocalResult>;
}

export interface SignedLocalProbeDeps {
  readonly accountPublicKey: string;
  /** Signs the built probe tx with the fresh account's key (no key is logged). */
  readonly signTx: (tx: GaslessProbeTxSpec) => Promise<unknown>;
  /** Constructs a kadena client bound to a per-chain Pact endpoint. */
  readonly createClient: (pactUrl: string) => PreflightClient;
  /** Resolves the active node1 Pact endpoint for a chain. */
  readonly getActivePactUrl?: (chainId: string) => string;
}

/**
 * Build a per-chain probe that runs a SIGNED `/local` eligibility check.
 *
 * It builds the gasless tx spec, signs it with the fresh account's key, then
 * calls the kadena client's `preflight` (preflight + signatureVerification) —
 * which runs the gas-payer eligibility gate on the SIGNED envelope. A shape-only
 * `dirtyRead` is deliberately NOT used: it strips signatures and only confirms
 * the cap parses, so it can "pass" while a real submit later fails.
 *
 * Verdicts: node-success → `pass`; node-ran-and-rejected → `fail`; any thrown
 * transport error (node down / timeout) → `unreachable` (never a silent pass).
 */
export function makeSignedLocalProbe(deps: SignedLocalProbeDeps) {
  const resolveUrl = deps.getActivePactUrl ?? getActivePactUrl;

  return async function probe(chainId: string): Promise<ChainProbeResult> {
    const spec = buildGaslessProbeTx({
      chainId,
      accountPublicKey: deps.accountPublicKey,
    });

    try {
      const signed = await deps.signTx(spec);
      const client = deps.createClient(resolveUrl(chainId));
      const local = await client.preflight(signed, {
        preflight: true,
        signatureVerification: true,
      });

      return {
        chainId,
        outcome: local.result.status === 'success' ? 'pass' : 'fail',
      };
    } catch {
      // A thrown error means the node was unreachable / timed out — it never
      // counts as a pass. The error is not surfaced (it may echo tx bytes).
      return { chainId, outcome: 'unreachable' };
    }
  };
}
