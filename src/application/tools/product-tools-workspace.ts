/**
 * Product workspace tools (#711): filesystem, reader, search, and patch.
 *
 * Registers trusted builtin descriptors and a {@link ToolRunnerPort} that
 * adapts existing workspace application ports — no parallel filesystem.
 * Shell/Git/LSP/DAP families remain #712–#714.
 */

import { z } from "zod";

import type { ArtifactStorePort } from "../../domain/artifacts/index.ts";
import type { EvidenceCandidate } from "../../domain/context/index.ts";
import {
  resourceReadInputSchema,
  resourceSearchInputSchema,
} from "../../domain/documents/resource-read.ts";
import type {
  ConfigurationGeneration,
  SessionId,
  WorkspaceId,
} from "../../domain/foundation/index.ts";
import { conflictKey } from "../../domain/orchestration/index.ts";
import type { CommandRunnerPort } from "../../domain/process/index.ts";
import type {
  ToolCatalog,
  ToolInvocationOutcome,
  ToolRegistry,
  ToolRegistryEntry,
} from "../../domain/tools/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  type ToolManifestDocument,
} from "../../domain/tools/index.ts";
import {
  DEFAULT_SEARCH_FILE_BYTES,
  type FileSystemPort,
  HARD_MAX_DISCOVERY_MATCHES,
  HARD_MAX_MUTATION_DEPTH,
  HARD_MAX_MUTATION_ENTRIES,
  HARD_MAX_PATCH_HUNK_LINES,
  HARD_MAX_PATCH_HUNKS,
  HARD_MAX_PATCH_TARGETS,
  HARD_MAX_SEARCH_MATCHES,
  HARD_MAX_WALK_DEPTH,
  HARD_MAX_WALK_ENTRIES,
  HARD_MAX_WRITE_AGGREGATE_BYTES,
  HARD_MAX_WRITE_BYTES,
  HARD_MAX_WRITE_TARGETS,
  type LocalPath,
  MAX_GLOB_PATTERN_LENGTH,
  MAX_GLOB_PATTERNS,
  MAX_SEARCH_CONTEXT,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_WRITE_REVISION_LENGTH,
  OVERWRITE_POLICIES,
  WORKSPACE_DISCOVERY_KINDS,
  WORKSPACE_SEARCH_KINDS,
  type WorkspaceIndexPort,
  WRITE_NEWLINE_POLICIES,
  WRITE_OPERATIONS,
  WRITE_POLICIES,
} from "../../domain/workspace/index.ts";
import type { ScratchResourcePort } from "../artifacts/scratch-resources.ts";
import { createLoomPort, type LoomPort } from "../compression/loom.ts";
import { createCompactDocumentReader } from "../documents/compact-document-read.ts";
import {
  createResourceResolver,
  type ResourceResolver,
  type ResourceResolverOptions,
} from "../documents/resource-resolver.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import type { ProductReadOutputMode } from "../workspace/product-read.ts";
import { createProductReadCoordinator, productReadInputSchema } from "../workspace/product-read.ts";
import { searchResources } from "../workspace/resource-search.ts";
import { createWorkspaceDiscovery } from "../workspace/workspace-discovery.ts";
import { createWorkspaceListing } from "../workspace/workspace-listing.ts";
import { createWorkspaceMutator } from "../workspace/workspace-mutate.ts";
import { createWorkspacePatcher } from "../workspace/workspace-patch.ts";
import { createWorkspaceReader } from "../workspace/workspace-read.ts";
import { createWorkspaceTextSearch } from "../workspace/workspace-search.ts";
import { createWorkspaceWriter } from "../workspace/workspace-write.ts";

export const PRODUCT_WORKSPACE_TOOLS_OWNER = "#711";

