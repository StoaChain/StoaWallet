// Ambient declarations for specifiers that resolve via Vite aliases at bundle
// time (see packages/core/src/build/viteStoachain.ts) but have no resolvable
// types under `tsc`'s bundler module resolution. Declaring them keeps app
// typecheck clean WITHOUT deleting the probe/harness that legitimately import
// them. The Vite build resolves the real modules; these are types-only stubs.

declare module '@stoawallet/core/build/polyfills';

declare module '@stoachain/kadena-stoic-legacy/hd-wallet' {
  export function kadenaGenMnemonic(): string;
  export function kadenaDecrypt(
    password: string,
    encrypted: string,
  ): Promise<Uint8Array>;
}

declare module '@stoachain/kadena-stoic-legacy/cryptography-utils' {
  export function binToHex(bytes: Uint8Array): string;
}

declare module '@stoachain/kadena-stoic-legacy/client' {
  // Minimal surface used by the harness; the real client exposes far more.
  export const Pact: {
    builder: {
      execution(code: string): {
        addSigner(pubKey: string): {
          setMeta(meta: { chainId: string; senderAccount: string }): {
            setNetworkId(networkId: string): {
              createTransaction(): {
                cmd: string;
                hash: string;
                sigs: ({ pubKey: string; sig?: string } | undefined)[];
              };
            };
          };
        };
      };
    };
  };
}
