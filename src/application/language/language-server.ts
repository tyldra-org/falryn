/**
 * Language-server supervisor (#89–#92).
 *
 * Starts a managed process, speaks JSON-RPC over its stdio pipes, completes
 * initialize, synchronizes documents, admits feature requests, observes
 * diagnostics, converts format/rename/code-action edits into previewable patch
 * plans, and performs shutdown/exit. Indexes remain #93.
 */

export * from "./language-server/contracts.ts";

import { duration } from "../../domain/foundation/index.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import {
  applyContentChanges,
  codeActionToPatchPlan,
  createJsonRpcFrameDecoder,
  describeLanguageServerFailure,
  LANGUAGE_SERVER_PROTOCOL,
  type LanguageServerEditToPatchResult,
  languageServerLimits,
  MAX_LANGUAGE_SERVER_OPEN_DOCUMENTS,
  mergeWorkspaceFolders,
  parseCodeActionResult,
  parseCompletionResult,
  parseDefinitionResult,
  parseDocumentSymbolsResult,
  parseHover,
  parseLanguageServerInitializeResult,
  parseReferencesResult,
  parseTextEditArray,
  parseWorkspaceEdit,
  validateChangeDocumentRequest,
  validateCodeActionsRequest,
  validateDocumentUri,
  validateFormatRequest,
  validateLanguageServerStartRequest,
  validateOpenDocumentRequest,
  validateRange,
  validateRenameRequest,
  validateTextDocumentPosition,
  validateWorkspaceFoldersChange,
  workspaceEditToPatchPlan,
} from "../../domain/language/index.ts";
import type { ManagedServicePort } from "../../domain/process/index.ts";
import { DEFAULT_PATCH_LIMITS } from "../../domain/workspace/index.ts";
import type { LanguageServerSupervisor } from "./language-server/contracts.ts";
import {
  createLanguageTransport,
  type LiveServer,
  mapManagedStartError,
} from "./language-server/transport.ts";

