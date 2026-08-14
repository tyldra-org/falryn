/**
 * Workspace patch hunk preview, conflict, and apply (#66).
 *
 * Binds paths, validates exact preimages, then writes staged files through
 * {@link FileSystemPort.writeBytes}. Hunks are never relocated. Rollback,
 * Git revisions, and product tools remain later work.
 */

import { createHash } from "node:crypto";

import {
  applyPatchHunks,
  type BoundWorkspacePath,
  bindWorkspacePath,
  computePatchPlanId,
  contentDigest,
  decodeWorkspaceText,
  detectNewline,
  type FileSystemError,
  type FileSystemPort,
  isBinaryText,
  isInside,
  joinPatchedLines,
  type LineRange,
  type LocalPath,
  type ParsedPatchPlan,
  type ParsedPatchTarget,
  type PatchHunkPreview,
  parseWorkspacePatchPlan,
  splitLines,
  type WorkspacePatchError,
  type WorkspacePatchItem,
  type WorkspacePatchPreview,
  type WorkspacePatchRejected,
  type WorkspacePatchResult,
} from "../domain/index.ts";

export type WorkspacePatcher = {
  preview(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspacePatchPreview }
    | { readonly ok: false; readonly error: WorkspacePatchError }
  >;
  apply(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspacePatchResult }
    | { readonly ok: false; readonly error: WorkspacePatchError }
  >;
};

export type WorkspacePatcherOptions = {
  readonly fileSystem: FileSystemPort;
};

/** Application seam described as `PatchPort` in architecture docs. */
export type PatchPort = WorkspacePatcher;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function digestOf(bytes: Uint8Array): ReturnType<typeof contentDigest.from> {
  const hash = createHash("sha256");
  hash.update(bytes);
  return contentDigest.from(`sha-256:${hash.digest("hex")}`);
}

function fromFilesystem(error: FileSystemError): WorkspacePatchError {
  switch (error.code) {
    case "cancelled":
      return { code: "cancelled" };
    case "not-found":
      return { code: "not-found" };
    case "not-a-directory":
      return { code: "not-a-file" };
    case "oversized":
      return { code: "oversized", byteLength: 0 };
    case "malformed-encoding":
      return { code: "unsupported" };
    default:
      return { code: "filesystem", reason: error.code };
  }
}

function rejected(
  target: ParsedPatchTarget,
  status: WorkspacePatchRejected["status"],
  error: WorkspacePatchError,
  resolved: LocalPath | null,
): WorkspacePatchRejected {
  return {
    index: target.index,
    status,
    requested: target.path,
    resolved,
    error,
  };
}

async function bindExistingFile(
  fileSystem: FileSystemPort,
  root: LocalPath,
  value: string,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: BoundWorkspacePath }
  | { readonly ok: false; readonly error: WorkspacePatchError }
> {
  const lexical = bindWorkspacePath(root, value);
  if (!lexical.ok) {
    return lexical;
  }
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const real = await fileSystem.realPath(lexical.value.resolved, signal);
  if (!real.ok) {
    return { ok: false, error: fromFilesystem(real.error) };
  }
  if (!isInside(root, real.value)) {
    return { ok: false, error: { code: "symlink-escape" } };
  }
  return lexical;
}

type StagedTarget = {
  readonly target: ParsedPatchTarget;
  readonly bound: BoundWorkspacePath;
  readonly bytes: Uint8Array;
  readonly regions: readonly LineRange[];
  readonly hunks: readonly PatchHunkPreview[];
};

async function stageTarget(
  fileSystem: FileSystemPort,
  root: LocalPath,
  target: ParsedPatchTarget,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: StagedTarget }
  | {
      readonly ok: false;
      readonly error: WorkspacePatchError;
      readonly bound: BoundWorkspacePath | null;
    }
> {
  const bound = await bindExistingFile(fileSystem, root, target.path, signal);
  if (!bound.ok) {
    return { ok: false, error: bound.error, bound: null };
  }
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" }, bound: bound.value };
  }
  const stated = await fileSystem.stat(bound.value.resolved, signal);
  if (!stated.ok) {
    return { ok: false, error: fromFilesystem(stated.error), bound: bound.value };
  }
  if (stated.value === null) {
    return { ok: false, error: { code: "not-found" }, bound: bound.value };
  }
  if (stated.value.kind !== "file") {
    return { ok: false, error: { code: "not-a-file" }, bound: bound.value };
  }
  if (target.expectedRevision !== null && stated.value.revision !== target.expectedRevision) {
    return { ok: false, error: { code: "revision-mismatch" }, bound: bound.value };
  }
  const raw = await fileSystem.readBytes(bound.value.resolved, maxFileBytes, signal);
  if (!raw.ok) {
    return { ok: false, error: fromFilesystem(raw.error), bound: bound.value };
  }
  if (target.expectedDigest !== null && digestOf(raw.value) !== target.expectedDigest) {
    return { ok: false, error: { code: "digest-mismatch" }, bound: bound.value };
  }
  const decoded = decodeWorkspaceText(raw.value);
  if (!decoded.ok) {
    return { ok: false, error: { code: "unsupported" }, bound: bound.value };
  }
  if (isBinaryText(decoded.value.text)) {
    return { ok: false, error: { code: "unsupported" }, bound: bound.value };
  }
  const newline = detectNewline(decoded.value.text);
  if (newline === "mixed") {
    return { ok: false, error: { code: "unsupported" }, bound: bound.value };
  }
  const trailingNewline = decoded.value.text.endsWith("\n") || decoded.value.text.endsWith("\r");
  const applied = applyPatchHunks(splitLines(decoded.value.text), target.hunks);
  if (!applied.ok) {
    return { ok: false, error: applied.error, bound: bound.value };
  }
  const mark = newline === "crlf" ? "crlf" : newline === "cr" ? "cr" : "lf";
  const text = joinPatchedLines(applied.value.lines, mark, trailingNewline);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxFileBytes) {
    return {
      ok: false,
      error: { code: "oversized", byteLength: bytes.byteLength },
      bound: bound.value,
    };
  }
  return {
    ok: true,
    value: {
      target,
      bound: bound.value,
      bytes,
      regions: applied.value.regions,
      hunks: applied.value.hunks,
    },
  };
}

