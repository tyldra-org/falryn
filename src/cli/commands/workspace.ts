/** Saved workspace layout command family. */

import {
  adoptForeignError,
  createWorkspaceLayoutStore,
  fromConfigurationIssue,
  fromUnknown,
  type WorkspaceLayoutStoreError,
} from "../../application/index.ts";
import { configurationHomeIssue } from "../../config/index.ts";
import { type FalrynError, MAX_WORKSPACE_LAYOUT_CATALOG } from "../../domain/index.ts";
import type { WorkspaceCommandArguments } from "../command-tree.ts";
import type { CommandResultOf, CommandTruncation } from "../result.ts";
import type { ServiceProvider } from "../services.ts";
import type { WorkspaceResolveError } from "../workspace-resolution.ts";
import { resultFor, WRITE_COMPLETED_EFFECT, workspaceResolveError } from "./shared.ts";

export type WorkspaceRootPayload = {
  readonly rootId: string;
  readonly name: string;
  readonly path: string;
};

export type WorkspaceSetPayload = {
  readonly roots: readonly WorkspaceRootPayload[];
  readonly source: "cwd" | "path" | "layout";
  readonly layoutName: string | null;
};

export type WorkspaceListPayload = {
  readonly layouts: readonly { readonly name: string; readonly rootCount: number }[];
  readonly omitted: number;
};

export type WorkspaceSavePayload = {
  readonly name: string;
  readonly roots: readonly WorkspaceRootPayload[];
};

function rootsFromSet(set: {
  readonly roots: readonly {
    readonly rootId: { readonly toString?: () => string } | string;
    readonly name: string;
    readonly path: string;
  }[];
}): readonly WorkspaceRootPayload[] {
  return set.roots.map((root) => ({
    rootId: String(root.rootId),
    name: root.name,
    path: String(root.path),
  }));
}

