/**
 * The {@link CommandSigner} the dApp router signs through (XP-4 wiring).
 *
 * The router never touches key material; it hands the signer the FROZEN
 * {@link CommandSigData}s plus the single-use approval token and gets back ONLY
 * the signed public artifact. This adapter bridges that seam to the Phase-7
 * background signing path: for each command it builds a `commandSigDatas`
 * `signTx` request carrying the token and routes it through {@link routeRequest},
 * which validates-and-consumes the token (XP-3), resolves the requested pubkeys
 * to wallet keypairs, and signs via `universalSignTransaction` — all inside the
 * secure worker. The cmd's blake2b hash is recomputed from the cmd bytes by the
 * router, so the signature binds the EXACT bytes the approval preview showed.
 *
 * The token is single-use, so it is spent by the FIRST command; subsequent
 * commands in the same batch are signed under a no-token follow-through that the
 * router authorizes by having already consumed the approval for this round. To
 * keep the single-use guarantee strict AND support multi-command quicksign, this
 * adapter signs the whole batch under ONE approval by consuming the token once
 * and threading the already-approved state through; a replay of the batch
 * presents a spent token and is rejected.
 */
import type { KeyringManager, KeyVault } from '@stoawallet/core';

import { routeRequest } from '../background/router';
import type { ApprovalTokenConsumer } from '../background/router';

import type { CommandSigner, CommandSignResult } from './dappRouter';
import type { CommandSigData, QuickSignedCommand } from './protocol';

export interface BackgroundCommandSignerDeps {
  readonly manager: KeyringManager;
  readonly keyVault: KeyVault;
  /** The single-use approval-token registry the background owns (XP-3). */
  readonly approvalTokens: ApprovalTokenConsumer;
}

/**
 * The router validated the token up-front and the background's `routeRequest`
 * also validates-and-consumes it. To avoid a double-consume across a multi-command
 * batch, the FIRST command consumes the real token and the rest sign under a
 * one-shot consumer that returns `true` exactly for the already-approved round.
 */
function oneRoundConsumer(real: ApprovalTokenConsumer, token: string): ApprovalTokenConsumer {
  let firstSpent = false;
  return {
    consume(presented: string): boolean {
      if (presented !== token) return false;
      if (!firstSpent) {
        firstSpent = real.consume(presented);
        return firstSpent;
      }
      // Subsequent commands in the SAME approved batch reuse the round that the
      // first command already paid for. A different/foreign token never reaches
      // here (the equality guard above).
      return true;
    },
  };
}

export function createBackgroundCommandSigner(
  deps: BackgroundCommandSignerDeps,
): CommandSigner {
  const { manager, keyVault, approvalTokens } = deps;

  return {
    async sign(
      commandSigDatas: readonly CommandSigData[],
      approvalToken: string,
    ): Promise<CommandSignResult> {
      const roundConsumer = oneRoundConsumer(approvalTokens, approvalToken);
      const responses: QuickSignedCommand[] = [];

      for (const sigData of commandSigDatas) {
        const res = await routeRequest(
          manager,
          keyVault,
          {
            type: 'signTx',
            tx: { cmd: sigData.cmd, hash: '' },
            accountIndex: 0,
            signerSpec: { kind: 'commandSigDatas', sigData: { cmd: sigData.cmd, sigs: sigData.sigs } },
            approvalToken,
          },
          roundConsumer,
        );

        if (!res.ok) {
          // A locked vault collapses the whole batch to `locked`; a bad token (or
          // any other failure) is surfaced as an invalid request — neither leaks
          // key material.
          return { ok: false, reason: res.reason === 'locked' ? 'locked' : 'invalid-request' };
        }
        if (!('signed' in res)) {
          return { ok: false, reason: 'invalid-request' };
        }

        responses.push({
          commandSigData: {
            cmd: res.signed.cmd,
            sigs: (res.signed.sigs ?? []).map((s) => ({
              pubKey: s?.pubKey ?? '',
              sig: s?.sig ?? null,
            })),
          },
          outcome: { result: 'success', hash: res.signed.hash },
        });
      }

      return { ok: true, responses };
    },
  };
}
