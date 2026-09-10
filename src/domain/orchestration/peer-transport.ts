import type { PeerResult } from "./peer-mailbox.ts";

/** Host-owned keys live only for the exact process generation. */
export type PeerCrypto = {
  publicKey: string;
  seal(recipientPublicKey: string, value: unknown): string;
  decrypt(senderPublicKey: string, sealed: string): PeerResult<unknown>;
};
export type PeerTransport = {
  retire(address: string): Promise<void>;
  listen(handler: (input: unknown, signal: AbortSignal) => Promise<unknown>): Promise<
    PeerResult<{
      address: string;
      close(): Promise<void>;
    }>
  >;
  request(address: string, input: unknown, signal: AbortSignal): Promise<PeerResult<unknown>>;
};
