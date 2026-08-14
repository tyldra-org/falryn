/**
 * Full-file writes and grouped multi-file mutation (#281).
 *
 * Binds caller paths, checks create/replace preconditions, then writes through
 * {@link FileSystemPort.writeBytes}. Patch hunks, dedicated rollback, and
 * product tools remain later work.
 */

import { createHash } from "node:crypto";

import {
  type BoundWorkspacePath,
  bindWorkspacePath,
  contentDigest,
  detectNewline,
  type FileSystemError,
  type FileSystemPort,
  isInside,
  type LocalPath,
  type ParsedWorkspaceWritePlan,
  type ParsedWorkspaceWriteTarget,
  parentPath,
  parseWorkspaceWritePlan,
  type WorkspaceWriteError,
  type WorkspaceWriteItem,
  type WorkspaceWriteOperation,
  type WorkspaceWritePolicy,
  type WorkspaceWriteRejected,
  type WorkspaceWriteResult,
  wholeFileChangedRegion,
} from "../domain/index.ts";

export type WorkspaceWriter = {
  apply(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceWriteResult }
    | { readonly ok: false; readonly error: WorkspaceWriteError }
  >;
};

export type WorkspaceWriterOptions = {
  readonly fileSystem: FileSystemPort;
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function digestOf(bytes: Uint8Array): ReturnType<typeof contentDigest.from> {
  const hash = createHash("sha256");
  hash.update(bytes);
  return contentDigest.from(`sha-256:${hash.digest("hex")}`);
}

function fromFilesystem(error: FileSystemError): WorkspaceWriteError {
  switch (error.code) {
    case "cancelled":
      return { code: "cancelled" };
    case "not-found":
      return { code: "not-found" };
    case "not-a-directory":
      return { code: "not-a-file" };
    default:
      return { code: "filesystem", reason: error.code };
  }
}

type BoundTarget = {
  readonly target: ParsedWorkspaceWriteTarget;
  readonly bound: BoundWorkspacePath | null;
  readonly error: WorkspaceWriteError | null;
};

function rejected(
  target: ParsedWorkspaceWriteTarget,
  status: WorkspaceWriteRejected["status"],
  error: WorkspaceWriteError,
  resolved: LocalPath | null,
): WorkspaceWriteRejected {
  return {
    index: target.index,
    status,
    operation: target.operation,
    requested: target.path,
    resolved,
    error,
  };
}

function unscheduledRemaining(
  boundTargets: readonly BoundTarget[],
  start: number,
  error: WorkspaceWriteError,
): WorkspaceWriteItem[] {
  return boundTargets
    .slice(start)
    .map((item) => rejected(item.target, "unscheduled", error, item.bound?.resolved ?? null));
}

async function bindWritePath(
  fileSystem: FileSystemPort,
  root: LocalPath,
  value: string,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: BoundWorkspacePath }
  | { readonly ok: false; readonly error: WorkspaceWriteError }
> {
  const lexical = bindWorkspacePath(root, value);
  if (!lexical.ok) {
    return lexical;
  }
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const real = await fileSystem.realPath(lexical.value.resolved, signal);
  if (real.ok) {
    if (!isInside(root, real.value)) {
      return { ok: false, error: { code: "symlink-escape" } };
    }
    return lexical;
  }
  if (real.error.code === "cancelled") {
    return { ok: false, error: { code: "cancelled" } };
  }
  if (real.error.code !== "not-found") {
    return { ok: false, error: { code: "filesystem", reason: real.error.code } };
  }
  let cursor = parentPath(lexical.value.resolved);
  while (cursor !== null) {
    if (isAborted(signal)) {
      return { ok: false, error: { code: "cancelled" } };
    }
    const parentReal = await fileSystem.realPath(cursor, signal);
    if (parentReal.ok) {
      if (!isInside(root, parentReal.value)) {
        return { ok: false, error: { code: "symlink-escape" } };
      }
      return lexical;
    }
    if (parentReal.error.code === "cancelled") {
      return { ok: false, error: { code: "cancelled" } };
    }
    if (parentReal.error.code === "not-found") {
      cursor = parentPath(cursor);
      continue;
    }
    return { ok: false, error: { code: "filesystem", reason: parentReal.error.code } };
  }
  return { ok: false, error: { code: "not-found" } };
}

async function validateTarget(
  fileSystem: FileSystemPort,
  target: ParsedWorkspaceWriteTarget,
  bound: BoundWorkspacePath,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<WorkspaceWriteError | null> {
  if (isAborted(signal)) {
    return { code: "cancelled" };
  }
  const stated = await fileSystem.stat(bound.resolved, signal);
  if (!stated.ok) {
    return fromFilesystem(stated.error);
  }
  if (target.operation === "create") {
    return stated.value === null ? null : { code: "already-exists" };
  }
  if (stated.value === null) {
    return { code: "not-found" };
  }
  if (stated.value.kind !== "file") {
    return { code: "not-a-file" };
  }
  if (target.expectedRevision !== null && stated.value.revision !== target.expectedRevision) {
    return { code: "revision-mismatch" };
  }
  if (target.expectedDigest === null) {
    return null;
  }
  const bytes = await fileSystem.readBytes(bound.resolved, maxFileBytes, signal);
  if (!bytes.ok) {
    return fromFilesystem(bytes.error);
  }
  return digestOf(bytes.value) === target.expectedDigest ? null : { code: "digest-mismatch" };
}

function isPrecondition(error: WorkspaceWriteError): boolean {
  switch (error.code) {
    case "already-exists":
    case "not-found":
    case "not-a-file":
    case "digest-mismatch":
    case "revision-mismatch":
      return true;
    default:
      return false;
  }
}

async function applyTarget(
  fileSystem: FileSystemPort,
  target: ParsedWorkspaceWriteTarget,
  bound: BoundWorkspacePath,
  signal?: AbortSignal,
): Promise<WorkspaceWriteItem> {
  if (isAborted(signal)) {
    return rejected(target, "cancelled", { code: "cancelled" }, bound.resolved);
  }
  if (target.operation === "create") {
    const parent = parentPath(bound.resolved);
    if (parent !== null) {
      const created = await fileSystem.createDirectory(parent, 0o700, signal);
      if (!created.ok) {
        return rejected(target, "failed", fromFilesystem(created.error), bound.resolved);
      }
    }
  }
  const written = await fileSystem.writeBytes(bound.resolved, target.bytes, signal);
  if (!written.ok) {
    return rejected(target, "failed", fromFilesystem(written.error), bound.resolved);
  }
  return {
    index: target.index,
    status: "applied",
    operation: target.operation,
    bound,
    digest: digestOf(target.bytes),
    revision: written.value.revision,
    byteLength: written.value.byteLength,
    newline: detectNewline(target.text),
    changedRegion: wholeFileChangedRegion(written.value.byteLength),
  };
}

async function bindPlan(
  fileSystem: FileSystemPort,
  root: LocalPath,
  plan: ParsedWorkspaceWritePlan,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: readonly BoundTarget[] }
  | { readonly ok: false; readonly error: WorkspaceWriteError }
> {
  const boundTargets: BoundTarget[] = [];
  const resolved = new Map<LocalPath, number>();
  for (const target of plan.targets) {
    if (isAborted(signal)) {
      return { ok: false, error: { code: "cancelled" } };
    }
    const bound = await bindWritePath(fileSystem, root, target.path, signal);
    if (!bound.ok) {
      boundTargets.push({ target, bound: null, error: bound.error });
      continue;
    }
    const previous = resolved.get(bound.value.resolved);
    if (previous !== undefined) {
      return { ok: false, error: { code: "overlapping-targets", reason: "duplicate" } };
    }
    resolved.set(bound.value.resolved, target.index);
    boundTargets.push({ target, bound: bound.value, error: null });
  }
  return { ok: true, value: boundTargets };
}

async function applyFailBeforeEffect(
  fileSystem: FileSystemPort,
  policy: WorkspaceWritePolicy,
  boundTargets: readonly BoundTarget[],
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<WorkspaceWriteResult> {
  const validations: Array<WorkspaceWriteError | null> = [];
  for (const item of boundTargets) {
    if (item.error !== null || item.bound === null) {
      validations.push(item.error ?? { code: "not-found" });
      continue;
    }
    validations.push(
      await validateTarget(fileSystem, item.target, item.bound, maxFileBytes, signal),
    );
  }
  if (validations.some((error) => error !== null)) {
    return {
      policy,
      items: boundTargets.map((item, index) => {
        const error = validations[index];
        if (error !== null && error !== undefined) {
          return rejected(item.target, "failed", error, item.bound?.resolved ?? null);
        }
        return rejected(
          item.target,
          "unscheduled",
          { code: "plan-refused" },
          item.bound?.resolved ?? null,
        );
      }),
    };
  }
  const items: WorkspaceWriteItem[] = [];
  for (const [index, item] of boundTargets.entries()) {
    if (item.bound === null) {
      items.push(rejected(item.target, "failed", item.error ?? { code: "not-found" }, null));
      continue;
    }
    const applied = await applyTarget(fileSystem, item.target, item.bound, signal);
    items.push(applied);
    if (applied.status !== "applied") {
      items.push(...unscheduledRemaining(boundTargets, index + 1, applied.error));
      break;
    }
  }
  return { policy, items };
}

async function applyBestEffort(
  fileSystem: FileSystemPort,
  policy: WorkspaceWritePolicy,
  boundTargets: readonly BoundTarget[],
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<WorkspaceWriteResult> {
  const items: WorkspaceWriteItem[] = [];
  for (const [index, item] of boundTargets.entries()) {
    if (isAborted(signal)) {
      items.push(
        ...boundTargets
          .slice(index)
          .map((remaining) =>
            rejected(
              remaining.target,
              "cancelled",
              { code: "cancelled" },
              remaining.bound?.resolved ?? null,
            ),
          ),
      );
      break;
    }
    if (item.error !== null || item.bound === null) {
      items.push(
        rejected(
          item.target,
          "failed",
          item.error ?? { code: "not-found" },
          item.bound?.resolved ?? null,
        ),
      );
      continue;
    }
    const invalid = await validateTarget(fileSystem, item.target, item.bound, maxFileBytes, signal);
    if (invalid !== null) {
      items.push(
        rejected(
          item.target,
          invalid.code === "cancelled"
            ? "cancelled"
            : isPrecondition(invalid)
              ? "skipped"
              : "failed",
          invalid,
          item.bound.resolved,
        ),
      );
      if (invalid.code === "cancelled") {
        items.push(
          ...boundTargets
            .slice(index + 1)
            .map((remaining) =>
              rejected(
                remaining.target,
                "cancelled",
                { code: "cancelled" },
                remaining.bound?.resolved ?? null,
              ),
            ),
        );
        break;
      }
      continue;
    }
    const applied = await applyTarget(fileSystem, item.target, item.bound, signal);
    items.push(applied);
    if (applied.status !== "applied") {
      const restStatus = applied.status === "cancelled" ? "cancelled" : "unscheduled";
      items.push(
        ...boundTargets
          .slice(index + 1)
          .map((remaining) =>
            rejected(
              remaining.target,
              restStatus,
              applied.status === "cancelled" ? { code: "cancelled" } : { code: "plan-refused" },
              remaining.bound?.resolved ?? null,
            ),
          ),
      );
      break;
    }
  }
  return { policy, items };
}

export function createWorkspaceWriter(options: WorkspaceWriterOptions): WorkspaceWriter {
  return {
    async apply(root, request, signal) {
      const parsed = parseWorkspaceWritePlan(request);
      if (!parsed.ok) {
        return parsed;
      }
      if (isAborted(signal)) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const bound = await bindPlan(options.fileSystem, root, parsed.value, signal);
      if (!bound.ok) {
        return bound;
      }
      const result =
        parsed.value.policy === "fail-before-effect"
          ? await applyFailBeforeEffect(
              options.fileSystem,
              parsed.value.policy,
              bound.value,
              parsed.value.limits.maxFileBytes,
              signal,
            )
          : await applyBestEffort(
              options.fileSystem,
              parsed.value.policy,
              bound.value,
              parsed.value.limits.maxFileBytes,
              signal,
            );
      return { ok: true, value: result };
    },
  };
}

export type {
  WorkspaceWriteError,
  WorkspaceWriteItem,
  WorkspaceWriteOperation,
  WorkspaceWritePolicy,
  WorkspaceWriteResult,
};
