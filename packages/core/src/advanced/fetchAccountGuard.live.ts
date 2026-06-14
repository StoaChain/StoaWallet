/**
 * Live (node-backed) read seam for {@link fetchAccountGuard}.
 *
 * This file is the ONLY place the guard fetch touches the real SDK Pact builder
 * + node-active client, mirroring `send/sendSameChain.live.ts`. It is kept OUT
 * of the package barrel on purpose: the SDK's `Pact`/`createClient` carry
 * unresolved types, so the construction lives here behind the typed
 * {@link GuardReadDeps} seam rather than polluting the barrel-reachable
 * orchestrator, which imports this lazily for its default path.
 *
 * It imports no `node:fs`/`node:path` — only the SDK client — so it stays
 * browser-safe even though it is out of the barrel.
 */
import {
  Pact,
  createClient,
} from '@stoachain/kadena-stoic-legacy/client';
import type { ChainId } from '@stoachain/kadena-stoic-legacy/types';
import { anuToStoa, GAS_PRICE_MIN_ANU } from '@stoachain/stoa-core/gas';
import { getActivePactUrl } from '@stoachain/stoa-core/network';
import { STOA_AUTONOMIC_OURONETGASSTATION } from '@stoachain/ouronet-core/constants';

import type { DirtyReadResult, GuardReadDeps } from './fetchAccountGuard';

const STOA_NETWORK_ID = 'stoa';
const TX_TTL_SECONDS = 600;
const READ_GAS_LIMIT = 500_000;

/**
 * Build the production read seam: a node-active client for the SELECTED chain
 * that runs a dirty-read of arbitrary Pact code. The active pact URL is
 * resolved per call so a node failover is picked up.
 */
export function makeLiveGuardReadDeps(): GuardReadDeps {
  return {
    async dirtyRead(pactCode, chainId) {
      const { dirtyRead } = createClient(getActivePactUrl(chainId));
      const probe = Pact.builder
        .execution(pactCode)
        .setMeta({
          senderAccount: STOA_AUTONOMIC_OURONETGASSTATION,
          chainId: chainId as ChainId,
          gasLimit: READ_GAS_LIMIT,
          gasPrice: anuToStoa(GAS_PRICE_MIN_ANU),
          ttl: TX_TTL_SECONDS,
        })
        .setNetworkId(STOA_NETWORK_ID)
        .createTransaction();
      return (await dirtyRead(probe as never)) as DirtyReadResult;
    },
  };
}
