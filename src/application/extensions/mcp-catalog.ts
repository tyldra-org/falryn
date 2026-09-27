/**
 * MCP catalog owner (#131).
 *
 * Discovery publishes one complete replacement per server. Staleness is derived
 * from the live transport, configuration and list-change revision, so a handle
 * from an older catalog generation can never select a same-named newer entry.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { contentDigest } from "../../domain/artifacts/index.ts";
import type { VirtualResourcePortError } from "../../domain/documents/index.ts";
import {
  MCP_DEADLINE_MS,
  type McpAdmission,
  type McpConfiguration,
  type McpListChanges,
  type McpMethod,
  type McpOutcome,
  type McpSnapshot,
} from "../../domain/extensions/mcp.ts";
import {
  expandUriTemplate,
  MCP_CATALOG_KINDS,
  MCP_CATALOG_URI_CHARACTERS,
  type McpCatalogCounts,
  type McpCatalogEntry,
  type McpCatalogKind,
  type McpCatalogLists,
  type McpServerFeature,
  normalizeMcpCatalog,
  parseUriTemplate,
  validateMcpArguments,
} from "../../domain/extensions/mcp-catalog.ts";
import { err, ok } from "../../domain/foundation/index.ts";
import type { ResourceResolverOptions } from "../documents/resource-resolver.ts";
import { resourceDigest } from "../documents/resource-retention.ts";
import type { McpLifecycle } from "./mcp-lifecycle.ts";

export const MCP_CATALOG_PAGE_ENTRIES = 100;
export const MCP_TEMPLATE_RESOLUTIONS = 256;
export const MCP_PROMPT_MESSAGES = 256;
export const MCP_TOOL_VALIDATORS = 256;
export const MCP_TOOL_CONTENT_ITEMS = 1024;
const PENDING_READS = 8;

export type McpCatalogState = "unknown" | "current" | "stale";
export type McpCatalogSummary = {
  readonly serverId: string;
  readonly state: McpCatalogState;
  readonly code: string | null;
  readonly catalogGeneration: number | null;
  /** Unobserved catalogs can change on the server without Falryn being told. */
  readonly listChanges: McpListChanges;
  readonly entries: Readonly<Record<McpCatalogKind, number>>;
  readonly counts: McpCatalogCounts;
};
export type McpCatalogListing = McpCatalogEntry & {
  readonly catalogGeneration: number;
  readonly availability: "available" | "stale" | "unsupported";
  /** Unified Read target for an available resource; null otherwise. */
  readonly readHandle: string | null;
  /** Pages are compact (tool schemas omitted); selecting one entryId returns it complete. */
  readonly detail: "compact" | "complete";
};
export type McpCatalogFailure = {
  readonly kind: Exclude<McpOutcome["kind"], "completed"> | "malformed" | "unsupported";
  readonly code: string;
  readonly effect: "none" | "uncertain";
};
export type McpCatalogResult<Value> =
  | { readonly kind: "completed"; readonly value: Value }
  | McpCatalogFailure;
export type McpPromptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "resource";
      readonly uri: string;
      readonly mimeType: string | null;
      readonly text: string;
    }
  | { readonly type: "unsupported"; readonly contentType: string };
export type McpPrompt = {
  readonly entryId: string;
  readonly catalogGeneration: number;
  readonly description: string | null;
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly content: readonly McpPromptPart[];
  }[];
};
/** One MCP tool invocation with its exact selected identity; content stays untrusted. */
export type McpToolResult = {
  readonly entryId: string;
  readonly catalogGeneration: number;
  readonly schemaDigest: string;
  /** The tool ran and reported a problem; the model may correct and call again. */
  readonly isError: boolean;
  readonly content: readonly unknown[];
  readonly structuredContent: unknown;
};
/** Per-call identity supplied by the invoking tool; the catalog adds server generations. */
export type McpCatalogCall = Pick<McpAdmission, "origin" | "requestId" | "deadline" | "signal">;

