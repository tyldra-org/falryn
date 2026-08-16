/**
 * Session-scoped attachment bytes, addressed by id.
 *
 * Composer state holds descriptors. This map holds the paste bodies those
 * descriptors name, so include does not re-read a clipboard that may have
 * changed and chrome never sees a payload.
 */

export type AttachmentPayloadPort = {
  put(id: string, bytes: Uint8Array): void;
  get(id: string): Uint8Array | null;
  drop(id: string): void;
};

export function createMemoryAttachmentPayloads(): AttachmentPayloadPort {
  const stored = new Map<string, Uint8Array>();
  return {
    put(id, bytes) {
      stored.set(id, bytes);
    },
    get(id) {
      return stored.get(id) ?? null;
    },
    drop(id) {
      stored.delete(id);
    },
  };
}
