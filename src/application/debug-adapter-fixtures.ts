#!/usr/bin/env bun
/**
 * Minimal stdio debug adapter for #96 host integration tests.
 * Speaks only initialize / initialized / disconnect.
 */

const decoder = new TextDecoder();
let buffer = new Uint8Array(0);
const exiting = false;
let nextSeq = 1;

function encode(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
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
  if (message.type === "event") {
    return;
  }
  if (message.type !== "request" || typeof message.command !== "string") {
    return;
  }
  const requestSeq = typeof message.seq === "number" ? message.seq : 0;
  if (message.command === "initialize") {
    void write(
      encode({
        seq: nextSeq,
        type: "response",
        request_seq: requestSeq,
        success: true,
        command: "initialize",
        body: {
          supportsConfigurationDoneRequest: true,
          supportsTerminateRequest: true,
        },
      }),
    );
    nextSeq += 1;
    return;
  }
  if (message.command === "disconnect") {
    void write(
      encode({
        seq: nextSeq,
        type: "response",
        request_seq: requestSeq,
        success: true,
        command: "disconnect",
        body: {},
      }),
    );
    nextSeq += 1;
    return;
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
