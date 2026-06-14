import { describe, expect, it } from 'vitest';

import type { ApprovalCommandSigData } from '../approvalTypes';
import { decodePactPreview } from '../decodePactPreview';

/**
 * The generic Pact-command decode that powers the signature preview. These pin
 * the decode contract the user's safety depends on: a malformed command still
 * yields a NON-EMPTY preview (never a blank panel the user might blindly
 * approve), a continuation is described, and a gas-payer sponsorship cap is
 * flagged so the user knows someone else is paying.
 */

function cmd(raw: unknown): ApprovalCommandSigData {
  return { cmd: JSON.stringify(raw), sigs: [] };
}

describe('decodePactPreview', () => {
  it('decodes a non-transfer exec command into its code, signers, and caps', () => {
    const preview = decodePactPreview(
      cmd({
        payload: { exec: { code: '(free.dao.vote "p7" true)' } },
        signers: [
          { pubKey: 'key-1', clist: [{ name: 'free.dao.VOTE', args: ['p7'] }] },
        ],
      }),
    );

    expect(preview.code).toBe('(free.dao.vote "p7" true)');
    expect(preview.signers.map((s) => s.pubKey)).toEqual(['key-1']);
    expect(preview.capabilities.map((c) => c.name)).toEqual(['free.dao.VOTE']);
  });

  it('flags a gas-payer / gas-station capability as a sponsor so the user sees who pays', () => {
    const preview = decodePactPreview(
      cmd({
        payload: { exec: { code: '(do-thing)' } },
        signers: [
          {
            pubKey: 'gas-key',
            clist: [{ name: 'coin.GAS_PAYER', args: ['gas-station'] }],
          },
        ],
      }),
    );

    expect(preview.hasGasPayer).toBe(true);
    expect(preview.capabilities[0].isGasPayer).toBe(true);
  });

  it('does NOT flag an ordinary capability as a gas sponsor', () => {
    const preview = decodePactPreview(
      cmd({
        payload: { exec: { code: '(do-thing)' } },
        signers: [{ pubKey: 'k', clist: [{ name: 'coin.TRANSFER', args: ['a', 'b', 1] }] }],
      }),
    );

    expect(preview.hasGasPayer).toBe(false);
    expect(preview.capabilities[0].isGasPayer).toBe(false);
  });

  it('renders Pact int/decimal literal args readably rather than as [object Object]', () => {
    const preview = decodePactPreview(
      cmd({
        payload: { exec: { code: '(x)' } },
        signers: [
          {
            pubKey: 'k',
            clist: [{ name: 'coin.TRANSFER', args: ['from', 'to', { decimal: '1.5' }] }],
          },
        ],
      }),
    );

    expect(preview.capabilities[0].args).toEqual(['from', 'to', '1.5']);
  });

  it('describes a continuation (cont) payload instead of leaving the code blank', () => {
    const preview = decodePactPreview(
      cmd({ payload: { cont: { pactId: 'pact-xyz', step: 1 } } }),
    );

    expect(preview.code).toContain('pact-xyz');
    expect(preview.code).toContain('step=1');
  });

  it('falls back to the RAW cmd string (non-empty) when the JSON is malformed', () => {
    const malformed: ApprovalCommandSigData = { cmd: '{not valid json', sigs: [] };
    const preview = decodePactPreview(malformed);

    expect(preview.code).toBe('{not valid json');
    expect(preview.signers).toEqual([]);
  });

  it('extracts chainId and sender from meta when present', () => {
    const preview = decodePactPreview(
      cmd({
        payload: { exec: { code: '(x)' } },
        meta: { chainId: '4', sender: 'gas-station' },
      }),
    );

    expect(preview.chainId).toBe('4');
    expect(preview.sender).toBe('gas-station');
  });
});