export function createLanguageServerSupervisor(
  managedServices: ManagedServicePort,
): LanguageServerSupervisor {
  const {
    servers,
    emit,
    setState,
    snapshotOf,
    fail,
    requireReady,
    mapEditFailure,
    workspaceFolderUris,
    sendRequest,
    sendNotification,
    handleMessage,
    onManagedEvent,
  } = createLanguageTransport(managedServices);

  return {
    async start(request, signal) {
      const invalid = validateLanguageServerStartRequest(request);
      if (invalid !== null) {
        return err(invalid);
      }
      const limitsResult = languageServerLimits(request.limits ?? {});
      if (!limitsResult.ok) {
        return limitsResult;
      }
      if (servers.has(request.serviceId)) {
        const existing = servers.get(request.serviceId);
        if (existing !== undefined && existing.state !== "stopped" && existing.state !== "failed") {
          return err({ kind: "language-server", code: "already-running" });
        }
      }

      const started = await managedServices.start({
        serviceId: request.serviceId,
        protocol: LANGUAGE_SERVER_PROTOCOL,
        executable: request.executable,
        argv: request.argv,
        environment: request.environment,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        readiness: { kind: "immediate" },
        idle: { kind: "disabled" },
        restart: {
          maxRestarts: limitsResult.value.maxRestarts,
          windowMs: duration(limitsResult.value.restartWindowMs),
        },
        shutdownTimeoutMs: duration(limitsResult.value.shutdownTimeoutMs),
        replayBytes: 64 * 1024,
      });
      if (!started.ok) {
        return err(mapManagedStartError(started.error));
      }

      const initialFolders = request.initialize.workspaceFolders ?? [];
      const server: LiveServer = {
        request,
        limits: limitsResult.value,
        generation: started.value.generation,
        state: "starting",
        pid: started.value.pid,
        restartCount: started.value.restartCount,
        capabilities: null,
        serverInfo: null,
        failureReason: null,
        order: 0,
        nextRequestId: 1,
        decoder: createJsonRpcFrameDecoder(limitsResult.value.maxFrameBytes),
        listeners: new Set(),
        detachManaged: null,
        pending: new Map(),
        openDocuments: new Map(),
        workspaceFolders: [...initialFolders],
        registeredCapabilities: new Map(),
        diagnosticsByUri: new Map(),
      };
      servers.set(request.serviceId, server);
      setState(server, "starting");

      const attached = managedServices.attach(request.serviceId, (event) => {
        onManagedEvent(server, event);
      });
      if (!attached.ok) {
        return err(mapManagedStartError(attached.error));
      }
      server.detachManaged = attached.value.detach;
      if (attached.value.replay.stdout.byteLength > 0) {
        const decoded = server.decoder.push(attached.value.replay.stdout);
        if (!decoded.ok) {
          return err(fail(server, "malformed-response"));
        }
        for (const message of decoded.value) {
          handleMessage(server, message);
        }
      }

      setState(server, "initializing");
      const initialized = await sendRequest(
        server,
        "initialize",
        request.initialize,
        limitsResult.value.initializeTimeoutMs,
        signal,
      );
      if (!initialized.ok) {
        fail(
          server,
          initialized.error.kind === "language-server" &&
            initialized.error.code !== "invalid-request" &&
            initialized.error.code !== "invalid-limits" &&
            initialized.error.code !== "transport"
            ? initialized.error.code
            : "initialization-failure",
        );
        await managedServices.stop(request.serviceId, server.generation, "requested");
        return err(initialized.error);
      }

      const parsed = parseLanguageServerInitializeResult(initialized.value);
      if (!parsed.ok) {
        fail(server, "malformed-response");
        await managedServices.stop(request.serviceId, server.generation, "requested");
        return parsed;
      }

      const notified = await sendNotification(server, "initialized", {});
      if (!notified.ok) {
        fail(server, "initialization-failure");
        await managedServices.stop(request.serviceId, server.generation, "requested");
        return notified;
      }

      server.capabilities = parsed.value.capabilities;
      server.serverInfo = parsed.value.serverInfo;
      setState(server, "ready");
      emit(server, {
        kind: "initialized",
        capabilities: parsed.value.capabilities,
        serverInfo: parsed.value.serverInfo,
      });
      return ok(snapshotOf(server));
    },

    async shutdown(serviceId, generation, signal) {
      const server = servers.get(serviceId);
      if (server === undefined) {
        return err({ kind: "language-server", code: "not-found" });
      }
      if (server.generation !== generation) {
        return err({ kind: "language-server", code: "stale-generation" });
      }
      if (server.state === "stopped") {
        return ok(snapshotOf(server));
      }
      if (server.state === "failed") {
        const stopped = await managedServices.stop(serviceId, generation, "shutdown");
        if (!stopped.ok && stopped.error.code !== "not-found") {
          return err(mapManagedStartError(stopped.error));
        }
        setState(server, "stopped");
        return ok(snapshotOf(server));
      }

      const wasReady = server.state === "ready" || server.state === "degraded";
      setState(server, "shutting-down");
      if (wasReady) {
        await sendRequest(server, "shutdown", null, server.limits.shutdownTimeoutMs, signal);
        await sendNotification(server, "exit");
      }

      const stopped = await managedServices.stop(serviceId, generation, "shutdown");
      if (!stopped.ok) {
        if (stopped.error.code === "shutdown-timeout") {
          fail(server, "shutdown-timeout");
          return err({ kind: "language-server", code: "shutdown-timeout" });
        }
        if (stopped.error.code !== "not-found" && stopped.error.code !== "stale-generation") {
          return err(mapManagedStartError(stopped.error));
        }
      }
      for (const pending of server.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject({ kind: "language-server", code: "cancelled" });
      }
      server.pending.clear();
      server.openDocuments.clear();
      server.registeredCapabilities.clear();
      server.diagnosticsByUri.clear();
      server.detachManaged?.();
      server.detachManaged = null;
      setState(server, "stopped");
      emit(server, { kind: "stopped" });
      return ok(snapshotOf(server));
    },

    async openDocument(serviceId, generation, request) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const server = ready.value;
      const invalid = validateOpenDocumentRequest(request);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      if (server.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-already-open" });
      }
      if (server.openDocuments.size >= MAX_LANGUAGE_SERVER_OPEN_DOCUMENTS) {
        return err({ kind: "language-server", code: "capacity-exceeded" });
      }
      const version = request.version ?? 1;
      const notified = await sendNotification(server, "textDocument/didOpen", {
        textDocument: {
          uri: request.uri,
          languageId: request.languageId,
          version,
          text: request.text,
        },
      });
      if (!notified.ok) {
        return notified;
      }
      server.openDocuments.set(request.uri, {
        uri: request.uri,
        languageId: request.languageId,
        version,
        text: request.text,
      });
      emit(server, {
        kind: "document-opened",
        uri: request.uri,
        languageId: request.languageId,
        version,
      });
      return ok(snapshotOf(server));
    },

    async changeDocument(serviceId, generation, request) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const server = ready.value;
      const invalid = validateChangeDocumentRequest(request);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      const current = server.openDocuments.get(request.uri);
      if (current === undefined) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      if (request.version !== current.version + 1) {
        return err({ kind: "language-server", code: "stale-document" });
      }
      const nextText = applyContentChanges(current.text, request.contentChanges);
      if (!nextText.ok) {
        return err({
          kind: "language-server",
          code: "invalid-request",
          reason:
            nextText.error.code === "invalid-request" ? nextText.error.reason : "invalid-change",
        });
      }
      const notified = await sendNotification(server, "textDocument/didChange", {
        textDocument: { uri: request.uri, version: request.version },
        contentChanges: request.contentChanges.map((change) =>
          change.kind === "full"
            ? { text: change.text }
            : { text: change.text, range: change.range },
        ),
      });
      if (!notified.ok) {
        return notified;
      }
      server.openDocuments.set(request.uri, {
        ...current,
        version: request.version,
        text: nextText.value,
      });
      emit(server, {
        kind: "document-changed",
        uri: request.uri,
        version: request.version,
      });
      return ok(snapshotOf(server));
    },

    async saveDocument(serviceId, generation, request) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const server = ready.value;
      const uriInvalid = validateDocumentUri(request.uri);
      if (uriInvalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: uriInvalid });
      }
      if (!server.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const notified = await sendNotification(server, "textDocument/didSave", {
        textDocument: { uri: request.uri },
        ...(request.text === undefined ? {} : { text: request.text }),
      });
      if (!notified.ok) {
        return notified;
      }
      emit(server, { kind: "document-saved", uri: request.uri });
      return ok(snapshotOf(server));
    },

    async closeDocument(serviceId, generation, request) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const server = ready.value;
      if (!server.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const notified = await sendNotification(server, "textDocument/didClose", {
        textDocument: { uri: request.uri },
      });
      if (!notified.ok) {
        return notified;
      }
      server.openDocuments.delete(request.uri);
      server.diagnosticsByUri.delete(request.uri);
      emit(server, { kind: "document-closed", uri: request.uri });
      return ok(snapshotOf(server));
    },

    async hover(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const invalid = validateTextDocumentPosition(request);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      if (!ready.value.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const raw = await sendRequest(
        ready.value,
        "textDocument/hover",
        {
          textDocument: { uri: request.uri },
          position: request.position,
        },
        ready.value.limits.requestTimeoutMs,
        signal,
      );
      if (!raw.ok) {
        return raw;
      }
      const parsed = parseHover(raw.value);
      if (!parsed.ok) {
        return err({ kind: "language-server", code: "invalid-request", reason: parsed.error });
      }
      return ok(parsed.value);
    },

    async definition(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const invalid = validateTextDocumentPosition(request);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      if (!ready.value.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const raw = await sendRequest(
        ready.value,
        "textDocument/definition",
        {
          textDocument: { uri: request.uri },
          position: request.position,
        },
        ready.value.limits.requestTimeoutMs,
        signal,
      );
      if (!raw.ok) {
        return raw;
      }
      const parsed = parseDefinitionResult(raw.value);
      if (!parsed.ok) {
        return err({ kind: "language-server", code: "invalid-request", reason: parsed.error });
      }
      return ok(parsed.value);
    },

    async references(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const invalid = validateTextDocumentPosition(request);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      if (!ready.value.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const raw = await sendRequest(
        ready.value,
        "textDocument/references",
        {
          textDocument: { uri: request.uri },
          position: request.position,
          context: { includeDeclaration: request.includeDeclaration },
        },
        ready.value.limits.requestTimeoutMs,
        signal,
      );
      if (!raw.ok) {
        return raw;
      }
      const parsed = parseReferencesResult(raw.value);
      if (!parsed.ok) {
        return err({ kind: "language-server", code: "invalid-request", reason: parsed.error });
      }
      return ok(parsed.value);
    },

    async documentSymbols(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const uriInvalid = validateDocumentUri(request.uri);
      if (uriInvalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: uriInvalid });
      }
      if (!ready.value.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const raw = await sendRequest(
        ready.value,
        "textDocument/documentSymbol",
        { textDocument: { uri: request.uri } },
        ready.value.limits.requestTimeoutMs,
        signal,
      );
      if (!raw.ok) {
        return raw;
      }
      const parsed = parseDocumentSymbolsResult(raw.value);
      if (!parsed.ok) {
        return err({ kind: "language-server", code: "invalid-request", reason: parsed.error });
      }
      return ok(parsed.value);
    },

    async completion(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const invalid = validateTextDocumentPosition(request);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      if (!ready.value.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const raw = await sendRequest(
        ready.value,
        "textDocument/completion",
        {
          textDocument: { uri: request.uri },
          position: request.position,
        },
        ready.value.limits.requestTimeoutMs,
        signal,
      );
      if (!raw.ok) {
        return raw;
      }
      const parsed = parseCompletionResult(raw.value);
      if (!parsed.ok) {
        return err({ kind: "language-server", code: "invalid-request", reason: parsed.error });
      }
      return ok(parsed.value);
    },

    async formatDocument(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const invalid = validateFormatRequest(request);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      if (!ready.value.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const raw = await sendRequest(
        ready.value,
        "textDocument/formatting",
        {
          textDocument: { uri: request.uri },
          options: {
            tabSize: request.tabSize ?? 2,
            insertSpaces: request.insertSpaces ?? true,
          },
        },
        ready.value.limits.requestTimeoutMs,
        signal,
      );
      if (!raw.ok) {
        return raw;
      }
      const edits = parseTextEditArray(raw.value);
      if (!edits.ok) {
        return err({ kind: "language-server", code: "invalid-request", reason: edits.error });
      }
      const open = ready.value.openDocuments.get(request.uri);
      if (open === undefined) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const converted = workspaceEditToPatchPlan(
        {
          documentEdits: [
            {
              textDocument: { uri: request.uri, version: open.version },
              edits: edits.value,
            },
          ],
        },
        ready.value.openDocuments,
        workspaceFolderUris(ready.value),
      );
      if (!converted.ok) {
        return err(mapEditFailure(converted.error));
      }
      return ok(converted.value);
    },

    async formatRange(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const invalid = validateFormatRequest(request);
      const range = validateRange(request.range);
      if (invalid !== null || !range.ok) {
        return err({
          kind: "language-server",
          code: "invalid-request",
          reason: invalid ?? "invalid-range",
        });
      }
      const open = ready.value.openDocuments.get(request.uri);
      if (open === undefined) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const raw = await sendRequest(
        ready.value,
        "textDocument/rangeFormatting",
        {
          textDocument: { uri: request.uri },
          range: range.value,
          options: {
            tabSize: request.tabSize ?? 2,
            insertSpaces: request.insertSpaces ?? true,
          },
        },
        ready.value.limits.requestTimeoutMs,
        signal,
      );
      if (!raw.ok) {
        return raw;
      }
      const edits = parseTextEditArray(raw.value);
      if (!edits.ok) {
        return err({ kind: "language-server", code: "invalid-request", reason: edits.error });
      }
      const converted = workspaceEditToPatchPlan(
        {
          documentEdits: [
            {
              textDocument: { uri: request.uri, version: open.version },
              edits: edits.value,
            },
          ],
        },
        ready.value.openDocuments,
        workspaceFolderUris(ready.value),
      );
      if (!converted.ok) {
        return err(mapEditFailure(converted.error));
      }
      return ok(converted.value);
    },

    async rename(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const invalid = validateRenameRequest(request);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      if (!ready.value.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const raw = await sendRequest(
        ready.value,
        "textDocument/rename",
        {
          textDocument: { uri: request.uri },
          position: request.position,
          newName: request.newName,
        },
        ready.value.limits.requestTimeoutMs,
        signal,
      );
      if (!raw.ok) {
        return raw;
      }
      const parsed = parseWorkspaceEdit(raw.value);
      if (!parsed.ok) {
        return err({ kind: "language-server", code: "invalid-request", reason: parsed.error });
      }
      if (parsed.value === null) {
        return ok({
          plan: {
            policy: "fail-before-effect",
            expectedPlanId: null,
            expectedGitHead: null,
            limits: DEFAULT_PATCH_LIMITS,
            targets: [],
          },
          deferredCommands: [],
        });
      }
      const converted = workspaceEditToPatchPlan(
        parsed.value,
        ready.value.openDocuments,
        workspaceFolderUris(ready.value),
      );
      if (!converted.ok) {
        return err(mapEditFailure(converted.error));
      }
      return ok(converted.value);
    },

    async codeActions(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const invalid = validateCodeActionsRequest(request);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      if (!ready.value.openDocuments.has(request.uri)) {
        return err({ kind: "language-server", code: "document-not-open" });
      }
      const raw = await sendRequest(
        ready.value,
        "textDocument/codeAction",
        {
          textDocument: { uri: request.uri },
          range: request.range,
          context: {
            diagnostics: [],
            ...(request.only === undefined ? {} : { only: request.only }),
          },
        },
        ready.value.limits.requestTimeoutMs,
        signal,
      );
      if (!raw.ok) {
        return raw;
      }
      const parsed = parseCodeActionResult(raw.value);
      if (!parsed.ok) {
        return err({ kind: "language-server", code: "invalid-request", reason: parsed.error });
      }
      if (parsed.value.kind === "commands") {
        return ok({
          result: parsed.value,
          patches: parsed.value.commands.map((command) => ({
            plan: {
              policy: "fail-before-effect" as const,
              expectedPlanId: null,
              expectedGitHead: null,
              limits: DEFAULT_PATCH_LIMITS,
              targets: [],
            },
            deferredCommands: [command],
          })),
        });
      }
      const patches: LanguageServerEditToPatchResult[] = [];
      for (const action of parsed.value.actions) {
        const converted = codeActionToPatchPlan(
          action,
          ready.value.openDocuments,
          workspaceFolderUris(ready.value),
        );
        if (!converted.ok) {
          return err(mapEditFailure(converted.error));
        }
        patches.push(converted.value);
      }
      return ok({ result: parsed.value, patches });
    },

    async extendedFeature(serviceId, generation, request, signal) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const server = ready.value;
      let method: string;
      let params: unknown;
      switch (request.kind) {
        case "declaration":
        case "type-definition":
        case "implementation":
        case "signature-help":
        case "call-hierarchy-prepare":
        case "type-hierarchy-prepare": {
          const invalid = validateTextDocumentPosition(request);
          if (invalid !== null) {
            return err({ kind: "language-server", code: "invalid-request", reason: invalid });
          }
          if (!server.openDocuments.has(request.uri)) {
            return err({ kind: "language-server", code: "document-not-open" });
          }
          const methods = {
            declaration: "textDocument/declaration",
            "type-definition": "textDocument/typeDefinition",
            implementation: "textDocument/implementation",
            "signature-help": "textDocument/signatureHelp",
            "call-hierarchy-prepare": "textDocument/prepareCallHierarchy",
            "type-hierarchy-prepare": "textDocument/prepareTypeHierarchy",
          } as const;
          method = methods[request.kind];
          params = {
            textDocument: { uri: request.uri },
            position: request.position,
          };
          break;
        }
        case "workspace-symbols":
          if (request.query.length > 4_096 || request.query.includes("\0")) {
            return err({
              kind: "language-server",
              code: "invalid-request",
              reason: "invalid-symbol",
            });
          }
          method = "workspace/symbol";
          params = { query: request.query };
          break;
        case "call-hierarchy-incoming":
        case "call-hierarchy-outgoing":
        case "type-hierarchy-supertypes":
        case "type-hierarchy-subtypes": {
          const serialized = JSON.stringify(request.item);
          if (serialized.length > 64 * 1_024 || request.item === null) {
            return err({
              kind: "language-server",
              code: "invalid-request",
              reason: "result-too-large",
            });
          }
          const methods = {
            "call-hierarchy-incoming": "callHierarchy/incomingCalls",
            "call-hierarchy-outgoing": "callHierarchy/outgoingCalls",
            "type-hierarchy-supertypes": "typeHierarchy/supertypes",
            "type-hierarchy-subtypes": "typeHierarchy/subtypes",
          } as const;
          method = methods[request.kind];
          params = { item: request.item };
          break;
        }
      }
      return sendRequest(server, method, params, server.limits.requestTimeoutMs, signal);
    },

    diagnostics(serviceId, uri) {
      const server = servers.get(serviceId);
      if (server === undefined) {
        return null;
      }
      return server.diagnosticsByUri.get(uri) ?? null;
    },

    document(serviceId, uri) {
      const server = servers.get(serviceId);
      return server?.openDocuments.get(uri) ?? null;
    },

    async changeWorkspaceFolders(serviceId, generation, change) {
      const ready = requireReady(serviceId, generation);
      if (!ready.ok) {
        return ready;
      }
      const server = ready.value;
      const invalid = validateWorkspaceFoldersChange(change);
      if (invalid !== null) {
        return err({ kind: "language-server", code: "invalid-request", reason: invalid });
      }
      const merged = mergeWorkspaceFolders(server.workspaceFolders, change);
      if (!merged.ok) {
        if (merged.error.code === "invalid-request") {
          return err({
            kind: "language-server",
            code: "invalid-request",
            reason: merged.error.reason,
          });
        }
        return err({ kind: "language-server", code: merged.error.code });
      }
      const notified = await sendNotification(server, "workspace/didChangeWorkspaceFolders", {
        event: {
          added: change.added,
          removed: change.removed,
        },
      });
      if (!notified.ok) {
        return notified;
      }
      server.workspaceFolders = [...merged.value];
      emit(server, {
        kind: "workspace-folders-changed",
        folders: server.workspaceFolders,
      });
      return ok(snapshotOf(server));
    },

    snapshot(serviceId) {
      const server = servers.get(serviceId);
      return server === undefined ? null : snapshotOf(server);
    },

    attach(serviceId, listener) {
      const server = servers.get(serviceId);
      if (server === undefined) {
        return err({ kind: "language-server", code: "not-found" });
      }
      server.listeners.add(listener);
      let detached = false;
      return ok({
        detach: (): void => {
          if (detached) {
            return;
          }
          detached = true;
          server.listeners.delete(listener);
        },
      });
    },
  };
}

export { describeLanguageServerFailure };
