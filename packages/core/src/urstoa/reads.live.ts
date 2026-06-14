/**
 * Live (node-backed) read seam for {@link getUrStoaHoldings} / {@link getVaultTotal}.
 *
 * This file is the ONLY place the UrStoa reads touch the real `@stoachain/
 * ouronet-core` interactions, mirroring `advanced/fetchAccountGuard.live.ts`. It
 * is kept OUT of the package barrel on purpose so the barrel-reachable wrapper
 * never statically imports the SDK reads. Both SDK reads resolve their endpoint
 * through the active-node config themselves, so a custom node (Phase 10) is
 * honored without this seam hardcoding any node. Imports no `node:` modules —
 * browser-safe even though it is out of the barrel.
 */
import { getPrimordials } from '@stoachain/ouronet-core/interactions/ouroPrimordialsFunctions';
import { getUrStoaBalance } from '@stoachain/ouronet-core/interactions/urStoaFunctions';

import type { UrStoaReadDeps } from './reads';

/** Build the production read seam over the live, active-node SDK UrStoa reads. */
export function makeLiveUrStoaReadDeps(): UrStoaReadDeps {
  return {
    getPrimordials: (account) => getPrimordials(account),
    getUrStoaBalance: (account) => getUrStoaBalance(account),
  };
}