export async function runWorkspaceList(
  services: ServiceProvider,
  arguments_: Extract<WorkspaceCommandArguments, { action: "list" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"workspace.list", WorkspaceListPayload>> {
  try {
    const graph = services();
    const home = await graph.configurationHomeForRead(signal);
    if (home.kind === "cancelled") {
      return resultFor<"workspace.list", WorkspaceListPayload>("workspace.list", null, [], {
        kind: "cancelled",
        effect: "none",
      });
    }
    if (home.kind === "conflict" || home.kind === "unavailable") {
      return resultFor<"workspace.list", WorkspaceListPayload>("workspace.list", null, [
        fromConfigurationIssue(configurationHomeIssue(home), {
          operation: "list workspace layouts",
        }),
      ]);
    }
    const { fileSystem } = graph;
    const configurationRoot = home.root;
    const store = createWorkspaceLayoutStore(fileSystem, configurationRoot);
    const catalog = await store.list({
      limit: arguments_.limit,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!catalog.ok) {
      return workspaceListFailure(catalog.error);
    }
    const total = catalog.value.layouts.length + catalog.value.omitted;
    const truncation: CommandTruncation[] =
      catalog.value.omitted === 0
        ? []
        : [
            {
              of: "layouts",
              shown: catalog.value.layouts.length,
              total,
              expansion:
                arguments_.limit >= MAX_WORKSPACE_LAYOUT_CATALOG
                  ? null
                  : (catalog.value.expansion ??
                    `workspace list --limit ${MAX_WORKSPACE_LAYOUT_CATALOG}`),
            },
          ];
    return {
      ...resultFor("workspace.list", {
        layouts: catalog.value.layouts.map((entry) => ({
          name: String(entry.name),
          rootCount: entry.rootCount,
        })),
        omitted: catalog.value.omitted,
      }),
      truncation,
    };
  } catch (error) {
    return resultFor<"workspace.list", WorkspaceListPayload>("workspace.list", null, [
      fromUnknown(error, { operation: "list workspace layouts" }),
    ]);
  }
}

export async function runWorkspaceShow(
  services: ServiceProvider,
  signal?: AbortSignal,
): Promise<CommandResultOf<"workspace.show", WorkspaceSetPayload>> {
  try {
    const resolved = await services().ensureWorkspaceSet(signal);
    if (!resolved.ok) {
      return workspaceResolveFailure("workspace.show", resolved.error);
    }
    return resultFor("workspace.show", {
      roots: rootsFromSet(resolved.value.set),
      source: resolved.value.source,
      layoutName: resolved.value.layoutName,
    });
  } catch (error) {
    return resultFor<"workspace.show", WorkspaceSetPayload>("workspace.show", null, [
      fromUnknown(error, { operation: "show workspace set" }),
    ]);
  }
}

export async function runWorkspaceSave(
  services: ServiceProvider,
  arguments_: Extract<WorkspaceCommandArguments, { action: "save" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"workspace.save", WorkspaceSavePayload>> {
  try {
    const resolved = await services().ensureWorkspaceSet(signal);
    if (!resolved.ok) {
      return workspaceResolveFailure("workspace.save", resolved.error);
    }
    const graph = services();
    const home = await graph.configurationHomeForWrite(signal);
    if (home.kind === "cancelled") {
      return resultFor<"workspace.save", WorkspaceSavePayload>("workspace.save", null, [], {
        kind: "cancelled",
        effect: "none",
      });
    }
    if (home.kind === "conflict" || home.kind === "unavailable") {
      return resultFor<"workspace.save", WorkspaceSavePayload>("workspace.save", null, [
        fromConfigurationIssue(configurationHomeIssue(home), {
          operation: "save workspace layout",
        }),
      ]);
    }
    const { fileSystem } = graph;
    const configurationRoot = home.root;
    const store = createWorkspaceLayoutStore(fileSystem, configurationRoot);
    const saved = await store.save(arguments_.name, resolved.value.set, {
      force: arguments_.force,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!saved.ok) {
      return workspaceSaveFailure(saved.error);
    }
    return resultFor(
      "workspace.save",
      {
        name: String(saved.value.name),
        roots: rootsFromSet(resolved.value.set),
      },
      [],
      undefined,
      WRITE_COMPLETED_EFFECT,
    );
  } catch (error) {
    return resultFor<"workspace.save", WorkspaceSavePayload>("workspace.save", null, [
      fromUnknown(error, { operation: "save workspace layout" }),
    ]);
  }
}

export async function runWorkspaceLoad(
  services: ServiceProvider,
  arguments_: Extract<WorkspaceCommandArguments, { action: "load" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"workspace.load", WorkspaceSetPayload>> {
  try {
    const resolved = await services().replaceWorkspaceFromLayout(arguments_.name, signal);
    if (!resolved.ok) {
      return workspaceResolveFailure("workspace.load", resolved.error);
    }
    return resultFor("workspace.load", {
      roots: rootsFromSet(resolved.value.set),
      source: resolved.value.source,
      layoutName: resolved.value.layoutName,
    });
  } catch (error) {
    return resultFor<"workspace.load", WorkspaceSetPayload>("workspace.load", null, [
      fromUnknown(error, { operation: "load workspace layout" }),
    ]);
  }
}

function workspaceResolveFailure(
  command: "workspace.show",
  error: WorkspaceResolveError,
): CommandResultOf<"workspace.show", WorkspaceSetPayload>;
function workspaceResolveFailure(
  command: "workspace.load",
  error: WorkspaceResolveError,
): CommandResultOf<"workspace.load", WorkspaceSetPayload>;
function workspaceResolveFailure(
  command: "workspace.save",
  error: WorkspaceResolveError,
): CommandResultOf<"workspace.save", WorkspaceSavePayload>;
function workspaceResolveFailure(
  command: "workspace.show" | "workspace.load" | "workspace.save",
  error: WorkspaceResolveError,
):
  | CommandResultOf<"workspace.show", WorkspaceSetPayload>
  | CommandResultOf<"workspace.load", WorkspaceSetPayload>
  | CommandResultOf<"workspace.save", WorkspaceSavePayload> {
  return resultFor(command, null, [workspaceResolveError(error)]);
}

function workspaceListFailure(
  error: WorkspaceLayoutStoreError,
): CommandResultOf<"workspace.list", WorkspaceListPayload> {
  return resultFor<"workspace.list", WorkspaceListPayload>("workspace.list", null, [
    workspaceLayoutStoreError(error, "list workspace layouts"),
  ]);
}

function workspaceSaveFailure(
  error: WorkspaceLayoutStoreError,
): CommandResultOf<"workspace.save", WorkspaceSavePayload> {
  return resultFor<"workspace.save", WorkspaceSavePayload>("workspace.save", null, [
    workspaceLayoutStoreError(error, "save workspace layout"),
  ]);
}

function workspaceLayoutStoreError(
  error: WorkspaceLayoutStoreError,
  operation: string,
): FalrynError {
  return adoptForeignError(
    {
      code: `workspace.layout.${error.code}`,
      category: "workspace",
      message: describeWorkspaceLayoutStoreError(error),
    },
    { operation },
  );
}

function describeWorkspaceLayoutStoreError(error: WorkspaceLayoutStoreError): string {
  switch (error.code) {
    case "cancelled":
      return "Workspace layout work was cancelled.";
    case "invalid-name":
      return "Argument name must be a legal layout name (same rule as --profile).";
    case "document":
      return `Saved layout document refused (${error.error.code}).`;
    case "set":
      return `Workspace set refused (${error.error.code}).`;
    case "not-found":
      return "No saved layout matches that name.";
    case "exists":
      return "A saved layout with that name already exists; pass --force to overwrite.";
    case "unusable-roots":
      return `Saved layout has unusable roots: ${error.unusable
        .map((entry) => `${entry.reason}:${entry.path}`)
        .join(", ")}.`;
    case "malformed-file":
      return "Saved layout file is malformed.";
    case "filesystem":
      return `Filesystem refused the layout operation (${error.error.code}).`;
    case "invalid-limit":
      return "Argument limit is outside the allowed range.";
    case "path":
      return "A layout path could not be formed under the configuration root.";
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}
