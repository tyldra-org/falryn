/**
 * Product Git and worktree tools (#713).
 *
 * Registers trusted builtins that adapt {@link GitPort}. Mutating ops keep
 * mutation effect class for confirmation. Does not expose rebase/force/history
 * rewrite. Autocommit product route remains #703.
 */

import { z } from "zod";

import type {
  ConfigurationGeneration,
  GitPort,
  ToolCatalog,
  ToolInvocationOutcome,
  ToolRegistry,
  ToolRegistryEntry,
} from "../domain/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  type ToolManifestDocument,
} from "../domain/index.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "./tool-call-loop.ts";

export const PRODUCT_GIT_TOOLS_OWNER = "#713";

const openObject = z.record(z.string(), z.unknown()) as z.ZodType<
  Readonly<Record<string, unknown>>
>;

function document(
  name: string,
  title: string,
  description: string,
  effect: ToolManifestDocument["effect"],
): ToolManifestDocument {
  return {
    namespace: "workspace",
    name,
    version: 1,
    source: "builtin",
    title,
    description,
    effect,
    capabilityKind: "git",
    platforms: [],
    limits: defaultToolLimits({ defaultTimeoutMs: 60_000 }),
    concurrency: defaultConcurrencyContract({ maxPerWorkspace: 2 }),
    resultProjection: defaultProjectionContract(),
  };
}

