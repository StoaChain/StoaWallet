/**
 * Live (node-backed) deps for {@link sendSameChain}.
 *
 * This file is the ONLY place the same-chain flow touches the real SDK Pact
 * builder + node-active client, mirroring `gasless/liveRun.ts`. It is kept OUT
 * of the package barrel on purpose: the SDK's `Pact`/`createClient` carry
 * unresolved types, so the construction lives here behind the typed
 * {@link SameChainDeps} seam rather than polluting the barrel-reachable
 * orchestrator. The orchestrator imports this lazily for its default path.
 *
 * It imports no `node:fs`/`node:path` — only the SDK client — so it stays
 * browser-safe even though it is out of the barrel.
 */
import {
  Pact,
  createClient,
} from '@stoachain/kadena-stoic-legacy/client';
import type { ChainId } from '@stoachain/kadena-stoic-legacy/types';
import {
  anuToStoa,
  calculateAutoGasLimit,
  GAS_PRICE_MIN_ANU,
} from '@stoachain/stoa-core/gas';
import { getActivePactUrl } from '@stoachain/stoa-core/network';
import { fromKeypair, universalSignTransaction } from '@stoachain/stoa-core/signing';
import { STOA_AUTONOMIC_OURONETGASSTATION } from '@stoachain/ouronet-core/constants';

import type { BuiltTx, SameChainDeps, SimulateResult } from './sendSameChain';

const STOA_NETWORK_ID = 'stoa';
const TX_TTL_SECONDS = 600;
const SIMULATE_GAS_LIMIT = 500_000;

/** A capability parsed from its Pact-code line into a structured name + args. */
interface ParsedCapability {
  readonly name: string;
  readonly args: readonly unknown[];
}

/**
 * Parse a single Pact-code capability line into the structured `{ name, args }`
 * the `@kadena/client` `withCapability(name, ...args)` builder expects — a
 * VERBATIM port of OuronetUI's `parseCapabilityLine` (the working reference).
 *
 * This is the fix for the same-chain submit failure: previously the live seam
 * passed the WHOLE Pact-code string (e.g. `(coin.TRANSFER "a" "b" 0.25)`) as the
 * capability NAME with no args, producing a malformed, un-granted capability.
 * `dirtyRead` ignores signatures/caps so simulation still passed, but `submit`
 * rejected because the real `coin.TRANSFER` / `DALOS.GAS_PAYER` caps were never
 * actually authorized. Parsing the line into name + typed args fixes it.
 *
 * Arg typing mirrors the reference: a quoted token → string; all-digits → a Pact
 * integer `{ int }`; a decimal token → a Pact decimal `{ decimal }`; anything
 * else → a raw string.
 */
function parseCapabilityLine(line: string): ParsedCapability | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    const inner = trimmed.slice(1, -1);
    const spaceIndex = inner.indexOf(' ');
    if (spaceIndex === -1) {
      return { name: inner, args: [] };
    }

    const name = inner.slice(0, spaceIndex);
    const argsString = inner.slice(spaceIndex + 1);
    const argMatches = argsString.match(/("([^"\\]|\\.)*"|[^\s]+)/g) ?? [];

    const args = argMatches.map((arg) => {
      if (arg.startsWith('"') && arg.endsWith('"')) return arg.slice(1, -1);
      if (/^\d+$/.test(arg)) return { int: parseInt(arg, 10) };
      if (/^\d*\.\d+$/.test(arg)) return { decimal: arg };
      return arg;
    });

    return { name, args };
  }

  // Bare `module.CAP` (must contain a dot to be a valid qualified name).
  if (trimmed.includes('.')) return { name: trimmed, args: [] };
  return null;
}

export { parseCapabilityLine };

/**
 * Build the production deps: a node-active client for the SELECTED chain plus
 * the SDK gas/sign helpers. Each leg resolves the active pact URL for the chain
 * so a node failover is picked up.
 */
export function makeLiveSameChainDeps(): SameChainDeps {
  return {
    async readAccountExists(account, chainId) {
      const { dirtyRead } = createClient(getActivePactUrl(chainId));
      const probe = Pact.builder
        .execution(`(coin.details "${account}")`)
        .setMeta({
          senderAccount: STOA_AUTONOMIC_OURONETGASSTATION,
          chainId: chainId as ChainId,
          gasLimit: SIMULATE_GAS_LIMIT,
          gasPrice: anuToStoa(GAS_PRICE_MIN_ANU),
          ttl: TX_TTL_SECONDS,
        })
        .setNetworkId(STOA_NETWORK_ID)
        .createTransaction();
      const res = (await dirtyRead(probe as never)) as SimulateResult;
      // `coin.details` succeeds for an existing account and fails (row-not-found)
      // for an absent one; existence === a successful read.
      return res.result?.status === 'success';
    },

    buildTx(spec) {
      const builder = Pact.builder
        .execution(spec.pactCode)
        .setMeta({
          senderAccount: spec.senderAccount,
          chainId: spec.chainId as ChainId,
          gasLimit: spec.gasLimit,
          gasPrice: spec.gasPriceStoa,
          ttl: TX_TTL_SECONDS,
        })
        .setNetworkId(STOA_NETWORK_ID);

      const parsed = JSON.parse(spec.payloadJson) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        builder.addData(key, value as never);
      }

      // Sender's own key signs BOTH the GAS_PAYER cap and the coin.TRANSFER cap.
      // Each cap line is PARSED into name + typed args (mirroring OuronetUI's
      // working reference) — passing the raw Pact-code string as the cap name
      // produces an un-granted capability that fails at submit.
      builder.addSigner(
        spec.signerPublicKey,
        ((withCapability: (name: string, ...args: unknown[]) => unknown) =>
          spec.caps
            .map((cap) => parseCapabilityLine(cap))
            .filter((parsed): parsed is ParsedCapability => parsed !== null)
            .map((parsed) =>
              withCapability(parsed.name, ...parsed.args),
            )) as never,
      );

      return builder.createTransaction() as unknown as BuiltTx;
    },

    async dirtyRead(tx, chainId) {
      const { dirtyRead } = createClient(getActivePactUrl(chainId));
      return (await dirtyRead(tx as never)) as SimulateResult;
    },

    async sign(tx, keypairs) {
      const universal = keypairs.map((kp) => fromKeypair(kp));
      return (await universalSignTransaction(tx as never, universal)) as unknown as BuiltTx;
    },

    async submit(signedTx, chainId) {
      const { submit } = createClient(getActivePactUrl(chainId));
      return (await submit(signedTx as never)) as { requestKey?: string; status?: string };
    },

    calculateAutoGasLimit: (simGas) => calculateAutoGasLimit(simGas),
  };
}
