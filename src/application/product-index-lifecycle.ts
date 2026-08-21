/**
 * Product index build / refresh lifecycle (#716).
 *
 * Inventories admitted text sources under a workspace root, rebuilds through
 * {@link createWorkspaceIndexBuilder}, and exposes freshness for product
 * consumers. Corrupt or unavailable rebuilds fail closed. Live embedding
 * vendors and mandatory vector DBs remain out of scope.
 */

import {
  err,
  type FileSystemPort,
  type LocalPath,
  ok,
  type Result,
  type WorkspaceIndexBuildError,
  type WorkspaceIndexBuildReport,
  type WorkspaceIndexBuildSource,
  type WorkspaceIndexWritePort,
} from "../domain/index.ts";
import { createWorkspaceDiscovery } from "./workspace-discovery.ts";
import { createWorkspaceIndexBuilder } from "./workspace-index-build.ts";
import { createWorkspaceReader } from "./workspace-read.ts";

export const PRODUCT_INDEX_LIFECYCLE_OWNER = "#716";

export type ProductIndexLifecycleStatus = {
  readonly owner: typeof PRODUCT_INDEX_LIFECYCLE_OWNER;
  readonly generationId: string | null;
  readonly recordCount: number;
  readonly builtAtMs: number | null;
  readonly freshness: "absent" | "ready" | "stale" | "failed";
  readonly lastError: string | null;
};

export type ProductIndexLifecycle = {
  readonly owner: typeof PRODUCT_INDEX_LIFECYCLE_OWNER;
  status(): ProductIndexLifecycleStatus;
  rebuild(
    signal?: AbortSignal,
  ): Promise<Result<WorkspaceIndexBuildReport, WorkspaceIndexBuildError>>;
  refresh(
    signal?: AbortSignal,
  ): Promise<Result<WorkspaceIndexBuildReport, WorkspaceIndexBuildError>>;
};

export type ProductIndexLifecyclePorts = {
  readonly fileSystem: FileSystemPort;
  readonly workspaceRoot: LocalPath;
  readonly index: WorkspaceIndexWritePort;
};

type MutableStatus = {
  generationId: string | null;
  recordCount: number;
  builtAtMs: number | null;
  freshness: ProductIndexLifecycleStatus["freshness"];
  lastError: string | null;
};

/**
 * Compose product index lifecycle for one workspace.
 */
export function composeProductIndexLifecycle(
  ports: ProductIndexLifecyclePorts,
): ProductIndexLifecycle {
  const discovery = createWorkspaceDiscovery(ports.fileSystem);
  const reader = createWorkspaceReader(ports.fileSystem);
  const builder = createWorkspaceIndexBuilder({ index: ports.index });
  const state: MutableStatus = {
    generationId: null,
    recordCount: 0,
    builtAtMs: null,
    freshness: "absent",
    lastError: null,
  };

  const inventory = async (
    signal?: AbortSignal,
  ): Promise<Result<readonly WorkspaceIndexBuildSource[], WorkspaceIndexBuildError>> => {
    const discovered = await discovery.discover(
      ports.workspaceRoot,
      {
        include: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.md", "**/*.json"],
        maxMatches: 2_000,
      },
      signal,
    );
    if (!discovered.ok) {
      return err({ code: "persist-failed", reason: `inventory:${discovered.error.code}` });
    }
    const sources: WorkspaceIndexBuildSource[] = [];
    for (const entry of discovered.value.matches) {
      if (entry.kind !== "file") {
        continue;
      }
      const read = await reader.read(
        ports.workspaceRoot,
        entry.logical,
        undefined,
        undefined,
        signal,
      );
      if (!read.ok) {
        if (read.error.code === "cancelled") {
          return err({ code: "build-cancelled" });
        }
        continue;
      }
      const text = read.value.lines.map((line) => line.text).join("\n");
      if (text.includes("\0")) {
        continue;
      }
      sources.push({
        logical: entry.logical,
        revision: String(read.value.digest),
        text,
      });
    }
    if (sources.length === 0) {
      return err({ code: "persist-failed", reason: "empty-inventory" });
    }
    return ok(sources);
  };

  const rebuildInner = async (
    signal?: AbortSignal,
  ): Promise<Result<WorkspaceIndexBuildReport, WorkspaceIndexBuildError>> => {
    const sources = await inventory(signal);
    if (!sources.ok) {
      state.freshness = "failed";
      state.lastError =
        sources.error.code === "persist-failed" ? sources.error.reason : sources.error.code;
      return sources;
    }
    const rebuilt = await builder.rebuildFromSources(sources.value, { signal });
    if (!rebuilt.ok) {
      state.freshness = "failed";
      state.lastError = rebuilt.error.code;
      return rebuilt;
    }
    state.generationId = rebuilt.value.generation.id;
    state.recordCount = rebuilt.value.recordCount;
    state.builtAtMs = Date.now();
    state.freshness = "ready";
    state.lastError = null;
    return rebuilt;
  };

  return {
    owner: PRODUCT_INDEX_LIFECYCLE_OWNER,
    status() {
      return {
        owner: PRODUCT_INDEX_LIFECYCLE_OWNER,
        generationId: state.generationId,
        recordCount: state.recordCount,
        builtAtMs: state.builtAtMs,
        freshness: state.freshness,
        lastError: state.lastError,
      };
    },
    rebuild: rebuildInner,
    refresh: rebuildInner,
  };
}