function mustEntry(result: ReturnType<typeof createToolRegistryEntry>): ToolRegistryEntry {
  if (!result.ok) {
    throw new Error(`product git tool registration failed: ${result.error.code}`);
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

function errorCode(error: { readonly code: string }): string {
  return error.code;
}

export type ProductGitToolPorts = {
  readonly generation: ConfigurationGeneration;
  readonly git: GitPort;
  readonly gitExecutable: string;
  readonly startPath: string;
};

export type ProductGitTools = {
  readonly owner: typeof PRODUCT_GIT_TOOLS_OWNER;
  readonly registry: ToolRegistry;
  readonly catalog: ToolCatalog;
  readonly runner: ToolRunnerPort;
  readonly toolNames: readonly string[];
};

type Base = {
  readonly gitExecutable: string;
  readonly startPath: string;
  readonly signal: AbortSignal;
};

function baseFrom(ports: ProductGitToolPorts, signal: AbortSignal): Base {
  return {
    gitExecutable: ports.gitExecutable,
    startPath: ports.startPath,
    signal,
  };
}

/**
 * Compose builtin Git / worktree tools for one workspace.
 */
export function composeProductGitTools(ports: ProductGitToolPorts): ProductGitTools {
  const entries: ToolRegistryEntry[] = [
    mustEntry(
      createToolRegistryEntry(
        document(
          "git_discover",
          "Git discover",
          "Discover Git identity for the workspace",
          "observation",
        ),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("git_status", "Git status", "Read Git status", "observation"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(document("git_diff", "Git diff", "Read a Git diff", "observation"), {
        inputSchema: openObject,
        outputSchema: openObject,
      }),
    ),
    mustEntry(
      createToolRegistryEntry(document("git_log", "Git log", "Read Git history", "observation"), {
        inputSchema: openObject,
        outputSchema: openObject,
      }),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("git_blame", "Git blame", "Blame a workspace path", "observation"),
        {
          inputSchema: openObject,
          outputSchema: openObject,
        },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("git_list_worktrees", "List worktrees", "List Git worktrees", "observation"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("git_create_branch", "Create branch", "Create a Git branch", "mutation"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("git_switch_branch", "Switch branch", "Switch the current Git branch", "mutation"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("git_delete_branch", "Delete branch", "Delete a Git branch", "mutation"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("git_create_worktree", "Create worktree", "Add a Git worktree", "mutation"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("git_remove_worktree", "Remove worktree", "Remove a Git worktree", "mutation"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("git_stage", "Stage", "Stage paths into the index", "mutation"),
        {
          inputSchema: openObject,
          outputSchema: openObject,
        },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("git_unstage", "Unstage", "Unstage paths from the index", "mutation"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(document("git_commit", "Commit", "Create a Git commit", "mutation"), {
        inputSchema: openObject,
        outputSchema: openObject,
      }),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("git_sync", "Sync", "Fetch/pull/push sync for the current branch", "mutation"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
  ];

  const registryResult = createToolRegistry(ports.generation, entries);
  if (!registryResult.ok) {
    throw new Error(`product git tool registry failed: ${registryResult.error.code}`);
  }
  const registry = registryResult.value;
  const git = ports.git;

  const runner: ToolRunnerPort = {
    async execute(request: ToolRunnerRequest): Promise<ToolInvocationOutcome> {
      if (request.signal.aborted) {
        return { status: "cancelled", effect: "none" };
      }
      const base = baseFrom(ports, request.signal);
      const input = request.input;
      switch (request.toolName) {
        case "git_discover": {
          const result = await git.discover(base);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_status": {
          const result = await git.status({
            ...base,
            ...(typeof input.includeIgnored === "boolean"
              ? { includeIgnored: input.includeIgnored }
              : {}),
            ...(typeof input.maxEntries === "number" ? { maxEntries: input.maxEntries } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_diff": {
          const result = await git.diff({
            ...base,
            ...(typeof input.scope === "string" ? { scope: input.scope as never } : {}),
            ...(typeof input.path === "string" ? { path: input.path } : {}),
            ...(typeof input.maxBytes === "number" ? { maxBytes: input.maxBytes } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_log": {
          const result = await git.log({
            ...base,
            ...(typeof input.maxCount === "number" ? { maxCount: input.maxCount } : {}),
            ...(typeof input.path === "string" ? { path: input.path } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_blame": {
          if (typeof input.path !== "string") {
            return failed("malformed-input");
          }
          const result = await git.blame({
            ...base,
            path: input.path,
            ...(typeof input.revision === "string" ? { revision: input.revision } : {}),
            ...(typeof input.maxLines === "number" ? { maxLines: input.maxLines } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_list_worktrees": {
          const result = await git.listWorktrees(base);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_create_branch": {
          if (typeof input.name !== "string") {
            return failed("malformed-input");
          }
          const result = await git.createBranch({
            ...base,
            name: input.name,
            ...(typeof input.startPoint === "string" ? { startPoint: input.startPoint } : {}),
            ...(typeof input.expectedHead === "string" ? { expectedHead: input.expectedHead } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_switch_branch": {
          if (typeof input.name !== "string") {
            return failed("malformed-input");
          }
          const result = await git.switchBranch({
            ...base,
            name: input.name,
            ...(typeof input.expectedHead === "string" ? { expectedHead: input.expectedHead } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_delete_branch": {
          if (typeof input.name !== "string") {
            return failed("malformed-input");
          }
          const result = await git.deleteBranch({
            ...base,
            name: input.name,
            ...(typeof input.expectedHead === "string" ? { expectedHead: input.expectedHead } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_create_worktree": {
          if (typeof input.path !== "string") {
            return failed("malformed-input");
          }
          const result = await git.createWorktree({
            ...base,
            path: input.path,
            ...(typeof input.branch === "string" ? { branch: input.branch } : {}),
            ...(typeof input.startPoint === "string" ? { startPoint: input.startPoint } : {}),
            ...(typeof input.detached === "boolean" ? { detached: input.detached } : {}),
            ...(typeof input.expectedHead === "string" ? { expectedHead: input.expectedHead } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_remove_worktree": {
          if (typeof input.path !== "string") {
            return failed("malformed-input");
          }
          const result = await git.removeWorktree({
            ...base,
            path: input.path,
            ...(typeof input.expectedHead === "string" ? { expectedHead: input.expectedHead } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_stage": {
          const paths = input.paths;
          if (!Array.isArray(paths) || !paths.every((item) => typeof item === "string")) {
            return failed("malformed-input");
          }
          const result = await git.stage({
            ...base,
            paths: paths as readonly string[],
            ...(typeof input.expectedHead === "string" ? { expectedHead: input.expectedHead } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_unstage": {
          const paths = input.paths;
          if (!Array.isArray(paths) || !paths.every((item) => typeof item === "string")) {
            return failed("malformed-input");
          }
          const result = await git.unstage({
            ...base,
            paths: paths as readonly string[],
            ...(typeof input.expectedHead === "string" ? { expectedHead: input.expectedHead } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_commit": {
          if (typeof input.subject !== "string") {
            return failed("malformed-input");
          }
          const result = await git.commit({
            ...base,
            subject: input.subject,
            ...(typeof input.expectedHead === "string" ? { expectedHead: input.expectedHead } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "git_sync": {
          const result = await git.sync({
            ...base,
            ...(typeof input.expectedHead === "string" ? { expectedHead: input.expectedHead } : {}),
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        default:
          return {
            status: "unavailable",
            reason: `unknown product git tool: ${request.toolName}`,
            effect: "none",
          };
      }
    },
  };

  return {
    owner: PRODUCT_GIT_TOOLS_OWNER,
    registry,
    catalog: registry.catalog,
    runner,
    toolNames: entries.map((entry) => entry.descriptor.name),
  };
}
