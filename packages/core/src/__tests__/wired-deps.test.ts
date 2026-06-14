import { describe, expect, it } from 'vitest';

import { STOA_CHAIN_COUNT } from '@stoachain/stoa-core/constants';

describe('wired @stoachain/* dependencies', () => {
  it('resolves @stoachain/stoa-core/constants and exposes the braided-chain count', () => {
    // StoaChain is a 10-chain braided Chainweb fork; if the wired dep ever
    // resolves to a different build, this count drifts and every balance/send
    // screen that iterates chains 0..9 would silently lose or invent a chain.
    expect(STOA_CHAIN_COUNT).toBe(10);
  });
});
