import {
  MAX_PROCESS_CAPTURE_BYTES,
  type ProcessStreamName,
} from "../../domain/process/process-capture.ts";

const BLOCK_BYTES = 65_536;
export type ProcessTaskTail = { readonly offset: number; readonly bytes: Uint8Array };

/** One bounded live tail per stream. Only full blocks and final tails become immutable artifacts. */
export function createProcessTaskBuffer(
  persist: (stream: ProcessStreamName, offset: number, bytes: Uint8Array) => Promise<void>,
) {
  const streams = {
    stdout: { offset: 0, length: 0, bytes: new Uint8Array(BLOCK_BYTES) },
    stderr: { offset: 0, length: 0, bytes: new Uint8Array(BLOCK_BYTES) },
  };
  const flush = async (stream: ProcessStreamName) => {
    const state = streams[stream];
    if (state.length === 0) return;
    const bytes = state.bytes.slice(0, state.length);
    await persist(stream, state.offset, bytes);
    state.offset += state.length;
    state.length = 0;
  };
  return {
    async append(stream: ProcessStreamName, bytes: Uint8Array): Promise<void> {
      const state = streams[stream];
      if (state.offset + state.length + bytes.byteLength > MAX_PROCESS_CAPTURE_BYTES)
        throw new Error("task output limit");
      for (let offset = 0; offset < bytes.byteLength; ) {
        const count = Math.min(BLOCK_BYTES - state.length, bytes.byteLength - offset);
        state.bytes.set(bytes.subarray(offset, offset + count), state.length);
        state.length += count;
        offset += count;
        if (state.length === BLOCK_BYTES) await flush(stream);
      }
    },
    snapshot(stream: ProcessStreamName): ProcessTaskTail {
      const state = streams[stream];
      return { offset: state.offset, bytes: state.bytes.slice(0, state.length) };
    },
    async finish(): Promise<void> {
      await flush("stdout");
      await flush("stderr");
    },
  };
}
