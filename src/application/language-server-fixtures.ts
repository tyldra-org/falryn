#!/usr/bin/env bun
/**
 * Minimal stdio language server for #89 host integration tests.
 * Speaks only initialize / initialized / shutdown / exit.
 */

const decoder = new TextDecoder();
let buffer = new Uint8Array(0);
let exiting = false;

function encode(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(`${JSON.stringify(message)}\r\n`);
  const header = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const frame = new Uint8Array(header.byteLength + body.byteLength);
  frame.set(header, 0);
  frame.set(body, header.byteLength);
  return frame;
}

function indexOfHeaderEnd(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
}

async function write(frame: Uint8Array): Promise<void> {
  await Bun.write(Bun.stdout, frame);
}

function handle(message: Record<string, unknown>): void {
  if (typeof message.method !== "string") {
    return;
  }
  if (message.method === "initialize" && message.id !== undefined) {
    void write(
      encode({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          capabilities: { hoverProvider: true },
          serverInfo: { name: "fixture-lsp", version: "0.0.1" },
        },
      }),
    );
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "shutdown" && message.id !== undefined) {
    void write(encode({ jsonrpc: "2.0", id: message.id, result: null }));
    return;
  }
  if (message.method === "exit") {
    exiting = true;
    process.exit(0);
  }
}

const reader = Bun.stdin.stream().getReader();
while (!exiting) {
  const { done, value } = await reader.read();
  if (done || value === undefined) {
    break;
  }
  const next = new Uint8Array(buffer.byteLength + value.byteLength);
  next.set(buffer, 0);
  next.set(value, buffer.byteLength);
  buffer = next;
  while (true) {
    const headerEnd = indexOfHeaderEnd(buffer);
    if (headerEnd === -1) {
      break;
    }
    const headerText = decoder.decode(buffer.subarray(0, headerEnd));
    const match = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (match === null) {
      process.exit(2);
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.byteLength < bodyEnd) {
      break;
    }
    const body = decoder.decode(buffer.subarray(bodyStart, bodyEnd));
    buffer = buffer.subarray(bodyEnd);
    handle(JSON.parse(body) as Record<string, unknown>);
  }
}