const pathInput = z.object({ path: z.string().min(1) }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;

const openObject = z.record(z.string(), z.unknown()) as z.ZodType<
  Readonly<Record<string, unknown>>
>;

const workspacePath = z
  .string()
  .min(1)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: workspace paths reject NUL exactly as the domain parser does.
  .regex(/^[^\x00]+$/u);
const globPattern = z.string().min(1).max(MAX_GLOB_PATTERN_LENGTH);
const contentDigestInput = z.string().regex(/^sha-256:[0-9a-f]{64}$/u);
const boundedRevision = z
  .string()
  .min(1)
  .max(MAX_WRITE_REVISION_LENGTH)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: revisions reject NUL exactly as the domain parser does.
  .regex(/^[^\x00]+$/u);
const writePolicy = z.enum(WRITE_POLICIES);

const writeFilesInput = z
  .object({
    policy: writePolicy.optional(),
    maxFileBytes: z.int().min(1).max(HARD_MAX_WRITE_BYTES).optional(),
    maxAggregateBytes: z.int().min(1).max(HARD_MAX_WRITE_AGGREGATE_BYTES).optional(),
    maxTargets: z.int().min(1).max(HARD_MAX_WRITE_TARGETS).optional(),
    targets: z
      .array(
        z
          .object({
            kind: z.enum(WRITE_OPERATIONS),
            path: workspacePath,
            // biome-ignore lint/suspicious/noControlCharactersInRegex: write text rejects NUL exactly as the domain parser does.
            text: z.string().regex(/^[^\x00]*$/u),
            newline: z.enum(WRITE_NEWLINE_POLICIES).optional(),
            expectedDigest: contentDigestInput.optional(),
            expectedRevision: boundedRevision.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(HARD_MAX_WRITE_TARGETS),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

const mutationShared = {
  source: workspacePath,
  overwrite: z.enum(OVERWRITE_POLICIES).optional(),
  recursive: z.boolean().optional(),
  expectedPlanId: z
    .string()
    .regex(/^mutate-[0-9a-f]+-\d+$/u)
    .optional(),
  maxEntries: z.int().min(1).max(HARD_MAX_MUTATION_ENTRIES).optional(),
  maxDepth: z.int().min(1).max(HARD_MAX_MUTATION_DEPTH).optional(),
};

const mutatePathsInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["move", "copy", "trash"]),
      destination: workspacePath,
      ...mutationShared,
    })
    .strict(),
  z.object({ kind: z.literal("remove"), ...mutationShared }).strict(),
]) as z.ZodType<Readonly<Record<string, unknown>>>;

const discoverFilesInput = z
  .object({
    start: workspacePath.optional(),
    include: z.array(globPattern).min(1).max(MAX_GLOB_PATTERNS),
    exclude: z.array(globPattern).max(MAX_GLOB_PATTERNS).optional(),
    includeHidden: z.boolean().optional(),
    kinds: z.enum(WORKSPACE_DISCOVERY_KINDS).optional(),
    maxMatches: z.int().min(1).max(HARD_MAX_DISCOVERY_MATCHES).optional(),
    maxWalkEntries: z.int().min(1).max(HARD_MAX_WALK_ENTRIES).optional(),
    maxDepth: z.int().min(1).max(HARD_MAX_WALK_DEPTH).optional(),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

const searchTextInput = z
  .object({
    kind: z.enum(WORKSPACE_SEARCH_KINDS).optional(),
    query: z.string().min(1).max(MAX_SEARCH_QUERY_LENGTH),
    start: workspacePath.optional(),
    caseSensitive: z.boolean().optional(),
    includeHidden: z.boolean().optional(),
    includeBinary: z.boolean().optional(),
    include: z.array(globPattern).max(6).optional(),
    exclude: z.array(globPattern).max(6).optional(),
    maxMatches: z.int().min(1).max(HARD_MAX_SEARCH_MATCHES).optional(),
    maxWalkEntries: z.int().min(1).max(HARD_MAX_WALK_ENTRIES).optional(),
    maxDepth: z.int().min(1).max(HARD_MAX_WALK_DEPTH).optional(),
    context: z.int().min(0).max(MAX_SEARCH_CONTEXT).optional(),
    timeoutMs: z.int().min(1).max(60_000).optional(),
    maxFileBytes: z.int().min(1).max(DEFAULT_SEARCH_FILE_BYTES).optional(),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

// biome-ignore lint/suspicious/noControlCharactersInRegex: patch lines reject NUL exactly as the domain parser does.
const patchLine = z.string().regex(/^[^\n\r\x00]*$/u);
const patchHunkId = z
  .string()
  .min(1)
  .max(128)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: hunk identities reject NUL exactly as the domain parser does.
  .regex(/^[^\x00]+$/u);
const patchHunkIdentity = {
  id: patchHunkId.optional(),
  hunkId: patchHunkId.optional(),
  oldLines: z.array(patchLine).max(HARD_MAX_PATCH_HUNK_LINES),
  newLines: z.array(patchLine).max(HARD_MAX_PATCH_HUNK_LINES),
};
const patchHunk = z.union([
  z
    .object({
      ...patchHunkIdentity,
      oldStart: z.int().min(1),
      addressDigest: contentDigestInput.optional(),
    })
    .strict(),
  z
    .object({
      ...patchHunkIdentity,
      addressDigest: contentDigestInput,
    })
    .strict(),
]);
const patchPlanInput = z
  .object({
    policy: writePolicy.optional(),
    expectedPlanId: z
      .string()
      .regex(/^patch-[0-9a-f]+-\d+$/u)
      .optional(),
    expectedGitHead: boundedRevision.optional(),
    maxTargets: z.int().min(1).max(HARD_MAX_PATCH_TARGETS).optional(),
    maxHunks: z.int().min(1).max(HARD_MAX_PATCH_HUNKS).optional(),
    maxHunkLines: z.int().min(1).max(HARD_MAX_PATCH_HUNK_LINES).optional(),
    maxFileBytes: z.int().min(1).max(HARD_MAX_WRITE_BYTES).optional(),
    maxAggregateBytes: z.int().min(1).max(HARD_MAX_WRITE_AGGREGATE_BYTES).optional(),
    targets: z
      .array(
        z
          .object({
            path: workspacePath,
            hunks: z.array(patchHunk).min(1).max(HARD_MAX_PATCH_HUNKS),
            expectedDigest: contentDigestInput.optional(),
            expectedRevision: boundedRevision.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(HARD_MAX_PATCH_TARGETS),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

function pathConflictKeys(
  input: Readonly<Record<string, unknown>>,
): readonly ReturnType<typeof conflictKey>[] {
  const path = input.path;
  return typeof path === "string" && path.length > 0 ? [conflictKey("file", path)] : [];
}

function errorCode(error: { readonly code: string }): string {
  return error.code;
}

function document(
  name: string,
  title: string,
  description: string,
  effect: ToolManifestDocument["effect"],
  capabilityKind: ToolManifestDocument["capabilityKind"],
): ToolManifestDocument {
  return {
    namespace: "workspace",
    name,
    version: 1,
    source: "builtin",
    title,
    description,
    effect,
    capabilityKind,
    platforms: [],
    limits: defaultToolLimits(),
    concurrency: defaultConcurrencyContract({ maxPerWorkspace: 8 }),
    resultProjection: defaultProjectionContract(
      name === "read" || name === "search" ? { modelMaxBytes: 1024 * 1024 } : {},
    ),
  };
}

function mustEntry(result: ReturnType<typeof createToolRegistryEntry>): ToolRegistryEntry {
  if (!result.ok) {
    throw new Error(`product workspace tool registration failed: ${result.error.code}`);
  }
  return result.value;
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    return { ok: false, reason: "unserializable" };
  }
  const parsed: unknown = JSON.parse(encoded);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: parsed as unknown };
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function failed(code: string): ToolInvocationOutcome {
  return { status: "failed", reason: code, effect: "none" };
}

function completed(value: unknown): ToolInvocationOutcome {
  return { status: "completed", output: jsonRecord(value), effect: "completed" };
}

export type ProductWorkspaceToolPorts = {
  readonly generation: ConfigurationGeneration;
  readonly fileSystem: FileSystemPort;
  readonly commands: CommandRunnerPort;
  /** Qualified executable chosen by the host, never by model arguments. */
  readonly ripgrepExecutable?: LocalPath;
  readonly workspaceRoot: LocalPath;
  readonly artifacts?: ArtifactStorePort;
  readonly loom?: LoomPort;
  readonly workspaceId?: WorkspaceId;
  readonly sessionId?: SessionId;
  readonly index?: WorkspaceIndexPort;
  readonly scratch?: ScratchResourcePort;
  readonly virtualResources?: ResourceResolverOptions["virtual"];
  /** Session/user preference. `raw` is authoritative over a model request for Loom. */
  readonly userReadOutputMode?: () => ProductReadOutputMode;
};

export type ProductWorkspaceTools = {
  readonly owner: typeof PRODUCT_WORKSPACE_TOOLS_OWNER;
  readonly registry: ToolRegistry;
  readonly catalog: ToolCatalog;
  readonly runner: ToolRunnerPort;
  readonly toolNames: readonly string[];
  readonly resources: ResourceResolver | null;
  contextCandidates(): readonly EvidenceCandidate[];
  invalidateContext(): number;
};

/**
 * Compose builtin filesystem / reader / search / patch tools for one workspace.
 */
export function composeProductWorkspaceTools(
  ports: ProductWorkspaceToolPorts,
): ProductWorkspaceTools {
  const listing = createWorkspaceListing(ports.fileSystem);
  const reader = createWorkspaceReader(
    ports.fileSystem,
    ports.artifacts === undefined ? {} : { artifacts: ports.artifacts },
  );
  const loom =
    ports.loom ??
    (ports.artifacts === undefined ? null : createLoomPort({ artifacts: ports.artifacts }));
  const productRead = createProductReadCoordinator({
    reader,
    loom,
    workspaceRoot: ports.workspaceRoot,
    workspaceId: ports.workspaceId ?? null,
    sessionId: ports.sessionId ?? null,
    generation: ports.generation,
    index: ports.index ?? null,
    ...(ports.userReadOutputMode === undefined ? {} : { userOutputMode: ports.userReadOutputMode }),
  });
  const compact = createCompactDocumentReader(reader);
  const resources =
    ports.workspaceId === undefined || ports.sessionId === undefined
      ? null
      : createResourceResolver({
          reader,
          workspaceRoot: ports.workspaceRoot,
          workspaceId: ports.workspaceId,
          sessionId: ports.sessionId,
          generation: String(ports.generation),
          ...(ports.artifacts === undefined ? {} : { artifacts: ports.artifacts }),
          ...(ports.scratch === undefined ? {} : { scratch: ports.scratch }),
          ...(ports.virtualResources === undefined ? {} : { virtual: ports.virtualResources }),
          ...(loom === null ? {} : { loom }),
        });
  const writer = createWorkspaceWriter({ fileSystem: ports.fileSystem });
  const mutator = createWorkspaceMutator({ fileSystem: ports.fileSystem });
  const discovery = createWorkspaceDiscovery(ports.fileSystem);
  const search = createWorkspaceTextSearch({
    fileSystem: ports.fileSystem,
    commands: ports.commands,
  });
  const patcher = createWorkspacePatcher({ fileSystem: ports.fileSystem });

  const invalidateAfterMutation = (): void => {
    productRead.invalidate();
  };

  const entries: ToolRegistryEntry[] = [
    ...(resources === null
      ? []
      : [
          mustEntry(
            createToolRegistryEntry(
              document(
                "read",
                "Read resources",
                "Read exact retained evidence, workspace files, scratch revisions and admitted artifacts. Return bounded byte ranges, head/tail or structural outlines. Evidence references grant no write permission.",
                "observation",
                "filesystem",
              ),
              { inputSchema: resourceReadInputSchema, outputSchema: openObject },
            ),
          ),
          mustEntry(
            createToolRegistryEntry(
              document(
                "search",
                "Search resources",
                "Search literal text in workspace files, scratch revisions and admitted retained artifacts. Results carry exact source references and coverage; missing resource hosts stay unavailable.",
                "observation",
                "search",
              ),
              { inputSchema: resourceSearchInputSchema, outputSchema: openObject },
            ),
          ),
        ]),
    mustEntry(
      createToolRegistryEntry(
        document(
          "list_dir",
          "List directory",
          "List workspace directory entries",
          "observation",
          "filesystem",
        ),
        {
          inputSchema: pathInput,
          outputSchema: openObject,
          conflictKeysFor: pathConflictKeys,
        },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("stat_path", "Stat path", "Stat a workspace path", "observation", "filesystem"),
        {
          inputSchema: pathInput,
          outputSchema: openObject,
          conflictKeysFor: pathConflictKeys,
        },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "read_file",
          "Read file",
          "Read exact, ranged, multi-file, or Loom-recovery workspace content; Loom is the default for oversized reads and raw keeps the bounded exact result",
          "observation",
          "filesystem",
        ),
        {
          inputSchema: productReadInputSchema,
          outputSchema: openObject,
          conflictKeysFor: pathConflictKeys,
        },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "read_compact_document",
          "Read compact document",
          "Read a compact document projection through the product reader",
          "observation",
          "filesystem",
        ),
        {
          inputSchema: pathInput,
          outputSchema: openObject,
          conflictKeysFor: pathConflictKeys,
        },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "write_files",
          "Write files",
          "Create or replace workspace files",
          "mutation",
          "filesystem",
        ),
        {
          inputSchema: writeFilesInput,
          outputSchema: openObject,
        },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "mutate_paths",
          "Mutate paths",
          "Move, copy, trash, or remove workspace paths",
          "mutation",
          "filesystem",
        ),
        {
          inputSchema: mutatePathsInput,
          outputSchema: openObject,
        },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "discover_files",
          "Discover files",
          "Discover workspace paths by glob",
          "observation",
          "search",
        ),
        {
          inputSchema: discoverFilesInput,
          outputSchema: openObject,
        },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "search_text",
          "Search text",
          "Search workspace file contents",
          "observation",
          "search",
        ),
        {
          inputSchema: searchTextInput,
          outputSchema: openObject,
        },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "preview_patch",
          "Preview patch",
          "Preview preconditioned patch hunks",
          "observation",
          "filesystem",
        ),
        {
          inputSchema: patchPlanInput,
          outputSchema: openObject,
        },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "apply_patch",
          "Apply patch",
          "Apply preconditioned patch hunks",
          "mutation",
          "filesystem",
        ),
        {
          inputSchema: patchPlanInput,
          outputSchema: openObject,
        },
      ),
    ),
  ];

  const registryResult = createToolRegistry(ports.generation, entries);
  if (!registryResult.ok) {
    throw new Error(`product workspace tool registry failed: ${registryResult.error.code}`);
  }
  const registry = registryResult.value;
  const root = ports.workspaceRoot;

  const runner: ToolRunnerPort = {
    hasBinding: (id) => registry.resolveByCapabilityId(id) !== null,
    async execute(request: ToolRunnerRequest): Promise<ToolInvocationOutcome> {
      if (request.signal.aborted) {
        return { status: "cancelled", effect: "none" };
      }
      switch (request.toolName) {
        case "read":
        case "search": {
          if (resources === null) return failed("resource-scope-unavailable");
          const input: unknown = request.input;
          if (request.toolName === "search") {
            const parsed = resourceSearchInputSchema.safeParse(request.input);
            if (!parsed.success) return failed("malformed-input");
            const searched = await searchResources(
              parsed.data,
              { resources, search, discovery, root },
              request.signal,
            );
            return searched.ok ? completed(searched.value) : failed(searched.error.code);
          }
          const result = await resources.read(input, request.signal);
          return result.ok ? completed(result.value) : failed(result.error.code);
        }
        case "list_dir": {
          const path = request.input.path;
          if (typeof path !== "string") {
            return failed("malformed-input");
          }
          const result = await listing.list(root, path, undefined, request.signal);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "stat_path": {
          const path = request.input.path;
          if (typeof path !== "string") {
            return failed("malformed-input");
          }
          const result = await listing.stat(root, path, request.signal);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "read_file": {
          const result = await productRead.execute(request.input, request.signal);
          return result.ok ? completed(result.value) : failed(result.error);
        }
        case "read_compact_document": {
          const result = await compact.read(
            root,
            {
              ...request.input,
              mode: typeof request.input.mode === "string" ? request.input.mode : "outline",
            },
            request.signal,
          );
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "write_files": {
          const result = await writer.apply(root, request.input, request.signal);
          if (result.ok) {
            invalidateAfterMutation();
          }
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "mutate_paths": {
          const result = await mutator.apply(root, request.input, request.signal);
          if (result.ok) {
            invalidateAfterMutation();
          }
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "discover_files": {
          const result = await discovery.discover(root, request.input, request.signal);
          return result.ok
            ? completed({
                ...result.value,
                matches: result.value.matches.map((match) => ({
                  ...match,
                  freshness: "discovery",
                  readTarget: { kind: "workspace", path: match.logical, root: String(root) },
                })),
              })
            : failed(errorCode(result.error));
        }
        case "search_text": {
          const result = await search.search(
            root,
            { ...request.input, ripgrepExecutable: ports.ripgrepExecutable },
            request.signal,
          );
          return result.ok
            ? completed({
                ...result.value,
                matches: result.value.matches.map((match) => ({
                  ...match,
                  freshness: "discovery",
                  readTarget: { kind: "workspace", path: match.logical, root: String(root) },
                })),
              })
            : failed(errorCode(result.error));
        }
        case "preview_patch": {
          const result = await patcher.preview(root, request.input, request.signal);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "apply_patch": {
          const result = await patcher.apply(root, request.input, request.signal);
          if (result.ok) {
            invalidateAfterMutation();
          }
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        default:
          return {
            status: "unavailable",
            reason: `unknown product tool: ${request.toolName}`,
            effect: "none",
          };
      }
    },
  };

  return {
    owner: PRODUCT_WORKSPACE_TOOLS_OWNER,
    registry,
    catalog: registry.catalog,
    runner,
    toolNames: entries.map((entry) => entry.descriptor.name),
    resources,
    contextCandidates: productRead.candidates,
    invalidateContext: productRead.invalidate,
  };
}
