/** Strict product LSP operations and negotiated capability checks (#805). */

import type { z } from "zod";

import {
  configurationGeneration,
  managedServiceId,
  parseDefinitionResult,
  parseDocumentSymbolsResult,
  serviceGeneration,
} from "../../domain/index.ts";
import type { LanguageServerSupervisor } from "../language-server.ts";
import {
  completed,
  errorCode,
  failed,
  type ProductLanguageToolDefinition,
  parseInput,
  resultOutputSchema,
  type StrictRecordSchema,
  sessionInputSchema,
  toolDocument,
  unavailable,
} from "./contracts.ts";
import {
  changeSchema,
  codeActionSchema,
  documentSchema,
  formatSchema,
  hierarchyItemSchema,
  openSchema,
  positionInputSchema,
  rangeFormatSchema,
  referencesSchema,
  renameSchema,
  restartSchema,
  saveSchema,
  startSchema,
  workspaceFoldersSchema,
  workspaceSymbolsSchema,
} from "./lsp-schemas.ts";

const MAX_EXTENDED_RESULT_BYTES = 256 * 1_024;
const MAX_EXTENDED_RESULT_ITEMS = 512;

type Session = { readonly serviceId: string; readonly generation: number };

function ids(input: Session) {
  return {
    serviceId: managedServiceId.from(input.serviceId),
    generation: serviceGeneration.from(input.generation),
  };
}

function startRequest(input: z.infer<typeof startSchema>) {
  return {
    serviceId: managedServiceId.from(input.serviceId),
    key: {
      workspaceRoot: input.workspaceRoot,
      serverName: input.serverName,
      configurationGeneration: configurationGeneration.from(input.configurationGeneration),
    },
    executable: input.executable,
    argv: input.argv,
    environment: input.environment,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    initialize: input.initialize,
    ...(input.limits === undefined ? {} : { limits: input.limits }),
  };
}

function property(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Readonly<Record<string, unknown>>)[key];
  }
  return current;
}

function negotiated(
  lsp: LanguageServerSupervisor,
  input: Session,
  method: string,
  paths: readonly (readonly string[])[],
): true | string {
  const session = ids(input);
  const snapshot = lsp.snapshot(session.serviceId);
  if (snapshot === null) {
    return "language-server-not-found";
  }
  if (snapshot.generation !== session.generation) {
    return "stale-language-server-generation";
  }
  if (snapshot.state !== "ready" && snapshot.state !== "degraded") {
    return `language-server-${snapshot.state}`;
  }
  if (snapshot.registeredCapabilities.some((item) => item.method === method)) {
    return true;
  }
  for (const path of paths) {
    const value = property(snapshot.capabilities, path);
    if (value !== undefined && value !== null && value !== false && value !== 0) {
      return true;
    }
  }
  return `unsupported-capability:${method}`;
}

function sessionReady(lsp: LanguageServerSupervisor, input: Session): true | string {
  const session = ids(input);
  const snapshot = lsp.snapshot(session.serviceId);
  if (snapshot === null) {
    return "language-server-not-found";
  }
  if (snapshot.generation !== session.generation) {
    return "stale-language-server-generation";
  }
  return true;
}

function boundedExtendedResult(value: unknown): unknown | null {
  const encoded = JSON.stringify(value);
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).byteLength > MAX_EXTENDED_RESULT_BYTES
  ) {
    return null;
  }
  if (Array.isArray(value) && value.length > MAX_EXTENDED_RESULT_ITEMS) {
    return null;
  }
  return value;
}

function definition(options: {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly effect: "observation" | "mutation" | "external" | "interactive";
  readonly inputSchema: StrictRecordSchema;
  readonly execute: ProductLanguageToolDefinition["execute"];
}): ProductLanguageToolDefinition {
  return {
    document: toolDocument({
      name: options.name,
      title: options.title,
      description: options.description,
      effect: options.effect,
      capabilityKind: "lsp",
    }),
    inputSchema: options.inputSchema,
    outputSchema: resultOutputSchema,
    execute: options.execute,
  };
}

