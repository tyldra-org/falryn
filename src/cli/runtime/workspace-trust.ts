import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { markdownMetadata } from "../../application/extensions/portable-components.ts";
import {
  createWorkspaceTrust,
  type WorkspaceTrust,
} from "../../application/workspace/workspace-trust.ts";
import { createWorkspaceInventory } from "../../application/workspace/workspace-trust-inventory.ts";
import { discoverSources, MAX_CONFIGURATION_FILE_BYTES, parseJsonc } from "../../config/index.ts";
import {
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  rootChild,
  sqliteDatabasePath,
} from "../../data/index.ts";
import {
  createWorkspaceTrustRepository,
  readWorkspaceTrustDecision,
} from "../../data/security/workspace-trust-repository.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  eventId,
  FIRST_CONFIGURATION_GENERATION,
  FIRST_SEQUENCE,
  idempotencyKey,
  RUNTIME_EVENT_SCHEMA_VERSION,
  sessionId,
  streamId,
  timestampFromEpochMilliseconds,
  traceId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { err, ok, type Result } from "../../domain/foundation/result.ts";
import {
  WORKSPACE_LOADER_FAMILIES,
  type WorkspaceTrustReport,
  type WorkspaceTrustStore,
} from "../../domain/security/workspace-trust.ts";
import type { RuntimeEvent } from "../../domain/sessions/index.ts";
import { isCleanClose, isRootUsable } from "../../domain/storage/index.ts";
import { joinPath } from "../../domain/workspace/index.ts";
import { openBunSqlite } from "../../integrations/index.ts";
import { openSessionStore } from "../commands/storage.ts";
import { configurationOverridesFor, type GlobalOptions } from "../options.ts";
import type { Services } from "./services.ts";

/** Diagnostics query existing tables directly and never run migrations or create a database. */
export async function inspectWorkspaceTrust(
  graph: Services,
  globals: GlobalOptions,
): Promise<WorkspaceTrustReport> {
  const store: WorkspaceTrustStore = {
    async get(key) {
      const state = rootChild(graph.localData.layout, "state");
      const path = state === null ? null : sqliteDatabasePath(state);
      if (path === null) return err({ code: "unavailable" });
      const exists = await graph.fileSystem.stat(path);
      if (!exists.ok) return err({ code: "unavailable" });
      if (exists.value === null) return ok(null);
      const opened = openBunSqlite({ path, create: false });
      if (!opened.ok) return err({ code: "unavailable" });
      let result: ReturnType<typeof readWorkspaceTrustDecision>;
      try {
        result = readWorkspaceTrustDecision(
          { read: (sql, bindings) => ok(opened.value.all(sql, bindings)) },
          key,
        );
      } catch {
        result = err({ code: "unavailable" });
      }
      const closed = await opened.value.close();
      return closed.ok ? result : err({ code: "unavailable" });
    },
    replace: () => err({ code: "unavailable" }),
  };
  return composeWorkspaceTrust(graph, globals, store).resolve();
}

export function workspaceTrustEvent(report: WorkspaceTrustReport, now: number): RuntimeEvent {
  const id = `workspace-trust-${randomUUID()}`;
  return {
    eventId: eventId.from(id),
    streamId: streamId.from(id),
    sequence: FIRST_SEQUENCE,
    kind: "workspace.trust.reviewed",
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    occurredAt: timestampFromEpochMilliseconds(now),
    idempotencyKey: idempotencyKey.from(id),
    correlation: {
      workspaceId: workspaceId.from(report.inventory?.identity ?? "workspace-unavailable"),
      sessionId: sessionId.from(id),
      traceId: traceId.from(id),
      configurationGeneration: FIRST_CONFIGURATION_GENERATION,
    },
    payload: {
      ...report,
      inventory:
        report.inventory === null
          ? null
          : {
              version: report.inventory.version,
              identity: report.inventory.identity,
              generation: report.inventory.generation,
              policy: report.inventory.policy,
              configuration: report.inventory.configuration,
              families: WORKSPACE_LOADER_FAMILIES.map((family) => ({
                family,
                count:
                  report.inventory?.loaders.filter((loader) => loader.family === family).length ??
                  0,
              })),
            },
    },
  };
}

