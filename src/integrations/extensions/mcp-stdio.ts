import {
  type JSONRPCMessage,
  parseJSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/client";
import { MCP_MESSAGE_BYTES } from "../../domain/extensions/mcp.ts";
import type { ServiceGeneration } from "../../domain/foundation/index.ts";
import type { ManagedServicePort, ManagedServiceRequest } from "../../domain/process/index.ts";

/** SDK framing over Falryn's owned process tree. No SDK child or inherited process environment. */
export class ManagedMcpTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  private generation: ServiceGeneration | null = null;
  private detach: (() => void) | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private pending = new Uint8Array(0);
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly services: ManagedServicePort,
    private readonly request: ManagedServiceRequest,
  ) {}
  async start() {
    if (this.closed) throw new Error("mcp-closed");
    const started = await this.services.start(this.request);
    if (!started.ok) throw new Error(`mcp-${started.error.code}`);
    this.generation = started.value.generation;
    if (this.closed) {
      await this.services.stop(this.request.serviceId, this.generation);
      throw new Error("mcp-closed");
    }
    const attached = this.services.attach(this.request.serviceId, (event) => {
      if (this.closed || event.generation !== this.generation) return;
      if (event.kind === "output") {
        if (event.stream === "stdout") this.receive(event.bytes);
        // Diagnostics stay inside the managed owner and never enter protocol results.
      } else if (["crashed", "stopped", "failed", "restarted"].includes(event.kind)) {
        this.fail("mcp-disconnected");
      }
    });
    if (!attached.ok) {
      await this.close();
      throw new Error("mcp-attach-failed");
    }
    this.detach = attached.value.detach;
    // Before the first request no response is expected. Preserve bounded early notifications.
    if (attached.value.replay.droppedStdoutBytes > 0) this.fail("mcp-startup-output-exceeded");
    else this.receive(attached.value.replay.stdout);
  }
  private fail(code: string) {
    if (this.closed) return;
    this.onerror?.(new Error(code));
    void this.close().catch(() => this.onerror?.(new Error("mcp-shutdown-uncertain")));
  }
  private receive(bytes: Uint8Array) {
    if (this.closed) return;
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      const fragment = bytes.subarray(offset, end < 0 ? bytes.length : end);
      if (this.pending.length + fragment.length > MCP_MESSAGE_BYTES) {
        this.fail("mcp-message-too-large");
        return;
      }
      const next = new Uint8Array(this.pending.length + fragment.length);
      next.set(this.pending);
      next.set(fragment, this.pending.length);
      this.pending = next;
      if (end < 0) return;
      try {
        const message = parseJSONRPCMessage(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.pending)),
        );
        this.pending = new Uint8Array(0);
        this.onmessage?.(message);
      } catch {
        this.fail("mcp-malformed-frame");
        return;
      }
      offset = end + 1;
    }
  }
  async send(message: JSONRPCMessage) {
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    if (bytes.length > MCP_MESSAGE_BYTES) throw new Error("mcp-message-too-large");
    const send = async () => {
      if (this.closed || this.generation === null) throw new Error("mcp-closed");
      // The process owner bounds individual writes to 64 KiB. One frame keeps its write lock.
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const result = await this.services.send(
          this.request.serviceId,
          this.generation,
          bytes.subarray(offset, offset + 64 * 1024),
        );
        if (!result.ok) {
          this.fail("mcp-write-failed");
          throw new Error("mcp-write-failed");
        }
      }
    };
    const work = this.writes.then(send);
    this.writes = work.catch(() => {});
    return work;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.detach?.();
    this.detach = null;
    this.pending = new Uint8Array(0);
    this.onclose?.();
    this.closing = this.stop();
    return this.closing;
  }
  private async stop() {
    if (this.generation === null) return;
    const result = await this.services.stop(this.request.serviceId, this.generation);
    if (!result.ok || result.value.kind === "uncertain") throw new Error("mcp-shutdown-uncertain");
  }
}
