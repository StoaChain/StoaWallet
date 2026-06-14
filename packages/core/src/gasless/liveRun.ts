/**
 * Live gasless-on-all-10-chains verification run (NOT a unit test).
 *
 * Derives a FRESH `k:` account, configures node1 as the active primary, then
 * runs a SIGNED `/local` (preflight + signatureVerification) gas-payer
 * eligibility probe on EVERY StoaChain chain against the live on-chain
 * `ouronet-ns.DALOS` module, and persists the per-chain verdicts to
 * `packages/core/gasless-result.json` for Phase 4 to gate messaging on.
 *
 * The network may be unreachable / rate-limited / reject a brand-new account.
 * Whatever real outcome each chain returns is recorded honestly — passes are
 * NEVER fabricated. No keys or mnemonics are ever logged or persisted.
 *
 * Run with: `npx tsx packages/core/src/gasless/liveRun.ts` (from repo root).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Pact, createClient } from '@stoachain/kadena-stoic-legacy/client';
import type { ChainId } from '@stoachain/kadena-stoic-legacy/types';
import { KADENA_NETWORK } from '@stoachain/stoa-core/constants';
import { anuToStoa, TTL_DEFAULT } from '@stoachain/stoa-core/gas';
import { getActivePactUrl } from '@stoachain/stoa-core/network';
import { KadenaWalletBuilder } from '@stoachain/stoa-core/wallet';

import { deriveAccount } from '../api/derive';
import { signTx, type SignableKeypair } from '../api/sign';
import { configureNode } from '../network';
import type { StorageAdapter } from '../storage';

import { buildGaslessProbeTx } from './buildProbe';
import { verifyGaslessAllChains, type ChainProbeResult } from './verify';

/** Ephemeral in-memory storage so configureNode boots node1 with no persisted pref. */
function ephemeralStorage(): StorageAdapter {
  const store = new Map<string, string | Uint8Array>();
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, val) => void store.set(key, val),
    remove: async (key) => void store.delete(key),
  };
}

const ARTIFACT_PATH = join(import.meta.dirname, '..', '..', 'gasless-result.json');

/** Gas-station-paid probe meta: small gas budget, default ttl, node1 network. */
const PROBE_GAS_LIMIT = 1500;

async function main(): Promise<void> {
  // Fresh, throwaway account for this run only. Password is non-empty per the
  // deriveAccount contract; neither it nor the mnemonic is logged or persisted.
  const mnemonic = await KadenaWalletBuilder.generateMnemonic(24);
  const password = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const account = await deriveAccount(mnemonic, password, 0);

  const keypair: SignableKeypair = {
    publicKey: account.publicKey,
    encryptedSecretKey: account.encryptedSecretKey,
    password,
    seedType: 'koala',
  };

  // Boot node1 as the active primary so getActivePactUrl points at node1.
  await configureNode(ephemeralStorage());

  const probe = async (chainId: string): Promise<ChainProbeResult> => {
    const spec = buildGaslessProbeTx({
      chainId,
      accountPublicKey: account.publicKey,
    });

    try {
      const tx = Pact.builder
        // A read-only balance details call is enough to exercise the gas-payer
        // eligibility gate without moving funds; the gate runs on the SIGNED tx.
        .execution(`(coin.details "${spec.senderAccount}")`)
        .setMeta({
          senderAccount: spec.senderAccount,
          chainId: spec.chainId as ChainId,
          gasLimit: PROBE_GAS_LIMIT,
          gasPrice: anuToStoa(1),
          ttl: TTL_DEFAULT,
        })
        .setNetworkId(KADENA_NETWORK)
        .addSigner(spec.signers[0].publicKey, ((withCap: (name: string, ...args: unknown[]) => unknown) =>
          spec.signers[0].capabilities.map((c) =>
            withCap(c.name, ...(c.args as unknown[])),
          )) as never)
        .createTransaction();

      const signed = await signTx(tx, keypair);
      const { preflight } = createClient(getActivePactUrl(chainId));
      const local = await preflight(signed as never);

      return {
        chainId,
        outcome: local.result.status === 'success' ? 'pass' : 'fail',
      };
    } catch {
      // Unreachable / timeout / transport error — recorded honestly, never a
      // silent pass. Error body is suppressed (may echo signed tx bytes).
      return { chainId, outcome: 'unreachable' };
    }
  };

  const report = await verifyGaslessAllChains(probe);

  const artifact = {
    generatedAt: new Date().toISOString(),
    network: KADENA_NETWORK,
    note: report.results.every((r) => r.outcome === 'unreachable')
      ? 'LIVE VERIFICATION PENDING — node1 unreachable for all chains; unit-tested gating logic still holds.'
      : 'Live per-chain gasless eligibility verdicts (signed /local preflight against ouronet-ns.DALOS).',
    eligibleEverywhere: report.eligibleEverywhere,
    gatedChains: report.gatedChains,
    results: report.results,
  };

  writeFileSync(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  // Per-chain verdict only — no keys, no mnemonic, no tx bytes.
  for (const r of report.results) {
    console.log(`chain ${r.chainId}: ${r.outcome}`);
  }
  console.log(
    `eligibleEverywhere=${report.eligibleEverywhere} | gated=[${report.gatedChains.join(',')}]`,
  );
  console.log(`wrote ${ARTIFACT_PATH}`);
}

main().catch((err) => {
  console.error('gasless live run failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
