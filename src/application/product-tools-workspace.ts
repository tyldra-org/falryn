/**
 * Product workspace tools (#711): filesystem, reader, search, and patch.
 *
 * Registers trusted builtin descriptors and a {@link ToolRunnerPort} that
 * adapts existing workspace application ports — no parallel filesystem.
 * Shell/Git/LSP/DAP families remain #712–#714.
 */

import { z } from "zod";

import type {
  CommandRunnerPort,
  ConfigurationGeneration,
  FileSystemPort,
  LocalPath,
  ToolCatalog,
  ToolInvocationOutcome,
  ToolRegistry,
  ToolRegistryEntry,
} from "../domain/index.ts";
import {
  conflictKey,
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  type ToolManifestDocument,
} from "../domain/index.ts";
import { createCompactDocumentReader } from "./compact-document-read.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "./tool-call-loop.ts";
import { createWorkspaceDiscovery } from "./workspace-discovery.ts";
import { createWorkspaceListing } from "./workspace-listing.ts";
import { createWorkspaceMutator } from "./workspace-mutate.ts";
import { createWorkspacePatcher } from "./workspace-patch.ts";
import { createWorkspaceReader } from "./workspace-read.ts";
import { createWorkspaceTextSearch } from "./workspace-search.ts";
import { createWorkspaceWriter } from "./workspace-write.ts";

export const PRODUCT_WORKSPACE_TOOLS_OWNER = "#711";

const pathInput = z.object({ path: z.string().min(1) }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;

const openObject = z.record(z.string(), z.unknown()) as z.ZodType<
  Readonly<Record<string, unknown>>
>;

const writeFilesInput = z
  .object({
    targets: z.array(z.record(z.string(), z.unknown())).min(1),
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
    resultProjection: defaultProjectionContract(),
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
  readonly workspaceRoot: LocalPath;
};

export type ProductWorkspaceTools = {
  readonly owner: typeof PRODUCT_WORKSPACE_TOOLS_OWNER;
  readonly registry: ToolRegistry;
  readonly catalog: ToolCatalog;
  readonly runner: ToolRunnerPort;
  readonly toolNames: readonly string[];
};

/**
 * Compose builtin filesystem / reader / search / patch tools for one workspace.
 */
export function composeProductWorkspaceTools(
  ports: ProductWorkspaceToolPorts,
): ProductWorkspaceTools {
  const listing = createWorkspaceListing(ports.fileSystem);
  const reader = createWorkspaceReader(ports.fileSystem);
  const compact = createCompactDocumentReader(reader);
  const writer = createWorkspaceWriter({ fileSystem: ports.fileSystem });
  const mutator = createWorkspaceMutator({ fileSystem: ports.fileSystem });
  const discovery = createWorkspaceDiscovery(ports.fileSystem);
  const search = createWorkspaceTextSearch({
    fileSystem: ports.fileSystem,
    commands: ports.commands,
  });
  const patcher = createWorkspacePatcher({ fileSystem: ports.fileSystem });

  const entries: ToolRegistryEntry[] = [
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
          "Read a workspace file through the product reader",
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
          inputSchema: openObject,
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
          inputSchema: openObject,
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
          inputSchema: openObject,
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
          inputSchema: openObject,
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
          inputSchema: openObject,
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
    async execute(request: ToolRunnerRequest): Promise<ToolInvocationOutcome> {
      if (request.signal.aborted) {
        return { status: "cancelled", effect: "none" };
      }
      switch (request.toolName) {
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
          const path = request.input.path;
          if (typeof path !== "string") {
            return failed("malformed-input");
          }
          const result = await reader.read(root, path, undefined, undefined, request.signal);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
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
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "mutate_paths": {
          const result = await mutator.apply(root, request.input, request.signal);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "discover_files": {
          const result = await discovery.discover(root, request.input, request.signal);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "search_text": {
          const result = await search.search(root, request.input, request.signal);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "preview_patch": {
          const result = await patcher.preview(root, request.input, request.signal);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "apply_patch": {
          const result = await patcher.apply(root, request.input, request.signal);
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
  };
}
