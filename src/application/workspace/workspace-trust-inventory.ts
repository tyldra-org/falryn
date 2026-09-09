import { bytesDigest, canonicalDigest } from "../../domain/extensions/canonical.ts";
import { err, ok, type Result } from "../../domain/foundation/result.ts";
import { NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import {
  WORKSPACE_TRUST_POLICY,
  type WorkspaceInventory,
} from "../../domain/security/workspace-trust.ts";
import {
  type FileSystemPort,
  isInside,
  joinPath,
  type LocalPath,
} from "../../domain/workspace/index.ts";
import { redactProjectionText } from "../diagnostics/redaction.ts";
import {
  type ProductResources,
  processProductResources,
} from "../orchestration/product-resources.ts";

export const WORKSPACE_INVENTORY_LIMITS = {
  files: 1_024,
  entries: 4_096,
  bytes: 16 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  depth: 16,
  milliseconds: 30_000,
} as const;
export type WorkspaceInventorySnapshot = {
  readonly report: WorkspaceInventory;
  readonly projectText: string | null;
};
export type WorkspaceInventoryPort = {
  inspect(
    signal?: AbortSignal,
  ): Promise<Result<WorkspaceInventorySnapshot, { readonly code: string }>>;
};

/** Only known loader locations are scanned. Never traverse the workspace or follow declaration references. */
export function createWorkspaceInventory(options: {
  readonly fileSystem: FileSystemPort;
  readonly roots: readonly LocalPath[];
  readonly configuration: string;
  readonly userConfiguration?: LocalPath;
  readonly resources?: ProductResources;
  readonly now: () => number;
  readonly validate: (
    family: WorkspaceInventory["loaders"][number]["family"],
    text: string,
    path: string,
  ) => boolean;
}): WorkspaceInventoryPort {
  const inventory: WorkspaceInventoryPort = {
    inspect,
  };
  return {
    async inspect(signal) {
      const task = (options.resources ?? processProductResources).openTask(options.configuration, {
        operations: 1,
        wallTimeMs: WORKSPACE_INVENTORY_LIMITS.milliseconds,
        bufferedBytes: WORKSPACE_INVENTORY_LIMITS.bytes + 2 * WORKSPACE_INVENTORY_LIMITS.fileBytes,
      });
      try {
        const executed = await task.execute({
          operation: "workspace-trust-inventory",
          attempt: task.id,
          generation: options.configuration,
          inputBytes: 0,
          amounts: {
            operations: 1,
            bufferedBytes:
              WORKSPACE_INVENTORY_LIMITS.bytes + 2 * WORKSPACE_INVENTORY_LIMITS.fileBytes,
          },
          signal: signal ?? new AbortController().signal,
          unit: {
            id: workUnitId(task.id),
            effect: "observation",
            priority: "interactive",
            conflictKeys: [],
            dependencies: [],
            deadline: null,
            expectedOutputBytes: WORKSPACE_INVENTORY_LIMITS.fileBytes,
            retry: NO_RETRY,
            scopeId: null,
          },
          run: async (signal) => ({ value: await inventory.inspect(signal), terminated: true }),
        });
        return executed.kind === "completed"
          ? executed.value
          : err({ code: signal?.aborted ? "cancelled" : "inventory-admission-refused" });
      } finally {
        task.close();
      }
    },
  };
  async function inspect(signal?: AbortSignal): ReturnType<WorkspaceInventoryPort["inspect"]> {
    const stop = AbortSignal.any([
      ...(signal === undefined ? [] : [signal]),
      AbortSignal.timeout(WORKSPACE_INVENTORY_LIMITS.milliseconds),
    ]);
    const deadline = options.now() + WORKSPACE_INVENTORY_LIMITS.milliseconds;
    const fs = options.fileSystem;
    const loaders: WorkspaceInventory["loaders"] = [];
    const identities: string[] = [];
    let entries = 0;
    let bytes = 0;
    let projectText: string | null = null;
    const check = () => {
      if (signal?.aborted) throw new Error("cancelled");
      if (stop.aborted || options.now() >= deadline) throw new Error("inventory-timeout");
      if (++entries > WORKSPACE_INVENTORY_LIMITS.entries) throw new Error("inventory-entry-limit");
    };
    try {
      for (const [rootIndex, root] of options.roots.entries()) {
        check();
        const canonical = await fs.realPath(root, stop);
        if (!canonical.ok) throw new Error("workspace-unavailable");
        const canonicalRoot = canonical.value;
        identities.push(canonicalDigest({ root: canonicalRoot }));
        async function visit(
          relative: string,
          family: WorkspaceInventory["loaders"][number]["family"],
          depth = 0,
          expectedKind?: "file" | "directory",
        ): Promise<void> {
          check();
          if (depth > WORKSPACE_INVENTORY_LIMITS.depth) throw new Error("inventory-depth-limit");
          const path = joinPath(canonicalRoot, ...relative.split("/"));
          if (!path.ok) throw new Error("inventory-path-escape");
          // Check every ancestor, including absent candidates beneath a linked directory.
          const parts = relative.split("/");
          for (let index = 1; index <= parts.length; index++) {
            const ancestor = joinPath(canonicalRoot, ...parts.slice(0, index));
            if (!ancestor.ok) throw new Error("inventory-path-escape");
            const stat = await fs.stat(ancestor.value, stop);
            if (!stat.ok) throw new Error("inventory-unreadable");
            if (stat.value === null) return;
            if (stat.value.kind === "symlink" || stat.value.kind === "other")
              throw new Error("inventory-path-escape");
          }
          const before = await fs.stat(path.value, stop);
          const real = await fs.realPath(path.value, stop);
          if (
            !before.ok ||
            before.value === null ||
            !real.ok ||
            !isInside(canonicalRoot, real.value) ||
            real.value !== path.value
          )
            throw new Error("inventory-path-escape");
          if (expectedKind !== undefined && before.value.kind !== expectedKind)
            throw new Error("inventory-malformed");
          if (before.value.kind === "directory") {
            const children = await fs.list(path.value, stop);
            if (!children.ok) throw new Error("inventory-unreadable");
            if (children.value.length + entries > WORKSPACE_INVENTORY_LIMITS.entries)
              throw new Error("inventory-entry-limit");
            for (const child of [...children.value].sort((a, b) => a.path.localeCompare(b.path))) {
              if (!isInside(path.value, child.path) || child.path === path.value)
                throw new Error("inventory-path-escape");
              await visit(child.path.slice(canonicalRoot.length + 1), family, depth + 1);
            }
          } else {
            if (loaders.length >= WORKSPACE_INVENTORY_LIMITS.files)
              throw new Error("inventory-file-limit");
            const read = await fs.readBytes(path.value, WORKSPACE_INVENTORY_LIMITS.fileBytes, stop);
            if (!read.ok)
              throw new Error(
                read.error.code === "oversized" ? "inventory-byte-limit" : "inventory-unreadable",
              );
            bytes += read.value.length;
            if (bytes > WORKSPACE_INVENTORY_LIMITS.bytes) throw new Error("inventory-byte-limit");
            if (
              relative.endsWith(".md") ||
              relative.endsWith(".json") ||
              relative.endsWith(".jsonc")
            ) {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(read.value);
              if (!options.validate(family, text, relative)) throw new Error("inventory-malformed");
              if (rootIndex === 0 && family === "settings") projectText = text;
            }
            loaders.push({
              source: canonicalDigest({ root: canonicalRoot, relative }),
              label: redactProjectionText(`root ${rootIndex + 1}/${relative}`, 256),
              family,
              digest: bytesDigest(read.value),
              sourceVersion: canonicalDigest({
                revision: before.value.revision,
                mode: before.value.mode,
              }),
              bytes: read.value.length,
              activation:
                family === "settings" && rootIndex === 0 ? "configuration" : "unavailable",
            });
          }
          const after = await fs.stat(path.value, stop);
          if (
            !after.ok ||
            after.value?.revision !== before.value.revision ||
            after.value?.mode !== before.value.mode ||
            after.value?.kind !== before.value.kind
          )
            throw new Error("inventory-changed");
        }
        if (`${canonicalRoot}/.falryn/falryn.jsonc` !== options.userConfiguration)
          await visit(".falryn/falryn.jsonc", "settings", 0, "file");
        await visit("AGENTS.md", "instructions", 0, "file");
        await visit(".falryn/instructions", "instructions", 0, "directory");
        await visit("mcp.json", "mcp", 0, "file");
        await visit(".falryn/mcp.json", "mcp", 0, "file");
        await visit(".falryn/hooks", "hooks", 0, "directory");
        await visit(".falryn/hooks.json", "hooks", 0, "file");
        await visit(".agents/skills", "skills", 0, "directory");
        await visit(".falryn/skills", "skills", 0, "directory");
      }
      check();
      loaders.sort((a, b) => a.source.localeCompare(b.source));
      const identity = canonicalDigest(identities);
      const report: WorkspaceInventory = {
        version: 1,
        identity,
        generation: canonicalDigest({
          identity,
          loaders,
          configuration: options.configuration,
          policy: WORKSPACE_TRUST_POLICY,
        }),
        policy: WORKSPACE_TRUST_POLICY,
        configuration: options.configuration,
        loaders,
      };
      return ok({ report, projectText });
    } catch (error) {
      const known = [
        "cancelled",
        "inventory-timeout",
        "inventory-entry-limit",
        "inventory-depth-limit",
        "inventory-file-limit",
        "inventory-byte-limit",
        "inventory-path-escape",
        "inventory-unreadable",
        "inventory-malformed",
        "inventory-changed",
        "workspace-unavailable",
      ];
      return err({
        code:
          error instanceof Error && known.includes(error.message)
            ? error.message
            : "inventory-unavailable",
      });
    }
  }
}
