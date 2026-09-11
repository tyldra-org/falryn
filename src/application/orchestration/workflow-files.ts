/** Read-only registration from the configured global root and the reviewed project inventory. */
import { parseJsonc } from "../../config/index.ts";
import { bytesDigest, canonicalDigest } from "../../domain/extensions/canonical.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import { WORKFLOW_LIMITS } from "../../domain/orchestration/workflow-definition.ts";
import type { WorkspaceTrustReport } from "../../domain/security/workspace-trust.ts";
import {
  type FileSystemPort,
  isInside,
  joinPath,
  type LocalPath,
} from "../../domain/workspace/index.ts";
import { createWorkflowRegistry } from "./workflow-registry.ts";

export async function loadWorkflowFiles(
  options: {
    readonly fileSystem: FileSystemPort;
    readonly configurationRoot: LocalPath;
    readonly workspaceRoot: LocalPath | null;
    readonly trust: WorkspaceTrustReport;
  },
  signal?: AbortSignal,
) {
  const registry = createWorkflowRegistry();
  const fs = options.fileSystem;
  let bytes = 0;
  const roots = [
    { scope: "global", root: options.configurationRoot },
    ...(options.workspaceRoot && options.trust.status === "accepted"
      ? [{ scope: "project", root: options.workspaceRoot }]
      : []),
  ];
  try {
    for (const source of roots) {
      const root = await fs.stat(source.root, signal);
      if (!root.ok) throw new Error("workflow-root-unavailable");
      if (!root.value) continue;
      const canonical = await fs.realPath(source.root, signal);
      if (!canonical.ok) throw new Error("workflow-root-unavailable");
      const folder = joinPath(
        canonical.value,
        ...(source.scope === "project" ? [".falryn", "workflows"] : ["workflows"]),
      );
      if (!folder.ok) throw new Error("workflow-root-unavailable");
      const exists = await fs.stat(folder.value, signal);
      if (!exists.ok) throw new Error("workflow-directory-unavailable");
      if (!exists.value) continue;
      const real = await fs.realPath(folder.value, signal);
      if (exists.value.kind !== "directory" || !real.ok || real.value !== folder.value)
        throw new Error("workflow-path-escape");
      const directories = await fs.list(folder.value, signal);
      if (!directories.ok || directories.value.length > 1024)
        throw new Error("workflow-catalog-inspection-limit");
      for (const directory of directories.value) {
        const name = directory.path.slice(folder.value.length + 1);
        if (
          !isInside(folder.value, directory.path) ||
          directory.kind !== "directory" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)
        )
          throw new Error("workflow-directory-invalid");
        const path = joinPath(directory.path, "workflow.jsonc");
        if (!path.ok) throw new Error("workflow-path-unavailable");
        const before = await fs.stat(path.value, signal);
        const resolved = await fs.realPath(path.value, signal);
        if (
          !before.ok ||
          before.value?.kind !== "file" ||
          !resolved.ok ||
          resolved.value !== path.value
        )
          throw new Error("workflow-file-unavailable");
        const read = await fs.readBytes(path.value, WORKFLOW_LIMITS.definitionBytes, signal);
        if (!read.ok) throw new Error("workflow-file-unavailable");
        bytes += read.value.byteLength;
        if (bytes > 16_777_216) throw new Error("workflow-catalog-inspection-limit");
        if (source.scope === "project") {
          const relative = path.value.slice(canonical.value.length + 1);
          const sourceId = canonicalDigest({ root: canonical.value, relative });
          const reviewed = options.trust.inventory?.loaders.find(
            (entry) => entry.source === sourceId && entry.family === "workflows",
          );
          if (!reviewed || reviewed.digest !== bytesDigest(read.value))
            throw new Error("workflow-review-required");
        }
        const parsed = parseJsonc(new TextDecoder("utf-8", { fatal: true }).decode(read.value));
        if (!parsed.ok) throw new Error("workflow-jsonc-invalid");
        const after = await fs.stat(path.value, signal);
        if (!after.ok || after.value?.revision !== before.value.revision)
          throw new Error("workflow-file-changed");
        const registered = registry.register(
          {
            definition: parsed.value,
            identity: {
              id: `user/${source.scope}/workflows:${name}`,
              provenance: "user",
              availability: "available",
              unavailableReason: null,
            },
          },
          null,
        );
        if (!registered.ok) throw new Error("workflow-definition-invalid");
      }
    }
    return ok(registry);
  } catch (error) {
    return err({
      code:
        error instanceof Error && /^workflow-[a-z-]+$/.test(error.message)
          ? error.message
          : "workflow-catalog-unavailable",
    });
  }
}
