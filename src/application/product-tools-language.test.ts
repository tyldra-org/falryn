/**
 * Product language tools (#714).
 */

import { describe, expect, test } from "bun:test";

import {
  capabilityId,
  configurationGeneration,
  invocationId,
  managedServiceId,
  ok,
  serviceGeneration,
} from "../domain/index.ts";
import type { DebugAdapterSupervisor } from "./debug-adapter.ts";
import type { LanguageServerSupervisor } from "./language-server.ts";
import { composeProductLanguageTools } from "./product-tools-language.ts";

function unused(): never {
  throw new Error("unexpected call");
}

function fakeLsp(overrides: Partial<LanguageServerSupervisor> = {}): LanguageServerSupervisor {
  return {
    start: async () => unused(),
    shutdown: async () => unused(),
    openDocument: async () => unused(),
    changeDocument: async () => unused(),
    saveDocument: async () => unused(),
    closeDocument: async () => unused(),
    changeWorkspaceFolders: async () => unused(),
    hover: async () => unused(),
    definition: async () => unused(),
    references: async () => unused(),
    documentSymbols: async () => unused(),
    completion: async () => unused(),
    formatDocument: async () => unused(),
    rename: async () => unused(),
    codeActions: async () => unused(),
    diagnostics: () => null,
    snapshot: () => null,
    attach: () => unused(),
    ...overrides,
  };
}

function fakeDap(overrides: Partial<DebugAdapterSupervisor> = {}): DebugAdapterSupervisor {
  return {
    start: async () => unused(),
    prepareConfirmation: () => unused(),
    captureSessionArtifact: async () => unused(),
    disconnect: async () => unused(),
    terminate: async () => unused(),
    cancel: async () => unused(),
    setBreakpoints: async () => unused(),
    configurationDone: async () => unused(),
    launch: async () => unused(),
    attachTarget: async () => unused(),
    threads: async () => unused(),
    stackTrace: async () => unused(),
    continueExecution: async () => unused(),
    next: async () => unused(),
    stepIn: async () => unused(),
    stepOut: async () => unused(),
    scopes: async () => unused(),
    variables: async () => unused(),
    evaluate: async () => unused(),
    pause: async () => unused(),
    snapshot: () => null,
    attach: () => unused(),
    ...overrides,
  } as DebugAdapterSupervisor;
}

describe("composeProductLanguageTools", () => {
  test("registers LSP/DAP tools and routes hover through the supervisor", async () => {
    const tools = composeProductLanguageTools({
      generation: configurationGeneration.from(0),
      languageServers: fakeLsp({
        hover: async () => ok({ contents: { kind: "markdown", value: "hi" } }),
        diagnostics: () => ({
          uri: "file:///a.ts",
          version: 1,
          diagnostics: [],
        }),
      }),
      debugAdapters: fakeDap({
        stackTrace: async () => ok([]),
      }),
    });

    expect(tools.owner).toBe("#714");
    expect(tools.toolNames).toContain("lsp_hover");
    expect(tools.toolNames).toContain("dap_stack_trace");
    expect(tools.catalog.resolve("lsp_definition")?.effect).toBe("observation");
    expect(tools.catalog.resolve("dap_launch")?.effect).toBe("mutation");

    const hover = await tools.runner.execute({
      invocationId: invocationId.from("inv-hover"),
      toolCallId: "call-hover",
      toolName: "lsp_hover",
      capabilityId: capabilityId.from("builtin:workspace/lsp_hover@1"),
      version: 1,
      effect: "observation",
      input: {
        serviceId: String(managedServiceId.from("lsp-1")),
        generation: Number(serviceGeneration.from(1)),
        uri: "file:///a.ts",
        line: 1,
        character: 2,
      },
      signal: new AbortController().signal,
    });
    expect(hover.status).toBe("completed");

    const stack = await tools.runner.execute({
      invocationId: invocationId.from("inv-stack"),
      toolCallId: "call-stack",
      toolName: "dap_stack_trace",
      capabilityId: capabilityId.from("builtin:workspace/dap_stack_trace@1"),
      version: 1,
      effect: "observation",
      input: {
        serviceId: String(managedServiceId.from("dap-1")),
        generation: Number(serviceGeneration.from(1)),
        threadId: 1,
        stoppedGeneration: 1,
      },
      signal: new AbortController().signal,
    });
    expect(stack.status).toBe("completed");
  });
});
