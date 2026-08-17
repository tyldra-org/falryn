import { describe, expect, test } from "bun:test";
import {
  createDapFrameDecoder,
  debugAdapterLimits,
  encodeDapFrame,
  parseDebugAdapterInitializeResult,
  validateDebugAdapterStartRequest,
} from "./debug-adapter.ts";
import { configurationGeneration, managedServiceId } from "./identity.ts";

describe("debug-adapter contracts", () => {
  test("encodes and decodes a Content-Length DAP frame", () => {
    const frame = encodeDapFrame({
      seq: 1,
      type: "request",
      command: "initialize",
      arguments: { adapterID: "node" },
    });
    const decoder = createDapFrameDecoder();
    const decoded = decoder.push(frame);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value).toEqual([
      {
        seq: 1,
        type: "request",
        command: "initialize",
        arguments: { adapterID: "node" },
      },
    ]);
  });

  test("rejects oversized frames and malformed headers", () => {
    const decoder = createDapFrameDecoder(32);
    const large = encodeDapFrame({
      seq: 1,
      type: "response",
      request_seq: 1,
      success: true,
      command: "initialize",
      body: { supportsConfigurationDoneRequest: true },
    });
    expect(decoder.push(large)).toEqual({
      ok: false,
      error: { kind: "debug-adapter", code: "transport", reason: "frame-too-large" },
    });

    const badHeader = new TextEncoder().encode(
      "Content-Type: application/vscode-jsonrpc\r\n\r\n{}",
    );
    expect(createDapFrameDecoder().push(badHeader)).toEqual({
      ok: false,
      error: { kind: "debug-adapter", code: "transport", reason: "malformed-header" },
    });
  });

  test("parses initialize capability bodies and rejects non-objects", () => {
    expect(
      parseDebugAdapterInitializeResult({
        supportsConfigurationDoneRequest: true,
        exceptionBreakpointFilters: [],
      }),
    ).toEqual({
      ok: true,
      value: {
        capabilities: {
          supportsConfigurationDoneRequest: true,
          exceptionBreakpointFilters: [],
        },
      },
    });
    expect(parseDebugAdapterInitializeResult(null)).toEqual({
      ok: false,
      error: { kind: "debug-adapter", code: "malformed-response" },
    });
  });

  test("validates start requests and limits", () => {
    expect(
      validateDebugAdapterStartRequest({
        serviceId: managedServiceId.from("dap:workspace"),
        key: {
          workspaceRoot: "/tmp/project",
          adapterName: "node",
          configurationGeneration: configurationGeneration.from(0),
        },
        executable: "node-debug",
        argv: [],
        environment: {},
        initialize: {
          clientID: "falryn",
          clientName: "Falryn",
          adapterID: "node",
          pathFormat: "path",
          linesStartAt1: true,
          columnsStartAt1: true,
        },
      }),
    ).toMatchObject({
      kind: "debug-adapter",
      code: "invalid-request",
      reason: "invalid-executable",
    });

    expect(debugAdapterLimits({ maxRestarts: 99 })).toEqual({
      ok: false,
      error: { kind: "debug-adapter", code: "invalid-limits", field: "maxRestarts" },
    });
  });
});
