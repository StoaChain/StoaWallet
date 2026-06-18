/**
 * Color-coded seed-type chip config, mirroring OuronetUI's `SEED_TYPE_CONFIG`.
 * Each seed type renders a small pill with a distinct text/background pair and a
 * human label, so the active seed's provenance is recognizable at a glance.
 *
 * Today the wallet only onboards `koala` (the 24-word BIP39 seed), but the other
 * types are kept so a future multi-seed manager renders the right chip with no
 * extra wiring. An unknown type falls back to the koala chip (the only one the
 * current vault produces).
 */
export interface SeedTypeChipStyle {
  readonly label: string;
  readonly color: string;
  readonly background: string;
}

export const SEED_TYPE_CONFIG: Record<string, SeedTypeChipStyle> = {
  koala: { label: 'Koala', color: '#ec4899', background: '#4a1035' },
  chainweaver: { label: 'Chainweaver', color: '#3b82f6', background: '#1e3a5f' },
  eckowallet: { label: 'EckoWallet', color: '#f97316', background: '#431407' },
  pure: { label: 'Pure', color: '#a78bfa', background: '#2e1065' },
};

/** Resolve a seed type's chip style, defaulting to the koala chip for unknowns. */
export function seedTypeChipStyle(seedType: string): SeedTypeChipStyle {
  return SEED_TYPE_CONFIG[seedType] ?? SEED_TYPE_CONFIG.koala;
}
