/**
 * Product language tools (#805).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  capabilityId,
  configurationGeneration,
  createInMemoryFileSystem,
  emptyDebugSessionSnapshot,
  invocationId,
  localPath,
  managedServiceId,
  ok,
  serviceGeneration,
  validateAndNormalizeInvocations,
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
    formatRange: async () => unused(),
    rename: async () => unused(),
    codeActions: async () => unused(),
    extendedFeature: async () => unused(),
    diagnostics: () => null,
    document: () => null,
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
        snapshot: () => ({
          serviceId: managedServiceId.from("lsp-1"),
          key: {
            workspaceRoot: "/work",
            serverName: "test",
            configurationGeneration: configurationGeneration.from(0),
          },
          generation: serviceGeneration.from(1),
          state: "ready",
          pid: 1,
          restartCount: 0,
          capabilities: { hoverProvider: true },
          serverInfo: null,
          failureReason: null,
          openDocuments: [{ uri: "file:///a.ts", languageId: "typescript", version: 1 }],
          workspaceFolders: [],
          registeredCapabilities: [],
        }),
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

    expect(tools.owner).toBe("#805");
    expect(tools.toolNames).toContain("lsp_hover");
    expect(tools.toolNames).toContain("dap_stack_trace");
    expect(tools.catalog.resolve("lsp_definition")?.effect).toBe("observation");
    expect(tools.catalog.resolve("dap_launch")?.effect).toBe("external");

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

  test("registers the complete operation matrix with closed model schemas", () => {
    const tools = composeProductLanguageTools({
      generation: configurationGeneration.from(0),
      languageServers: fakeLsp(),
      debugAdapters: fakeDap(),
    });

    expect(tools.toolNames).toHaveLength(59);
    expect(new Set(tools.toolNames).size).toBe(59);
    expect(tools.toolNames).toEqual(
      expect.arrayContaining([
        "lsp_open_document",
        "lsp_type_hierarchy_subtypes",
        "lsp_rename",
        "dap_attach",
        "dap_set_expression",
        "dap_loaded_sources",
        "dap_capture_session",
      ]),
    );
    for (const entry of tools.registry.entries) {
      const schema = z.toJSONSchema(entry.manifest.inputSchema) as {
        readonly additionalProperties?: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
    }
  });

  test("bounds protocol extension maps without exposing a raw request tool", () => {
    const tools = composeProductLanguageTools({
      generation: configurationGeneration.from(0),
      languageServers: fakeLsp(),
      debugAdapters: fakeDap(),
    });
    const launch = tools.registry.resolveByName("dap_launch");
    const start = tools.registry.resolveByName("lsp_start");
    expect(launch).not.toBeNull();
    expect(start).not.toBeNull();
    expect(
      launch?.manifest.inputSchema.safeParse({
        serviceId: "dap-1",
        generation: 1,
        configuration: { program: "dist/falryn", stopOnEntry: true },
      }).success,
    ).toBe(true);

    let nested: unknown = "value";
    for (let depth = 0; depth < 10; depth += 1) nested = { child: nested };
    expect(
      launch?.manifest.inputSchema.safeParse({
        serviceId: "dap-1",
        generation: 1,
        configuration: { nested },
      }).success,
    ).toBe(false);
    expect(
      start?.manifest.inputSchema.safeParse({
        serviceId: "lsp-1",
        workspaceRoot: "/work",
        serverName: "typescript",
        configurationGeneration: 1,
        executable: "/usr/bin/typescript-language-server",
        argv: ["--stdio"],
        environment: Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [`KEY_${index}`, "value"]),
        ),
        initialize: {
          processId: null,
          rootUri: "file:///work",
          workspaceFolders: null,
          capabilities: {},
          clientInfo: { name: "falryn", version: "0" },
        },
      }).success,
    ).toBe(false);
    expect(tools.toolNames).not.toContain("lsp_raw_request");
    expect(tools.toolNames).not.toContain("dap_request");
  });

  test("derives evaluate effects from validated context", () => {
    const tools = composeProductLanguageTools({
      generation: configurationGeneration.from(0),
      languageServers: fakeLsp(),
      debugAdapters: fakeDap(),
    });
    const bind = (context: "watch" | "repl") =>
      validateAndNormalizeInvocations({
        registry: tools.registry,
        proposals: [
          {
            toolCallId: `call-${context}`,
            name: "dap_evaluate",
            arguments: {
              serviceId: "dap-1",
              generation: 1,
              expression: "value",
              stoppedGeneration: 1,
              context,
            },
          },
        ],
        maxQueued: 1,
        nextInvocationId: () => invocationId.from(`inv-${context}`),
      });

    const watch = bind("watch");
    const repl = bind("repl");
    expect(watch.ok && watch.value[0]?.effect).toBe("observation");
    expect(repl.ok && repl.value[0]?.effect).toBe("interactive");
  });

  test("rejects unknown fields and unsupported capabilities before transport", async () => {
    let hoverCalls = 0;
    const lsp = fakeLsp({
      hover: async () => {
        hoverCalls += 1;
        return ok(null);
      },
      snapshot: () => ({
        serviceId: managedServiceId.from("lsp-1"),
        key: {
          workspaceRoot: "/work",
          serverName: "test",
          configurationGeneration: configurationGeneration.from(0),
        },
        generation: serviceGeneration.from(1),
        state: "ready",
        pid: 1,
        restartCount: 0,
        capabilities: {},
        serverInfo: null,
        failureReason: null,
        openDocuments: [],
        workspaceFolders: [],
        registeredCapabilities: [],
      }),
    });
    const tools = composeProductLanguageTools({
      generation: configurationGeneration.from(0),
      languageServers: lsp,
      debugAdapters: fakeDap(),
    });
    const entry = tools.registry.resolveByName("lsp_hover");
    expect(
      entry?.manifest.inputSchema.safeParse({
        serviceId: "lsp-1",
        generation: 1,
        uri: "file:///work/a.ts",
        line: 0,
        character: 0,
        hidden: true,
      }).success,
    ).toBe(false);

    const outcome = await tools.runner.execute({
      invocationId: invocationId.from("inv-unsupported-hover"),
      toolCallId: "call-unsupported-hover",
      toolName: "lsp_hover",
      capabilityId: capabilityId.from("builtin:workspace/lsp_hover@1"),
      version: 1,
      effect: "observation",
      input: {
        serviceId: "lsp-1",
        generation: 1,
        uri: "file:///work/a.ts",
        line: 0,
        character: 0,
      },
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({
      status: "unavailable",
      reason: "unsupported-capability:textDocument/hover",
      effect: "none",
    });
    expect(hoverCalls).toBe(0);
  });

  test("admits only exception-breakpoint filters negotiated by the adapter", async () => {
    const requests: string[] = [];
    const tools = composeProductLanguageTools({
      generation: configurationGeneration.from(0),
      languageServers: fakeLsp(),
      debugAdapters: fakeDap({
        snapshot: () =>
          ({
            serviceId: managedServiceId.from("dap-1"),
            key: {
              workspaceRoot: "/work",
              adapterName: "test",
              configurationGeneration: configurationGeneration.from(0),
            },
            generation: serviceGeneration.from(1),
            state: "ready",
            pid: 1,
            restartCount: 0,
            capabilities: {
              exceptionBreakpointFilters: [{ filter: "caught" }, { filter: "uncaught" }],
            },
            failureReason: null,
            session: emptyDebugSessionSnapshot(),
          }) satisfies NonNullable<ReturnType<DebugAdapterSupervisor["snapshot"]>>,
        request: async (_serviceId, _generation, command) => {
          requests.push(command);
          return ok({ breakpoints: [] });
        },
      }),
    });
    const execute = (filter: string, suffix: string) =>
      tools.runner.execute({
        invocationId: invocationId.from(`inv-exception-${suffix}`),
        toolCallId: `call-exception-${suffix}`,
        toolName: "dap_set_exception_breakpoints",
        capabilityId: capabilityId.from("builtin:workspace/dap_set_exception_breakpoints@1"),
        version: 1,
        effect: "mutation",
        input: { serviceId: "dap-1", generation: 1, filters: [filter] },
        signal: new AbortController().signal,
      });

    expect((await execute("caught", "supported")).status).toBe("completed");
    expect(await execute("other", "unsupported")).toEqual({
      status: "unavailable",
      reason: "unsupported-exception-filter",
      effect: "none",
    });
    expect(requests).toEqual(["setExceptionBreakpoints"]);
  });

  test("resynchronizes changed open documents and returns diagnostic feedback", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        "/work": { kind: "directory" },
        "/work/a.ts": { kind: "file", text: "export const value = 2;\n" },
      },
    });
    let changedText = "";
    let saved = 0;
    const snapshot = {
      serviceId: managedServiceId.from("lsp-1"),
      key: {
        workspaceRoot: "/work",
        serverName: "test",
        configurationGeneration: configurationGeneration.from(0),
      },
      generation: serviceGeneration.from(1),
      state: "ready" as const,
      pid: 1,
      restartCount: 0,
      capabilities: {},
      serverInfo: null,
      failureReason: null,
      openDocuments: [{ uri: "file:///work/a.ts", languageId: "typescript", version: 1 }],
      workspaceFolders: [{ uri: "file:///work", name: "work" }],
      registeredCapabilities: [],
    };
    const tools = composeProductLanguageTools({
      generation: configurationGeneration.from(0),
      fileSystem,
      workspaceRoot: localPath("/work"),
      languageServers: fakeLsp({
        snapshot: () => snapshot,
        document: () => ({
          uri: "file:///work/a.ts",
          languageId: "typescript",
          version: 1,
          text: "export const value = 1;\n",
        }),
        changeDocument: async (_serviceId, _generation, request) => {
          changedText = request.contentChanges[0]?.text ?? "";
          return ok(snapshot);
        },
        saveDocument: async () => {
          saved += 1;
          return ok(snapshot);
        },
        diagnostics: () => ({
          uri: "file:///work/a.ts",
          version: 2,
          diagnostics: [],
        }),
      }),
      debugAdapters: fakeDap(),
    });
    const status = await tools.runner.execute({
      invocationId: invocationId.from("inv-lsp-status"),
      toolCallId: "call-lsp-status",
      toolName: "lsp_status",
      capabilityId: capabilityId.from("builtin:workspace/lsp_status@1"),
      version: 1,
      effect: "observation",
      input: { serviceId: "lsp-1", generation: 1 },
      signal: new AbortController().signal,
    });
    expect(status.status).toBe("completed");

    const feedback = await tools.afterWorkspaceMutation();
    expect(changedText).toBe("export const value = 2;\n");
    expect(saved).toBe(1);
    expect(feedback).toEqual({
      status: "completed",
      servers: [
        {
          serviceId: "lsp-1",
          generation: 1,
          status: "completed",
          documents: [
            {
              uri: "file:///work/a.ts",
              status: "synchronized",
              diagnostics: {
                uri: "file:///work/a.ts",
                version: 2,
                diagnostics: [],
              },
            },
          ],
        },
      ],
    });
  });

  test("refuses an open document whose symlink escapes the workspace", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        "/work": { kind: "directory" },
        "/work/out.ts": { kind: "symlink", target: "/secret.ts" },
        "/secret.ts": { kind: "file", text: "private\n" },
      },
    });
    const snapshot = {
      serviceId: managedServiceId.from("lsp-escape"),
      key: {
        workspaceRoot: "/work",
        serverName: "test",
        configurationGeneration: configurationGeneration.from(0),
      },
      generation: serviceGeneration.from(1),
      state: "ready" as const,
      pid: 1,
      restartCount: 0,
      capabilities: {},
      serverInfo: null,
      failureReason: null,
      openDocuments: [{ uri: "file:///work/out.ts", languageId: "typescript", version: 1 }],
      workspaceFolders: [{ uri: "file:///work", name: "work" }],
      registeredCapabilities: [],
    };
    let changeCalls = 0;
    const tools = composeProductLanguageTools({
      generation: configurationGeneration.from(0),
      fileSystem,
      workspaceRoot: localPath("/work"),
      languageServers: fakeLsp({
        snapshot: () => snapshot,
        document: () => ({
          uri: "file:///work/out.ts",
          languageId: "typescript",
          version: 1,
          text: "old\n",
        }),
        changeDocument: async () => {
          changeCalls += 1;
          return ok(snapshot);
        },
      }),
      debugAdapters: fakeDap(),
    });
    await tools.runner.execute({
      invocationId: invocationId.from("inv-lsp-escape"),
      toolCallId: "call-lsp-escape",
      toolName: "lsp_status",
      capabilityId: capabilityId.from("builtin:workspace/lsp_status@1"),
      version: 1,
      effect: "observation",
      input: { serviceId: "lsp-escape", generation: 1 },
      signal: new AbortController().signal,
    });

    expect(await tools.afterWorkspaceMutation()).toEqual({
      status: "completed",
      servers: [
        {
          serviceId: "lsp-escape",
          generation: 1,
          status: "completed",
          documents: [{ uri: "file:///work/out.ts", status: "path-symlink-escape" }],
        },
      ],
    });
    expect(changeCalls).toBe(0);
  });
});
