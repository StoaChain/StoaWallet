import { describe, expect, it } from 'vitest';

import { maxUnstake, type MaxUnstakeResult } from '../maxUnstake';

describe('maxUnstake — last-staker floor', () => {
  it('leaves a 1.0 floor when the user is the only/last staker (userStaked >= vaultTotal)', () => {
    // userStaked 100 == vaultTotal 100 => the last staker cannot drain the
    // vault to empty; the floor is userStaked - 1.0 = 99.
    expect(maxUnstake('100', '100')).toEqual<MaxUnstakeResult>({ ok: true, max: '99' });
  });

  it('lets a non-last staker unstake their full stake (userStaked < vaultTotal)', () => {
    expect(maxUnstake('50', '100')).toEqual<MaxUnstakeResult>({ ok: true, max: '50' });
  });

  it('does NOT clamp 9 against 100 — decimal compare, not lexicographic ("9" > "100" is wrong)', () => {
    // A naive string compare would see "9" >= "100" and wrongly apply the
    // floor (9 -> 8). Decimal-safe compare keeps the full 9.
    expect(maxUnstake('9', '100')).toEqual<MaxUnstakeResult>({ ok: true, max: '9' });
  });

  it('clamps 100 against 20 — decimal compare confirms userStaked exceeds the vault', () => {
    expect(maxUnstake('100', '20')).toEqual<MaxUnstakeResult>({ ok: true, max: '99' });
  });

  it('subtracts the floor decimal-safely on a fractional last stake (no JS-float "10"->"1" drift)', () => {
    // 10.5 - 1.0 = 9.5 exactly; pin the string. JS float would risk drift.
    expect(maxUnstake('10.5', '10.5')).toEqual<MaxUnstakeResult>({ ok: true, max: '9.5' });
  });

  it('subtracts across an integer borrow decimal-safely (100.25 - 1.0 = 99.25)', () => {
    expect(maxUnstake('100.25', '100.25')).toEqual<MaxUnstakeResult>({ ok: true, max: '99.25' });
  });

  it('fails CLOSED when vaultTotal is null — unstake blocked, floor never lifted', () => {
    // RR#3: a failed getUrStoaBalance(VAULT_ADDRESS) read must BLOCK unstake,
    // never coerce null to 0 (which would permit a full-drain unstake).
    expect(maxUnstake('100', null)).toEqual<MaxUnstakeResult>({
      ok: false,
      reason: 'vault-total-unknown',
    });
  });

  it('fails CLOSED when vaultTotal is undefined', () => {
    expect(maxUnstake('100', undefined)).toEqual<MaxUnstakeResult>({
      ok: false,
      reason: 'vault-total-unknown',
    });
  });

  it('fails CLOSED when userStaked is null', () => {
    expect(maxUnstake(null, '100')).toEqual<MaxUnstakeResult>({
      ok: false,
      reason: 'vault-total-unknown',
    });
  });

  it('fails CLOSED on a non-finite / non-numeric vaultTotal (e.g. "null" or "NaN" string)', () => {
    expect(maxUnstake('100', 'null')).toEqual<MaxUnstakeResult>({
      ok: false,
      reason: 'vault-total-unknown',
    });
    expect(maxUnstake('100', 'NaN')).toEqual<MaxUnstakeResult>({
      ok: false,
      reason: 'vault-total-unknown',
    });
  });

  it('fails CLOSED for a SOLE staker of a sub-1.0 vault — never borrows past the integer part to drain it', () => {
    // RR#3/RR#5/REQ-21: a sole staker of a sub-1.0 vault cannot satisfy the 1.0
    // floor, so the unstake must be BLOCKED. The old `subtractOne("0.5")` would
    // borrow past the integer length and return "9.5", lifting the floor and
    // permitting a full-drain of the vault to empty.
    expect(maxUnstake('0.5', '0.5')).toEqual<MaxUnstakeResult>({
      ok: false,
      reason: 'vault-total-unknown',
    });
    expect(maxUnstake('0.9', '0.9')).toEqual<MaxUnstakeResult>({
      ok: false,
      reason: 'vault-total-unknown',
    });
  });

  it('a sole staker of exactly 1.0 may unstake nothing (1.0 - 1.0 = 0) — the floor leaves the whole vault', () => {
    // The 1.0 floor exactly consumes a 1.0 sole stake: max is "0". This pins the
    // sole-staker-of-exactly-1.0 boundary as the smallest stake that does NOT
    // fail closed.
    expect(maxUnstake('1', '1')).toEqual<MaxUnstakeResult>({ ok: true, max: '0' });
  });
});
