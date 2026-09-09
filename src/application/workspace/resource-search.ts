/** Preserve native query facts while resolving search hits through the shared Read owner. */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { resourceSearchInputSchema } from "../../domain/documents/resource-read.ts";
import type { LocalPath } from "../../domain/workspace/index.ts";
import type { ResourceResolver } from "../documents/resource-resolver.ts";
import type { WorkspaceDiscovery } from "./workspace-discovery.ts";
import type { WorkspaceTextSearch } from "./workspace-search.ts";

export async function searchResources(
  input: z.infer<typeof resourceSearchInputSchema>,
  owners: {
    resources: ResourceResolver;
    discovery: WorkspaceDiscovery;
    search: WorkspaceTextSearch;
    root: LocalPath;
  },
  signal: AbortSignal,
) {
  if ("resources" in input)
    return owners.resources.read(
      {
        resources: input.resources,
        maxBytes: input.maxBytes,
        projection: { kind: "search", query: input.query, maxHits: input.maxHits },
      },
      signal,
    );
  const generation = `search-${randomUUID()}`;
  const projection = {
    reducerId: null,
    reducerVersion: null,
    reason: "unqualified-structured-format",
    exactRecovery: "read-target",
    generation,
  };
  if (input.mode === "paths") {
    const result = await owners.discovery.discover(
      owners.root,
      { start: input.path, include: [input.query], maxMatches: input.maxHits, kinds: "file" },
      signal,
    );
    if (!result.ok) return result;
    return {
      ok: true as const,
      value: {
        ...result.value,
        mode: input.mode,
        generation,
        projection,
        matches: result.value.matches.map((match) => ({
          ...match,
          freshness: "discovery",
          readTarget: { kind: "workspace", path: match.logical, root: String(owners.root) },
        })),
      },
    };
  }
  const result = await owners.search.search(
    owners.root,
    { start: input.path, query: input.query, kind: input.mode, maxMatches: input.maxHits },
    signal,
  );
  if (!result.ok) return result;
  let remaining = input.maxBytes;
  const matches = [];
  for (const match of result.value.matches) {
    const target = { kind: "workspace" as const, path: match.logical, root: String(owners.root) };
    const read =
      remaining <= 0
        ? null
        : await owners.resources.read(
            {
              resources: [target],
              projection: { kind: "lines", start: match.line, end: match.line },
              maxBytes: remaining,
            },
            signal,
          );
    const item = read?.ok ? read.value.items[0] : null;
    if (read?.ok) remaining -= read.value.aggregateBytes;
    const exact =
      item?.status === "read" &&
      item.segments.some(
        (segment) => segment.text.replace(/(?:\r\n|\r|\n)$/u, "") === match.text,
      ) &&
      !item.omissions.includes("output-limit");
    matches.push({
      ...match,
      freshness: exact ? "verified" : "discovery",
      readTarget: exact ? item.reference : target,
      evidence: item,
      exactMatchEvidence: exact,
    });
  }
  return {
    ok: true as const,
    value: {
      ...result.value,
      matches,
      mode: input.mode,
      generation,
      projection,
      knownMatchCount: result.value.matches.length,
      countLowerBound: result.value.truncated,
      projectionBytes: input.maxBytes - remaining,
    },
  };
}