function positionFeature(
  lsp: LanguageServerSupervisor,
  options: {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly method: string;
    readonly paths: readonly (readonly string[])[];
    readonly run: (
      session: ReturnType<typeof ids>,
      input: z.infer<typeof positionInputSchema>,
      signal: AbortSignal,
    ) => Promise<{ readonly ok: boolean; readonly value?: unknown; readonly error?: unknown }>;
  },
): ProductLanguageToolDefinition {
  return definition({
    ...options,
    effect: "observation",
    inputSchema: positionInputSchema,
    execute: async (request) => {
      const input = parseInput(positionInputSchema, request);
      if (input === null) return failed("malformed-input");
      const support = negotiated(lsp, input, options.method, options.paths);
      if (support !== true) return unavailable(support);
      const result = await options.run(ids(input), input, request.signal);
      if (!result.ok) return failed(errorCode(result.error as { readonly code?: string }));
      return completed(result.value ?? null);
    },
  });
}

export function lspToolDefinitions(
  lsp: LanguageServerSupervisor,
): readonly ProductLanguageToolDefinition[] {
  const definitions: ProductLanguageToolDefinition[] = [
    definition({
      name: "lsp_start",
      title: "Start language server",
      description: "Start and initialize one managed language server",
      effect: "external",
      inputSchema: startSchema,
      execute: async (request) => {
        const input = parseInput(startSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await lsp.start(startRequest(input), request.signal);
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "lsp_status",
      title: "Language server status",
      description: "Inspect lifecycle, negotiated capabilities, documents, and workspace folders",
      effect: "observation",
      inputSchema: sessionInputSchema,
      execute: async (request) => {
        const input = parseInput(sessionInputSchema, request);
        if (input === null) return failed("malformed-input");
        const ready = sessionReady(lsp, input);
        if (ready !== true) return unavailable(ready);
        return completed(lsp.snapshot(ids(input).serviceId));
      },
    }),
    definition({
      name: "lsp_restart",
      title: "Restart language server",
      description: "Shutdown one generation and initialize its explicit replacement request",
      effect: "external",
      inputSchema: restartSchema,
      execute: async (request) => {
        const input = parseInput(restartSchema, request);
        if (input === null) return failed("malformed-input");
        const stopped = await lsp.shutdown(
          managedServiceId.from(input.serviceId),
          serviceGeneration.from(input.generation),
          request.signal,
        );
        if (!stopped.ok) return failed(errorCode(stopped.error));
        const started = await lsp.start(startRequest(input), request.signal);
        return started.ok ? completed(started.value) : failed(errorCode(started.error));
      },
    }),
    definition({
      name: "lsp_shutdown",
      title: "Shutdown language server",
      description: "Shutdown and stop one exact language-server generation",
      effect: "external",
      inputSchema: sessionInputSchema,
      execute: async (request) => {
        const input = parseInput(sessionInputSchema, request);
        if (input === null) return failed("malformed-input");
        const result = await lsp.shutdown(
          ids(input).serviceId,
          ids(input).generation,
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "lsp_open_document",
      title: "Open LSP document",
      description: "Synchronize exact document text into one language server",
      effect: "mutation",
      inputSchema: openSchema,
      execute: async (request) => {
        const input = parseInput(openSchema, request);
        if (input === null) return failed("malformed-input");
        const session = ids(input);
        const result = await lsp.openDocument(session.serviceId, session.generation, {
          uri: input.uri,
          languageId: input.languageId,
          text: input.text,
          ...(input.version === undefined ? {} : { version: input.version }),
        });
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "lsp_change_document",
      title: "Change LSP document",
      description: "Apply a versioned full or incremental document synchronization change",
      effect: "mutation",
      inputSchema: changeSchema,
      execute: async (request) => {
        const input = parseInput(changeSchema, request);
        if (input === null) return failed("malformed-input");
        const session = ids(input);
        const result = await lsp.changeDocument(session.serviceId, session.generation, {
          uri: input.uri,
          version: input.version,
          contentChanges: input.contentChanges,
        });
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "lsp_save_document",
      title: "Save LSP document",
      description: "Notify one language server that a tracked document was saved",
      effect: "mutation",
      inputSchema: saveSchema,
      execute: async (request) => {
        const input = parseInput(saveSchema, request);
        if (input === null) return failed("malformed-input");
        const session = ids(input);
        const result = await lsp.saveDocument(session.serviceId, session.generation, {
          uri: input.uri,
          ...(input.text === undefined ? {} : { text: input.text }),
        });
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "lsp_close_document",
      title: "Close LSP document",
      description: "Close a tracked language-server document",
      effect: "mutation",
      inputSchema: documentSchema,
      execute: async (request) => {
        const input = parseInput(documentSchema, request);
        if (input === null) return failed("malformed-input");
        const session = ids(input);
        const result = await lsp.closeDocument(session.serviceId, session.generation, {
          uri: input.uri,
        });
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "lsp_workspace_folders",
      title: "Change LSP workspace folders",
      description: "Synchronize an explicit bounded workspace-folder delta",
      effect: "mutation",
      inputSchema: workspaceFoldersSchema,
      execute: async (request) => {
        const input = parseInput(workspaceFoldersSchema, request);
        if (input === null) return failed("malformed-input");
        const support = negotiated(lsp, input, "workspace/didChangeWorkspaceFolders", [
          ["workspace", "workspaceFolders", "supported"],
        ]);
        if (support !== true) return unavailable(support);
        const session = ids(input);
        const result = await lsp.changeWorkspaceFolders(session.serviceId, session.generation, {
          added: input.added,
          removed: input.removed,
        });
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    positionFeature(lsp, {
      name: "lsp_hover",
      title: "LSP hover",
      description: "Read bounded hover information at an open document position",
      method: "textDocument/hover",
      paths: [["hoverProvider"]],
      run: (session, input, signal) =>
        lsp.hover(
          session.serviceId,
          session.generation,
          { uri: input.uri, position: { line: input.line, character: input.character } },
          signal,
        ),
    }),
    positionFeature(lsp, {
      name: "lsp_definition",
      title: "LSP definition",
      description: "Find definitions at an open document position",
      method: "textDocument/definition",
      paths: [["definitionProvider"]],
      run: (session, input, signal) =>
        lsp.definition(
          session.serviceId,
          session.generation,
          { uri: input.uri, position: { line: input.line, character: input.character } },
          signal,
        ),
    }),
  ];

  for (const item of [
    {
      name: "lsp_declaration",
      title: "LSP declaration",
      description: "Find declarations at an open document position",
      kind: "declaration" as const,
      method: "textDocument/declaration",
      paths: [["declarationProvider"]] as const,
    },
    {
      name: "lsp_type_definition",
      title: "LSP type definition",
      description: "Find type definitions at an open document position",
      kind: "type-definition" as const,
      method: "textDocument/typeDefinition",
      paths: [["typeDefinitionProvider"]] as const,
    },
    {
      name: "lsp_implementation",
      title: "LSP implementation",
      description: "Find implementations at an open document position",
      kind: "implementation" as const,
      method: "textDocument/implementation",
      paths: [["implementationProvider"]] as const,
    },
  ]) {
    definitions.push(
      positionFeature(lsp, {
        ...item,
        run: async (session, input, signal) => {
          const raw = await lsp.extendedFeature(
            session.serviceId,
            session.generation,
            {
              kind: item.kind,
              uri: input.uri,
              position: { line: input.line, character: input.character },
            },
            signal,
          );
          if (!raw.ok) return raw;
          const parsed = parseDefinitionResult(raw.value);
          return parsed.ok
            ? { ok: true, value: parsed.value }
            : { ok: false, error: { code: parsed.error } };
        },
      }),
    );
  }

  definitions.push(
    definition({
      name: "lsp_references",
      title: "LSP references",
      description: "Find bounded references at an open document position",
      effect: "observation",
      inputSchema: referencesSchema,
      execute: async (request) => {
        const input = parseInput(referencesSchema, request);
        if (input === null) return failed("malformed-input");
        const support = negotiated(lsp, input, "textDocument/references", [["referencesProvider"]]);
        if (support !== true) return unavailable(support);
        const session = ids(input);
        const result = await lsp.references(
          session.serviceId,
          session.generation,
          {
            uri: input.uri,
            position: { line: input.line, character: input.character },
            includeDeclaration: input.includeDeclaration,
          },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "lsp_document_symbols",
      title: "LSP document symbols",
      description: "Read bounded symbols for one open document",
      effect: "observation",
      inputSchema: documentSchema,
      execute: async (request) => {
        const input = parseInput(documentSchema, request);
        if (input === null) return failed("malformed-input");
        const support = negotiated(lsp, input, "textDocument/documentSymbol", [
          ["documentSymbolProvider"],
        ]);
        if (support !== true) return unavailable(support);
        const session = ids(input);
        const result = await lsp.documentSymbols(
          session.serviceId,
          session.generation,
          { uri: input.uri },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "lsp_workspace_symbols",
      title: "LSP workspace symbols",
      description: "Search bounded symbols across the active language-server workspace",
      effect: "observation",
      inputSchema: workspaceSymbolsSchema,
      execute: async (request) => {
        const input = parseInput(workspaceSymbolsSchema, request);
        if (input === null) return failed("malformed-input");
        const support = negotiated(lsp, input, "workspace/symbol", [["workspaceSymbolProvider"]]);
        if (support !== true) return unavailable(support);
        const session = ids(input);
        const raw = await lsp.extendedFeature(
          session.serviceId,
          session.generation,
          { kind: "workspace-symbols", query: input.query },
          request.signal,
        );
        if (!raw.ok) return failed(errorCode(raw.error));
        const parsed = parseDocumentSymbolsResult(raw.value);
        return parsed.ok ? completed(parsed.value) : failed(parsed.error);
      },
    }),
    definition({
      name: "lsp_diagnostics",
      title: "LSP diagnostics",
      description: "Read the latest bounded published diagnostics for a tracked document",
      effect: "observation",
      inputSchema: documentSchema,
      execute: async (request) => {
        const input = parseInput(documentSchema, request);
        if (input === null) return failed("malformed-input");
        const ready = sessionReady(lsp, input);
        if (ready !== true) return unavailable(ready);
        return completed(lsp.diagnostics(ids(input).serviceId, input.uri));
      },
    }),
    positionFeature(lsp, {
      name: "lsp_completion",
      title: "LSP completion",
      description: "Read bounded completion candidates at an open document position",
      method: "textDocument/completion",
      paths: [["completionProvider"]],
      run: (session, input, signal) =>
        lsp.completion(
          session.serviceId,
          session.generation,
          { uri: input.uri, position: { line: input.line, character: input.character } },
          signal,
        ),
    }),
    positionFeature(lsp, {
      name: "lsp_signature_help",
      title: "LSP signature help",
      description: "Read bounded signature-help data at an open document position",
      method: "textDocument/signatureHelp",
      paths: [["signatureHelpProvider"]],
      run: async (session, input, signal) => {
        const result = await lsp.extendedFeature(
          session.serviceId,
          session.generation,
          {
            kind: "signature-help",
            uri: input.uri,
            position: { line: input.line, character: input.character },
          },
          signal,
        );
        if (!result.ok) return result;
        const bounded = boundedExtendedResult(result.value);
        return bounded === null
          ? { ok: false, error: { code: "result-too-large" } }
          : { ok: true, value: bounded };
      },
    }),
    definition({
      name: "lsp_format",
      title: "LSP format proposal",
      description:
        "Convert negotiated document-format edits into a stale-safe Falryn patch proposal",
      effect: "observation",
      inputSchema: formatSchema,
      execute: async (request) => {
        const input = parseInput(formatSchema, request);
        if (input === null) return failed("malformed-input");
        const support = negotiated(lsp, input, "textDocument/formatting", [
          ["documentFormattingProvider"],
        ]);
        if (support !== true) return unavailable(support);
        const session = ids(input);
        const result = await lsp.formatDocument(
          session.serviceId,
          session.generation,
          {
            uri: input.uri,
            ...(input.tabSize === undefined ? {} : { tabSize: input.tabSize }),
            ...(input.insertSpaces === undefined ? {} : { insertSpaces: input.insertSpaces }),
          },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "lsp_format_range",
      title: "LSP range-format proposal",
      description: "Convert negotiated range-format edits into a stale-safe Falryn patch proposal",
      effect: "observation",
      inputSchema: rangeFormatSchema,
      execute: async (request) => {
        const input = parseInput(rangeFormatSchema, request);
        if (input === null) return failed("malformed-input");
        const support = negotiated(lsp, input, "textDocument/rangeFormatting", [
          ["documentRangeFormattingProvider"],
        ]);
        if (support !== true) return unavailable(support);
        const session = ids(input);
        const result = await lsp.formatRange(
          session.serviceId,
          session.generation,
          {
            uri: input.uri,
            range: input.range,
            ...(input.tabSize === undefined ? {} : { tabSize: input.tabSize }),
            ...(input.insertSpaces === undefined ? {} : { insertSpaces: input.insertSpaces }),
          },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "lsp_rename",
      title: "LSP rename proposal",
      description:
        "Convert a negotiated rename workspace edit into one stale-safe Falryn patch proposal",
      effect: "observation",
      inputSchema: renameSchema,
      execute: async (request) => {
        const input = parseInput(renameSchema, request);
        if (input === null) return failed("malformed-input");
        const support = negotiated(lsp, input, "textDocument/rename", [["renameProvider"]]);
        if (support !== true) return unavailable(support);
        const session = ids(input);
        const result = await lsp.rename(
          session.serviceId,
          session.generation,
          {
            uri: input.uri,
            position: { line: input.line, character: input.character },
            newName: input.newName,
          },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
    definition({
      name: "lsp_code_actions",
      title: "LSP code-action proposals",
      description:
        "Convert negotiated code-action edits into stale-safe Falryn patch proposals; commands remain deferred",
      effect: "observation",
      inputSchema: codeActionSchema,
      execute: async (request) => {
        const input = parseInput(codeActionSchema, request);
        if (input === null) return failed("malformed-input");
        const support = negotiated(lsp, input, "textDocument/codeAction", [["codeActionProvider"]]);
        if (support !== true) return unavailable(support);
        const session = ids(input);
        const result = await lsp.codeActions(
          session.serviceId,
          session.generation,
          {
            uri: input.uri,
            range: input.range,
            ...(input.only === undefined ? {} : { only: input.only }),
          },
          request.signal,
        );
        return result.ok ? completed(result.value) : failed(errorCode(result.error));
      },
    }),
  );

  for (const item of [
    {
      name: "lsp_call_hierarchy_prepare",
      title: "Prepare LSP call hierarchy",
      description: "Prepare bounded call-hierarchy items at a document position",
      kind: "call-hierarchy-prepare" as const,
      method: "textDocument/prepareCallHierarchy",
      paths: [["callHierarchyProvider"]] as const,
    },
    {
      name: "lsp_type_hierarchy_prepare",
      title: "Prepare LSP type hierarchy",
      description: "Prepare bounded type-hierarchy items at a document position",
      kind: "type-hierarchy-prepare" as const,
      method: "textDocument/prepareTypeHierarchy",
      paths: [["typeHierarchyProvider"]] as const,
    },
  ]) {
    definitions.push(
      positionFeature(lsp, {
        ...item,
        run: async (session, input, signal) => {
          const result = await lsp.extendedFeature(
            session.serviceId,
            session.generation,
            {
              kind: item.kind,
              uri: input.uri,
              position: { line: input.line, character: input.character },
            },
            signal,
          );
          if (!result.ok) return result;
          const bounded = boundedExtendedResult(result.value);
          return bounded === null
            ? { ok: false, error: { code: "result-too-large" } }
            : { ok: true, value: bounded };
        },
      }),
    );
  }

  for (const item of [
    {
      name: "lsp_call_hierarchy_incoming",
      title: "LSP incoming calls",
      description: "Read bounded incoming calls for one prepared hierarchy item",
      kind: "call-hierarchy-incoming" as const,
      method: "callHierarchy/incomingCalls",
      paths: [["callHierarchyProvider"]] as const,
    },
    {
      name: "lsp_call_hierarchy_outgoing",
      title: "LSP outgoing calls",
      description: "Read bounded outgoing calls for one prepared hierarchy item",
      kind: "call-hierarchy-outgoing" as const,
      method: "callHierarchy/outgoingCalls",
      paths: [["callHierarchyProvider"]] as const,
    },
    {
      name: "lsp_type_hierarchy_supertypes",
      title: "LSP supertypes",
      description: "Read bounded supertypes for one prepared hierarchy item",
      kind: "type-hierarchy-supertypes" as const,
      method: "typeHierarchy/supertypes",
      paths: [["typeHierarchyProvider"]] as const,
    },
    {
      name: "lsp_type_hierarchy_subtypes",
      title: "LSP subtypes",
      description: "Read bounded subtypes for one prepared hierarchy item",
      kind: "type-hierarchy-subtypes" as const,
      method: "typeHierarchy/subtypes",
      paths: [["typeHierarchyProvider"]] as const,
    },
  ]) {
    definitions.push(
      definition({
        name: item.name,
        title: item.title,
        description: item.description,
        effect: "observation",
        inputSchema: hierarchyItemSchema,
        execute: async (request) => {
          const input = parseInput(hierarchyItemSchema, request);
          if (input === null) return failed("malformed-input");
          const support = negotiated(lsp, input, item.method, item.paths);
          if (support !== true) return unavailable(support);
          const session = ids(input);
          const result = await lsp.extendedFeature(
            session.serviceId,
            session.generation,
            { kind: item.kind, item: input.item },
            request.signal,
          );
          if (!result.ok) return failed(errorCode(result.error));
          const bounded = boundedExtendedResult(result.value);
          return bounded === null ? failed("result-too-large") : completed(bounded);
        },
      }),
    );
  }

  return definitions;
}