export function createWorkspacePatcher(options: WorkspacePatcherOptions): WorkspacePatcher {
  const { fileSystem } = options;

  async function stagePlan(
    root: LocalPath,
    plan: ParsedPatchPlan,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly ok: true;
        readonly planId: string;
        readonly staged: readonly (StagedTarget | WorkspacePatchRejected)[];
      }
    | { readonly ok: false; readonly error: WorkspacePatchError }
  > {
    const planId = computePatchPlanId(plan);
    const staged: Array<StagedTarget | WorkspacePatchRejected> = [];
    let aggregate = 0;
    const resolved = new Map<LocalPath, number>();
    for (const target of plan.targets) {
      if (isAborted(signal)) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const next = await stageTarget(fileSystem, root, target, plan.limits.maxFileBytes, signal);
      if (!next.ok) {
        staged.push(rejected(target, "failed", next.error, next.bound?.resolved ?? null));
        continue;
      }
      const previous = resolved.get(next.value.bound.resolved);
      if (previous !== undefined) {
        return { ok: false, error: { code: "overlapping-targets", reason: "duplicate" } };
      }
      resolved.set(next.value.bound.resolved, target.index);
      aggregate += next.value.bytes.byteLength;
      if (aggregate > plan.limits.maxAggregateBytes) {
        staged.push(
          rejected(target, "failed", { code: "aggregate-limit" }, next.value.bound.resolved),
        );
        continue;
      }
      staged.push(next.value);
    }
    return { ok: true, planId, staged };
  }

  return {
    async preview(root, request, signal) {
      const parsed = parseWorkspacePatchPlan(request);
      if (!parsed.ok) {
        return parsed;
      }
      const staged = await stagePlan(root, parsed.value, signal);
      if (!staged.ok) {
        return staged;
      }
      const targets = parsed.value.targets.map((target, index) => {
        const item = staged.staged[index];
        if (item !== undefined && "hunks" in item) {
          return { index: target.index, path: target.path, hunks: item.hunks };
        }
        const error = item !== undefined && "error" in item ? item.error : null;
        if (error?.code === "conflict") {
          return {
            index: target.index,
            path: target.path,
            hunks: [
              {
                index: error.hunkIndex,
                status: "conflict" as const,
                header: `@@ -${error.lineStart},${error.foundCount} +${error.lineStart},${error.foundCount} @@`,
                oldStart: error.lineStart,
                oldCount: error.foundCount,
                newStart: error.lineStart,
                newCount: error.foundCount,
              },
            ],
          };
        }
        return { index: target.index, path: target.path, hunks: [] };
      });
      return {
        ok: true,
        value: { planId: staged.planId, policy: parsed.value.policy, targets },
      };
    },

    async apply(root, request, signal) {
      const parsed = parseWorkspacePatchPlan(request);
      if (!parsed.ok) {
        return parsed;
      }
      const staged = await stagePlan(root, parsed.value, signal);
      if (!staged.ok) {
        return staged;
      }
      if (parsed.value.expectedPlanId !== null && parsed.value.expectedPlanId !== staged.planId) {
        return { ok: false, error: { code: "stale-plan" } };
      }
      const failures = staged.staged.filter((item) => !("bytes" in item));
      if (parsed.value.policy === "fail-before-effect" && failures.length > 0) {
        return {
          ok: true,
          value: {
            planId: staged.planId,
            policy: parsed.value.policy,
            items: staged.staged.map((item, index) => {
              if ("bytes" in item) {
                return rejected(
                  parsed.value.targets[index] ?? item.target,
                  "unscheduled",
                  { code: "plan-refused" },
                  item.bound.resolved,
                );
              }
              return item;
            }),
          },
        };
      }
      const items: WorkspacePatchItem[] = [];
      for (const [index, item] of staged.staged.entries()) {
        if (!("bytes" in item)) {
          items.push(item);
          continue;
        }
        if (isAborted(signal)) {
          items.push(
            rejected(item.target, "cancelled", { code: "cancelled" }, item.bound.resolved),
          );
          items.push(
            ...staged.staged
              .slice(index + 1)
              .map((remaining) =>
                "bytes" in remaining
                  ? rejected(
                      remaining.target,
                      "unscheduled",
                      { code: "cancelled" },
                      remaining.bound.resolved,
                    )
                  : remaining,
              ),
          );
          break;
        }
        const written = await fileSystem.writeBytes(item.bound.resolved, item.bytes, signal);
        if (!written.ok) {
          items.push(
            rejected(item.target, "failed", fromFilesystem(written.error), item.bound.resolved),
          );
          items.push(
            ...staged.staged
              .slice(index + 1)
              .map((remaining) =>
                "bytes" in remaining
                  ? rejected(
                      remaining.target,
                      "unscheduled",
                      fromFilesystem(written.error),
                      remaining.bound.resolved,
                    )
                  : remaining,
              ),
          );
          break;
        }
        items.push({
          index: item.target.index,
          status: "applied",
          bound: item.bound,
          digest: digestOf(item.bytes),
          revision: written.value.revision,
          byteLength: written.value.byteLength,
          changedRegions: item.regions,
        });
      }
      return {
        ok: true,
        value: { planId: staged.planId, policy: parsed.value.policy, items },
      };
    },
  };
}
