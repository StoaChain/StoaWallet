import { describe, expect, it } from 'vitest';

import { parseApprovalParams } from '../parseApprovalParams';

/**
 * The approval window's launch-param decode. The router encodes the pending
 * request on the URL; this turns it back into a typed request. A garbled / partial
 * param must yield `null` (→ an error screen), never a half-built approval the
 * user could act on against the wrong data.
 */

function qs(params: Record<string, string>): string {
  return '?' + new URLSearchParams(params).toString();
}

describe('parseApprovalParams', () => {
  it('parses a connect request with its correlation keys', () => {
    const parsed = parseApprovalParams(
      qs({
        kind: 'connect',
        id: 'req-1',
        nonce: 'nonce-1',
        origin: 'https://dapp.test',
        networkId: 'stoachain',
      }),
    );

    expect(parsed?.request).toEqual({
      kind: 'connect',
      requestId: 'req-1',
      nonce: 'nonce-1',
      origin: 'https://dapp.test',
      networkId: 'stoachain',
    });
    expect(parsed?.locked).toBe(false);
  });

  it('parses a sign request and preserves the FROZEN command(s) verbatim', () => {
    const commandSigDatas = [
      { cmd: '{"payload":{"exec":{"code":"(x)"}}}', sigs: [{ pubKey: 'k', sig: null }] },
    ];
    const parsed = parseApprovalParams(
      qs({
        kind: 'sign',
        id: 'req-2',
        nonce: 'nonce-2',
        origin: 'https://dapp.test',
        networkId: 'stoachain',
        commandSigDatas: JSON.stringify(commandSigDatas),
      }),
    );

    expect(parsed?.request.kind).toBe('sign');
    if (parsed?.request.kind === 'sign') {
      expect(parsed.request.commandSigDatas).toEqual(commandSigDatas);
    }
  });

  it('carries the locked flag through so the surface can re-unlock first', () => {
    const parsed = parseApprovalParams(
      qs({
        kind: 'connect',
        id: 'r',
        nonce: 'n',
        origin: 'https://dapp.test',
        networkId: 'stoachain',
        locked: '1',
      }),
    );

    expect(parsed?.locked).toBe(true);
  });

  it('returns null when a correlation key (nonce) is missing — never a partial approval', () => {
    const parsed = parseApprovalParams(
      qs({ kind: 'connect', id: 'r', origin: 'https://dapp.test', networkId: 'stoachain' }),
    );
    expect(parsed).toBeNull();
  });

  it('returns null for a sign request whose commandSigDatas JSON is malformed', () => {
    const parsed = parseApprovalParams(
      qs({
        kind: 'sign',
        id: 'r',
        nonce: 'n',
        origin: 'https://dapp.test',
        networkId: 'stoachain',
        commandSigDatas: '{not json',
      }),
    );
    expect(parsed).toBeNull();
  });

  it('returns null for a sign request with an empty command array (nothing to preview)', () => {
    const parsed = parseApprovalParams(
      qs({
        kind: 'sign',
        id: 'r',
        nonce: 'n',
        origin: 'https://dapp.test',
        networkId: 'stoachain',
        commandSigDatas: '[]',
      }),
    );
    expect(parsed).toBeNull();
  });

  it('returns null for an unknown intent kind', () => {
    const parsed = parseApprovalParams(
      qs({ kind: 'bogus', id: 'r', nonce: 'n', origin: 'https://dapp.test', networkId: 'stoachain' }),
    );
    expect(parsed).toBeNull();
  });
});
