import {
  Pact,
  createClient,
} from '@stoachain/kadena-stoic-legacy/client';
import type { ChainId } from '@stoachain/kadena-stoic-legacy/types';
import {
  getBalanceOnChain,
  listenForCompletion,
  submitCrossChainTransfer,
} from '@stoachain/ouronet-core/interactions/crossChainFunctions';
import { STOA_AUTONOMIC_OURONETGASSTATION } from '@stoachain/ouronet-core/constants';
import { anuToStoa, GAS_PRICE_MIN_ANU } from '@stoachain/stoa-core/gas';
import { extractKeysetFromGuard } from '@stoachain/stoa-core/guard';
import { getActivePactUrl } from '@stoachain/stoa-core/network';
import {
  fromKeypair,
  universalSignTransaction,
} from '@stoachain/stoa-core/signing';
import { SigningError } from '@stoachain/stoa-core/errors';

import {
  buildCrossChainStep0,
  type BuildStep0Deps,
  type ReceiverGuard,
  type UnsignedTx,
} from './buildStep0';
import { defaultIsTimeout, type SendCrossChainStep0Deps } from './sendCrossChainStep0';

const STOA_NETWORK_ID = 'stoa';
const TX_TTL_SECONDS = 600;
const READ_GAS_LIMIT = 500_000;

/** Shape of a `coin.details` dirtyRead this flow consumes. */
interface DetailsRead {
  readonly result?: {
    readonly status?: string;
    readonly data?: { readonly guard?: unknown };
  };
}

/**
 * Live `BuildStep0Deps` (the ONE network read the pure builder needs): account
 * existence on the TARGET chain and the receiver's on-chain keyset. Both legs
 * resolve the active pact URL per chain so a node failover is picked up, and the
 * guard is extracted via the SDK's `extractKeysetFromGuard` — never hand-parsed.
 */
function makeLiveBuildStep0Deps(): BuildStep0Deps {
  return {
    getBalanceOnChain: (account, chainId) =>
      getBalanceOnChain(account, chainId).then(({ exists }) => ({ exists })),

    async fetchGuard(account, chainId) {
      const { dirtyRead } = createClient(getActivePactUrl(chainId));
      const probe = Pact.builder
        .execution(`(coin.details "${account}")`)
        .setMeta({
          senderAccount: STOA_AUTONOMIC_OURONETGASSTATION,
          chainId: chainId as ChainId,
          gasLimit: READ_GAS_LIMIT,
          gasPrice: anuToStoa(GAS_PRICE_MIN_ANU),
          ttl: TX_TTL_SECONDS,
        })
        .setNetworkId(STOA_NETWORK_ID)
        .createTransaction();

      const res = (await dirtyRead(probe as never)) as DetailsRead;
      if (res.result?.status !== 'success') return { ok: false };

      const keyset = extractKeysetFromGuard(res.result.data?.guard);
      if (!keyset || !keyset.keys?.length || !keyset.pred) return { ok: false };

      return {
        ok: true,
        guard: { keys: keyset.keys, pred: keyset.pred } as ReceiverGuard,
      };
    },
  };
}

/**
 * Live (node-backed) deps for `sendCrossChainStep0`: thin adapters over the
 * `@stoachain/*` cross-chain + signing primitives. Constructed lazily behind the
 * orchestrator's dynamic import so the barrel-reachable orchestrator never
 * statically pulls the SDK transport in. We do NOT reimplement the primitives —
 * each dep forwards to the SDK and narrows the `any` boundary.
 *
 * `submit` is the failover-wrapped `submitCrossChainTransfer` (THROWS, code
 * "TIMEOUT" on deadline). `listen` is the failover-AWARE `listenForCompletion`
 * (node1-primary + node2 failover internally) — NOT a raw `createClient.listen`
 * that would bypass failover (PAT-001).
 */
export function makeLiveSendCrossChainStep0Deps(): SendCrossChainStep0Deps {
  return {
    buildStep0: (input, deps?: BuildStep0Deps) =>
      buildCrossChainStep0(input, deps ?? makeLiveBuildStep0Deps()),

    async signTransaction(tx, keypairs) {
      const universal = keypairs.map((kp) => fromKeypair(kp));
      return (await universalSignTransaction(
        tx as never,
        universal,
      )) as unknown as UnsignedTx;
    },

    submit: async (signedTx, sourceChain) => {
      const descriptor = await submitCrossChainTransfer(signedTx as never, sourceChain);
      return { requestKey: descriptor.requestKey };
    },

    listen: (requestKey, chainId) => listenForCompletion(requestKey, chainId),

    isTimeout: (err) =>
      (err instanceof SigningError && err.code === 'TIMEOUT') || defaultIsTimeout(err),
  };
}