/** Short database sessions keep the existing product database as the durable authority. */
function durableStore(graph: Services): WorkspaceTrustStore {
  async function access<T>(
    write: boolean,
    action: (
      store: WorkspaceTrustStore,
    ) => Result<T, { readonly code: string }> | Promise<Result<T, { readonly code: string }>>,
    signal?: AbortSignal,
  ): Promise<Result<T, { readonly code: string }>> {
    let opened = await openSessionStore(() => graph, signal);
    if (!opened.ok) return err({ code: "unavailable" });
    if (opened.kind === "absent" && !write)
      return action({ get: () => ok(null), replace: () => err({ code: "unavailable" }) });
    if (opened.kind === "absent") {
      const roots = await graph.localData.prepareRoots(["state"], signal);
      const state = rootChild(graph.localData.layout, "state");
      const path = state === null ? null : sqliteDatabasePath(state);
      if (!roots.every(isRootUsable) || state === null || path === null)
        return err({ code: "unavailable" });
      const created = await openSqliteStore(
        {
          open: openBunSqlite,
          clock: graph.clock,
          databasePath: path,
          backupDirectory: state,
          migrations: PRODUCTION_MIGRATIONS,
          create: true,
        },
        signal,
      );
      if (!created.ok) return err({ code: "unavailable" });
      opened = { ok: true, kind: "open", store: created.value };
    }
    let result: Result<T, { readonly code: string }>;
    try {
      result = await action(createWorkspaceTrustRepository(opened.store));
    } catch {
      result = err({ code: write ? "uncertain" : "unavailable" });
    }
    if (!isCleanClose(await opened.store.close()))
      return err({ code: write ? "uncertain" : "unavailable" });
    return result;
  }
  return {
    get: (key) => access(false, (store) => store.get(key)),
    replace: (key, revision, decision, signal) =>
      access(true, (store) => store.replace(key, revision, decision, signal), signal),
  };
}

export function composeWorkspaceTrust(
  graph: Services,
  globals: GlobalOptions,
  store?: WorkspaceTrustStore,
): WorkspaceTrust {
  const actor = canonicalDigest({
    kind: "local-user",
    uid: userInfo().uid,
    username: userInfo().username,
  });
  return createWorkspaceTrust({
    actor,
    now: () => Number(graph.clock.now()),
    store: store ?? durableStore(graph),
    inventory: {
      async inspect(signal) {
        const workspace = await graph.ensureWorkspaceSet(signal);
        if (!workspace.ok) return err({ code: "workspace-unavailable" });
        const home = await graph.configurationHomeForRead(signal);
        if (home.kind !== "current" && home.kind !== "legacy" && home.kind !== "empty")
          return err({ code: "configuration-unavailable" });
        const sources = discoverSources({
          configurationRoot: home.root,
          workspaceRoot: null,
          profile: globals.profile,
        });
        if (sources.issues.length > 0) return err({ code: "configuration-unavailable" });
        const configuration: string[] = [];
        for (const source of sources.sources) {
          const read = await graph.fileSystem.readText(
            source.file,
            MAX_CONFIGURATION_FILE_BYTES,
            signal,
          );
          if (!read.ok && read.error.code !== "not-found")
            return err({ code: "configuration-unavailable" });
          configuration.push(
            canonicalDigest({ source: source.source, text: read.ok ? read.value : null }),
          );
        }
        const userFile = joinPath(home.root, "falryn.jsonc");
        return createWorkspaceInventory({
          fileSystem: graph.fileSystem,
          roots: workspace.value.set.roots.map((root) => root.path),
          configuration: canonicalDigest({
            profile: globals.profile,
            overrides: configurationOverridesFor(globals),
            sources: configuration,
          }),
          ...(userFile.ok ? { userConfiguration: userFile.value } : {}),
          now: () => Number(graph.clock.now()),
          validate(family, text, path) {
            if (family === "settings") {
              if (text.trim() === "") return true;
              const parsed = parseJsonc(text);
              return (
                parsed.ok &&
                (parsed.value === undefined ||
                  graph.registry.validateLayer(parsed.value, {
                    scope: "project",
                    sourceKind: "project-file",
                  }).ok)
              );
            }
            if (path.endsWith(".json") || path.endsWith(".jsonc")) {
              const parsed = parseJsonc(text);
              return (
                parsed.ok &&
                parsed.value !== null &&
                typeof parsed.value === "object" &&
                !Array.isArray(parsed.value)
              );
            }
            if (family === "skills" && path.endsWith("/SKILL.md")) {
              try {
                const metadata = markdownMetadata(new TextEncoder().encode(text), true);
                return (
                  typeof metadata.name === "string" && typeof metadata.description === "string"
                );
              } catch {
                return false;
              }
            }
            return true;
          },
        }).inspect(signal);
      },
    },
  });
}