type Published = {
  readonly serverId: string;
  readonly catalogGeneration: number;
  readonly configurationGeneration: number;
  readonly transportGeneration: number;
  readonly catalogRevision: number;
  readonly discovered: boolean;
  readonly failure: string | null;
  readonly entries: readonly McpCatalogEntry[];
  readonly counts: McpCatalogCounts;
  readonly resolved: string[];
};
const EMPTY_COUNTS: McpCatalogCounts = { malformed: 0, duplicates: 0, omitted: 0 };
const LISTS: Readonly<
  Record<McpServerFeature, readonly (readonly [McpMethod, keyof McpCatalogLists])[]>
> = {
  tools: [["tools/list", "tools"]],
  resources: [
    ["resources/list", "resources"],
    ["resources/templates/list", "resourceTemplates"],
  ],
  prompts: [["prompts/list", "prompts"]],
};
const HANDLE = /^mcp:([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/resource\/([^?/]+)\?catalog=(\d+)$/u;
const MEDIA_TYPE = /^[!-~]+\/[!-~]+$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const encoder = new TextEncoder();

export function mcpReadHandle(serverId: string, uri: string, catalogGeneration: number): string {
  return (
    "mcp:" + serverId + "/resource/" + encodeURIComponent(uri) + "?catalog=" + catalogGeneration
  );
}
function parseHandle(handle: string) {
  const match = HANDLE.exec(handle);
  if (!match) return null;
  try {
    return {
      serverId: match[1] ?? "",
      uri: decodeURIComponent(match[2] ?? ""),
      catalogGeneration: Number(match[3]),
    };
  } catch {
    return null;
  }
}
function failure(
  kind: McpCatalogFailure["kind"],
  code: string,
  effect: "none" | "uncertain" = "none",
): McpCatalogFailure {
  return { kind, code, effect };
}
function fromOutcome(outcome: Exclude<McpOutcome, { kind: "completed" }>): McpCatalogFailure {
  return failure(outcome.kind, outcome.code, outcome.effect);
}
const readResultSchema = z.looseObject({
  contents: z
    .array(
      z.looseObject({
        uri: z.string(),
        mimeType: z.string().nullish(),
        text: z.string().optional(),
        blob: z.string().optional(),
      }),
    )
    .max(64),
});
const promptResultSchema = z.looseObject({
  description: z.string().nullish(),
  messages: z
    .array(z.looseObject({ role: z.enum(["user", "assistant"]), content: z.unknown() }))
    .max(MCP_PROMPT_MESSAGES),
});
const toolResultSchema = z.looseObject({
  content: z.array(z.unknown()).max(MCP_TOOL_CONTENT_ITEMS).default([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().nullish(),
});
function promptPart(content: unknown): McpPromptPart {
  const value = (content ?? {}) as Record<string, unknown>;
  const type = typeof value.type === "string" ? value.type : "unknown";
  if (type === "text" && typeof value.text === "string") return { type, text: value.text };
  const resource = (value.resource ?? {}) as Record<string, unknown>;
  if (type === "resource" && typeof resource.uri === "string" && typeof resource.text === "string")
    return {
      type,
      uri: resource.uri,
      mimeType: typeof resource.mimeType === "string" ? resource.mimeType : null,
      text: resource.text,
    };
  return { type: "unsupported", contentType: type.slice(0, 64) };
}

export type McpCatalogPorts = {
  readonly lifecycle: McpLifecycle;
  readonly configuration: () => McpConfiguration;
};

export function createMcpCatalog(ports: McpCatalogPorts) {
  const published = new Map<string, Published>();
  const latest = new Map<string, number>();
  const pendingReads = new Map<string, Uint8Array>();
  // Compiled argument validators are keyed by the normalized schema digest.
  const validators = new Map<string, z.ZodType>();
  let nextGeneration = 0;
  let publication = 0;
  let tickets = 0;

  const snapshotOf = (serverId: string): McpSnapshot | undefined =>
    ports.lifecycle.inspect().find((snapshot) => snapshot.serverId === serverId);
  const stateOf = (record: Published | undefined, snapshot: McpSnapshot | undefined) => {
    if (!record?.discovered) return { state: "unknown" as const, code: record?.failure ?? null };
    if (record.failure !== null) return { state: "stale" as const, code: record.failure };
    if (snapshot?.state !== "available")
      return { state: "stale" as const, code: "mcp-server-" + (snapshot?.state ?? "removed") };
    if (
      snapshot.transportGeneration !== record.transportGeneration ||
      snapshot.configurationGeneration !== record.configurationGeneration
    )
      return { state: "stale" as const, code: "mcp-catalog-generation-stale" };
    if (snapshot.catalogRevision !== record.catalogRevision)
      return { state: "stale" as const, code: "mcp-catalog-changed" };
    return { state: "current" as const, code: null };
  };
  const currentRecord = (serverId: string, catalogGeneration: number) => {
    const record = published.get(serverId);
    if (!record?.discovered || record.catalogGeneration !== catalogGeneration) return null;
    return stateOf(record, snapshotOf(serverId)).state === "current" ? record : null;
  };
  const publish = (record: Published) => {
    published.set(record.serverId, record);
    publication++;
  };
  const summary = (serverId: string): McpCatalogSummary => {
    const record = published.get(serverId);
    const snapshot = snapshotOf(serverId);
    const { state, code } = stateOf(record, snapshot);
    const entries = Object.fromEntries(MCP_CATALOG_KINDS.map((kind) => [kind, 0])) as Record<
      McpCatalogKind,
      number
    >;
    for (const entry of record?.discovered ? record.entries : []) entries[entry.kind]++;
    return {
      serverId,
      state,
      code,
      catalogGeneration: record?.discovered ? record.catalogGeneration : null,
      listChanges: snapshot?.listChanges ?? "unobserved",
      entries,
      counts: record?.discovered ? record.counts : EMPTY_COUNTS,
    };
  };
  const summaries = () => ports.lifecycle.inspect().map((snapshot) => summary(snapshot.serverId));
  /** Locate an entry only inside the exact catalog generation the caller selected. */
  const selected = (entryId: string, catalogGeneration: number, kind: McpCatalogKind) => {
    const serverId = /^mcp:([^/]+)\//u.exec(entryId)?.[1] ?? "";
    const record = currentRecord(serverId, catalogGeneration);
    if (!record) return failure("stale", "mcp-catalog-entry-stale");
    const entry = record.entries.find((candidate) => candidate.id === entryId);
    if (!entry) return failure("unavailable", "mcp-catalog-entry-unknown");
    if (entry.kind !== kind) return failure("malformed", "mcp-catalog-entry-kind-mismatch");
    return { record, entry };
  };
  const call = (record: Published, context: McpCatalogCall): McpAdmission => ({
    ...context,
    serverId: record.serverId,
    configurationGeneration: record.configurationGeneration,
  });
  const describeFailure = (outcome: McpCatalogFailure): VirtualResourcePortError => ({
    code:
      outcome.kind === "stale" || outcome.kind === "cancelled"
        ? outcome.kind
        : outcome.kind === "unavailable" || outcome.kind === "denied"
          ? "unavailable"
          : "failed",
  });
  const admittedRead = (handle: string) => {
    const parsed = parseHandle(handle);
    if (!parsed) return null;
    const record = currentRecord(parsed.serverId, parsed.catalogGeneration);
    if (!record) return { ...parsed, record: null, listed: false };
    const listed =
      record.entries.some((entry) => entry.kind === "resource" && entry.uri === parsed.uri) ||
      record.resolved.includes(parsed.uri);
    return { ...parsed, record, listed };
  };

  const resources: NonNullable<ResourceResolverOptions["virtual"]> = {
    async authorize(handle, scope) {
      const parsed = parseHandle(handle);
      if (!parsed) return err({ code: "mcp-resource-handle-malformed" });
      const server = ports.configuration().servers.find((entry) => entry.id === parsed.serverId);
      // Removal or disabling revokes both live reads and retained evidence.
      if (!server?.enabled) return err({ code: "mcp-server-revoked" });
      return ok({ sensitivity: "user-content" as const, generation: scope.generation });
    },
    reader: {
      async describe(handle, signal) {
        const admitted = admittedRead(handle);
        if (!admitted) return err({ code: "not-found" as const });
        if (!admitted.record) return err({ code: "stale" as const });
        if (!admitted.listed) return err({ code: "not-found" as const });
        const outcome = await ports.lifecycle.request(
          call(admitted.record, {
            origin: "model",
            requestId: randomUUID(),
            deadline: Date.now() + MCP_DEADLINE_MS,
            signal: signal ?? new AbortController().signal,
          }),
          admitted.record.transportGeneration,
          "resources/read",
          { uri: admitted.uri },
        );
        if (outcome.kind !== "completed") return err(describeFailure(fromOutcome(outcome)));
        if (!admittedRead(handle)?.record) return err({ code: "stale" as const });
        const parsed = readResultSchema.safeParse(outcome.value);
        if (!parsed.success) return err({ code: "failed" as const });
        const [item, ...rest] = parsed.data.contents;
        // One exact item is required; multi-part results have no single faithful byte form.
        if (!item || rest.length > 0) return err({ code: "unsupported" as const });
        if (item.uri !== admitted.uri) return err({ code: "failed" as const });
        let bytes: Uint8Array;
        if (item.text !== undefined) bytes = encoder.encode(item.text);
        else if (item.blob !== undefined && BASE64.test(item.blob))
          bytes = new Uint8Array(Buffer.from(item.blob, "base64"));
        else return err({ code: "unsupported" as const });
        const digest = contentDigest.parse(resourceDigest(bytes));
        if (!digest.ok) return err({ code: "failed" as const });
        if (pendingReads.size >= PENDING_READS && !pendingReads.has(handle))
          pendingReads.delete(pendingReads.keys().next().value ?? "");
        pendingReads.set(handle, bytes);
        const declared = item.mimeType ?? "";
        return ok({
          uri: handle,
          mediaType:
            declared.length >= 3 && declared.length <= 128 && MEDIA_TYPE.test(declared)
              ? declared
              : item.text !== undefined
                ? "text/plain"
                : "application/octet-stream",
          byteLength: bytes.length,
          digest: digest.value,
          freshness: "live" as const,
          retention: "retained" as const,
          exactBytes: true,
        });
      },
      async readRange(handle, offset, length) {
        const bytes = pendingReads.get(handle);
        if (!bytes) return err({ code: "unavailable" as const });
        if (offset + length >= bytes.length) pendingReads.delete(handle);
        return ok(bytes.slice(offset, offset + length));
      },
    },
  };

  return {
    resources,
    summaries,
    /** Refresh one connected server. Failure keeps the last snapshot as stale evidence. */
    async discover(
      serverId: string,
      context: McpCatalogCall,
    ): Promise<McpCatalogResult<McpCatalogSummary>> {
      const snapshot = snapshotOf(serverId);
      if (snapshot?.state !== "available") return failure("unavailable", "mcp-not-ready");
      const ticket = ++tickets;
      latest.set(serverId, ticket);
      const record: Published = {
        serverId,
        catalogGeneration: 0,
        configurationGeneration: snapshot.configurationGeneration,
        transportGeneration: snapshot.transportGeneration,
        catalogRevision: snapshot.catalogRevision,
        discovered: false,
        failure: null,
        entries: [],
        counts: EMPTY_COUNTS,
        resolved: [],
      };
      const results: Record<string, unknown> = {};
      for (const feature of snapshot.features)
        for (const [method, key] of LISTS[feature]) {
          const outcome = await ports.lifecycle.request(
            call(record, { ...context, requestId: context.requestId + ":" + method }),
            record.transportGeneration,
            method,
            {},
          );
          if (outcome.kind === "completed") {
            results[key] = outcome.value;
            continue;
          }
          if (latest.get(serverId) === ticket) {
            const previous = published.get(serverId);
            publish(
              previous
                ? { ...previous, failure: "mcp-catalog-refresh-" + outcome.code }
                : { ...record, failure: "mcp-catalog-refresh-" + outcome.code },
            );
          }
          return fromOutcome(outcome);
        }
      if (latest.get(serverId) !== ticket)
        return failure("stale", "mcp-catalog-refresh-superseded");
      const normalized = normalizeMcpCatalog(serverId, results);
      publish({
        ...record,
        catalogGeneration: ++nextGeneration,
        discovered: true,
        entries: normalized.entries,
        counts: normalized.counts,
      });
      return { kind: "completed", value: summary(serverId) };
    },

    /** Page retained entries. The cursor is bound to one catalog publication and filter. */
    page(query: {
      readonly serverId?: string | undefined;
      readonly kind?: McpCatalogKind | undefined;
      readonly entryId?: string | undefined;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    }): McpCatalogResult<{
      readonly catalogs: readonly McpCatalogSummary[];
      readonly entries: readonly McpCatalogListing[];
      readonly nextCursor: string | null;
    }> {
      const filter = [query.serverId ?? "", query.kind ?? "", query.entryId ?? ""].join("|");
      let offset = 0;
      if (query.cursor !== undefined) {
        const match = /^(\d+):(\d+):(.*)$/u.exec(query.cursor);
        if (!match || match[3] !== filter)
          return failure("malformed", "mcp-catalog-cursor-invalid");
        if (Number(match[1]) !== publication) return failure("stale", "mcp-catalog-cursor-stale");
        offset = Number(match[2]);
      }
      const limit = Math.min(
        MCP_CATALOG_PAGE_ENTRIES,
        Math.max(1, query.limit ?? MCP_CATALOG_PAGE_ENTRIES),
      );
      const catalogs = summaries().filter(
        (item) => query.serverId === undefined || item.serverId === query.serverId,
      );
      const listed: McpCatalogListing[] = [];
      for (const catalog of catalogs) {
        const record = published.get(catalog.serverId);
        if (!record?.discovered) continue;
        for (const entry of record.entries) {
          if (query.kind !== undefined && entry.kind !== query.kind) continue;
          if (query.entryId !== undefined && entry.id !== query.entryId) continue;
          const detail = query.entryId === undefined ? "compact" : "complete";
          const availability =
            catalog.state !== "current"
              ? "stale"
              : (entry.kind === "resource-template" && entry.arguments === null) ||
                  (entry.kind === "tool" && entry.schemaDigest === null)
                ? "unsupported"
                : "available";
          listed.push({
            ...entry,
            ...(entry.kind === "tool" && detail === "compact" ? { inputSchema: null } : {}),
            catalogGeneration: record.catalogGeneration,
            availability,
            detail,
            readHandle:
              entry.kind === "resource" && availability === "available"
                ? mcpReadHandle(entry.serverId, entry.uri, record.catalogGeneration)
                : null,
          });
        }
      }
      if (query.entryId !== undefined && listed.length === 0)
        return failure("unavailable", "mcp-catalog-entry-unknown");
      const entries = listed.slice(offset, offset + limit);
      return {
        kind: "completed",
        value: {
          catalogs,
          entries,
          nextCursor:
            offset + limit < listed.length
              ? publication + ":" + (offset + limit) + ":" + filter
              : null,
        },
      };
    },
    /** Validate template arguments and admit the expanded URI for unified Read. */
    resolveTemplate(
      entryId: string,
      catalogGeneration: number,
      values: Readonly<Record<string, string>>,
    ): McpCatalogResult<{
      readonly entryId: string;
      readonly uri: string;
      readonly readHandle: string;
    }> {
      const found = selected(entryId, catalogGeneration, "resource-template");
      if ("kind" in found) return found;
      const { record, entry } = found;
      if (entry.kind !== "resource-template")
        return failure("malformed", "mcp-catalog-entry-kind-mismatch");
      const template = parseUriTemplate(entry.uriTemplate);
      if (!template.ok || entry.arguments === null)
        return failure("unsupported", "mcp-template-unsupported");
      const invalid = validateMcpArguments(entry.arguments, values);
      if (invalid) return failure("malformed", invalid.code + ":" + invalid.name);
      const uri = expandUriTemplate(template.value, values);
      if (uri.length > MCP_CATALOG_URI_CHARACTERS || !/^[A-Za-z][A-Za-z0-9+.-]*:[!-~]*$/u.test(uri))
        return failure("malformed", "mcp-template-expansion-invalid");
      if (!record.resolved.includes(uri)) {
        if (record.resolved.length >= MCP_TEMPLATE_RESOLUTIONS) record.resolved.shift();
        record.resolved.push(uri);
      }
      return {
        kind: "completed",
        value: { entryId, uri, readHandle: mcpReadHandle(record.serverId, uri, catalogGeneration) },
      };
    },
    /** Fetch a prompt as context. The caller decides how to use it; no model turn starts here. */
    async getPrompt(
      entryId: string,
      catalogGeneration: number,
      values: Readonly<Record<string, string>>,
      context: McpCatalogCall,
    ): Promise<McpCatalogResult<McpPrompt>> {
      const found = selected(entryId, catalogGeneration, "prompt");
      if ("kind" in found) return found;
      const { record, entry } = found;
      if (entry.kind !== "prompt") return failure("malformed", "mcp-catalog-entry-kind-mismatch");
      const invalid = validateMcpArguments(entry.arguments, values);
      if (invalid) return failure("malformed", invalid.code + ":" + invalid.name);
      const outcome = await ports.lifecycle.request(
        call(record, context),
        record.transportGeneration,
        "prompts/get",
        { name: entry.name, arguments: values },
      );
      if (outcome.kind !== "completed") return fromOutcome(outcome);
      if (!currentRecord(record.serverId, catalogGeneration))
        return failure("stale", "mcp-catalog-changed-during-request");
      const parsed = promptResultSchema.safeParse(outcome.value);
      if (!parsed.success) return failure("failed", "mcp-prompt-malformed");
      return {
        kind: "completed",
        value: {
          entryId,
          catalogGeneration,
          description: parsed.data.description ?? null,
          messages: parsed.data.messages.map((message) => ({
            role: message.role,
            content: (Array.isArray(message.content) ? message.content : [message.content]).map(
              promptPart,
            ),
          })),
        },
      };
    },
    /**
     * Invoke one tool selected from an exact catalog generation. Arguments must satisfy its
     * normalized schema; the selection is revalidated immediately before the single dispatch.
     */
    async callTool(
      entryId: string,
      catalogGeneration: number,
      values: Readonly<Record<string, unknown>>,
      context: McpCatalogCall,
    ): Promise<McpCatalogResult<McpToolResult>> {
      const found = selected(entryId, catalogGeneration, "tool");
      if ("kind" in found) return found;
      const { record, entry } = found;
      if (entry.kind !== "tool") return failure("malformed", "mcp-catalog-entry-kind-mismatch");
      if (entry.inputSchema === null || entry.schemaDigest === null)
        return failure("unsupported", "mcp-tool-schema-unsupported");
      let validator = validators.get(entry.schemaDigest);
      if (!validator) {
        validator = z.fromJSONSchema(entry.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
        if (validators.size >= MCP_TOOL_VALIDATORS) validators.clear();
        validators.set(entry.schemaDigest, validator);
      }
      if (!validator.safeParse(values).success)
        return failure("malformed", "mcp-tool-arguments-invalid");
      if (!currentRecord(record.serverId, catalogGeneration))
        return failure("stale", "mcp-catalog-entry-stale");
      const outcome = await ports.lifecycle.request(
        call(record, context),
        record.transportGeneration,
        "tools/call",
        { name: entry.name, arguments: values },
      );
      if (outcome.kind !== "completed") return fromOutcome(outcome);
      // The call ran; a later catalog change cannot undo it, so the result is kept as returned.
      const parsed = toolResultSchema.safeParse(outcome.value);
      if (!parsed.success) return failure("failed", "mcp-tool-result-malformed", "uncertain");
      return {
        kind: "completed",
        value: {
          entryId,
          catalogGeneration,
          schemaDigest: entry.schemaDigest,
          isError: parsed.data.isError === true,
          content: parsed.data.content,
          structuredContent: parsed.data.structuredContent ?? null,
        },
      };
    },
  };
}
export type McpCatalog = ReturnType<typeof createMcpCatalog>;
