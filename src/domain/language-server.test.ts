import { describe, expect, test } from "bun:test";
import { configurationGeneration, managedServiceId } from "./identity.ts";
import {
  createJsonRpcFrameDecoder,
  encodeJsonRpcFrame,
  languageServerLimits,
  parseLanguageServerInitializeResult,
  validateLanguageServerStartRequest,
} from "./language-server.ts";

describe("language-server contracts", () => {
  test("encodes and decodes a Content-Length JSON-RPC frame", () => {
    const frame = encodeJsonRpcFrame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { processId: null },
    });
    const decoder = createJsonRpcFrameDecoder();
    const decoded = decoder.push(frame);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { processId: null },
      },
    ]);
  });

  test("rejects oversized frames and malformed headers", () => {
    const decoder = createJsonRpcFrameDecoder(32);
    const large = encodeJsonRpcFrame({
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: { textDocumentSync: 1 } },
    });
    expect(decoder.push(large)).toEqual({
      ok: false,
      error: { kind: "language-server", code: "transport", reason: "frame-too-large" },
    });

    const badHeader = new TextEncoder().encode(
      "Content-Type: application/vscode-jsonrpc\r\n\r\n{}",
    );
    expect(createJsonRpcFrameDecoder().push(badHeader)).toEqual({
      ok: false,
      error: { kind: "language-server", code: "transport", reason: "malformed-header" },
    });
  });

  test("parses initialize results and rejects malformed payloads", () => {
    expect(
      parseLanguageServerInitializeResult({
        capabilities: { hoverProvider: true },
        serverInfo: { name: "fake", version: "1.0.0" },
      }),
    ).toEqual({
      ok: true,
      value: {
        capabilities: { hoverProvider: true },
        serverInfo: { name: "fake", version: "1.0.0" },
      },
    });
    expect(parseLanguageServerInitializeResult({ capabilities: null })).toEqual({
      ok: false,
      error: { kind: "language-server", code: "malformed-response" },
    });
  });

  test("validates start requests and limits", () => {
    expect(
      validateLanguageServerStartRequest({
        serviceId: managedServiceId.from("lsp:workspace"),
        key: {
          workspaceRoot: "/tmp/project",
          serverName: "typescript",
          configurationGeneration: configurationGeneration.from(0),
        },
        executable: "typescript-language-server",
        argv: ["--stdio"],
        environment: {},
        initialize: {
          processId: null,
          rootUri: "file:///tmp/project",
          workspaceFolders: null,
          capabilities: {},
          clientInfo: { name: "falryn", version: "0.0.0" },
        },
      }),
    ).toMatchObject({
      kind: "language-server",
      code: "invalid-request",
      reason: "invalid-executable",
    });

    expect(languageServerLimits({ maxRestarts: 99 })).toEqual({
      ok: false,
      error: { kind: "language-server", code: "invalid-limits", field: "maxRestarts" },
    });
  });
});
