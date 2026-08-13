/**
 * Workspace one-file and bounded multi-file reads (#56).
 *
 * Binds caller paths, then reads through {@link FileSystemPort.readText}.
 * Artifact spill and specialized readers remain later #54 children.
 */

import {
  applyByteRange,
  applyLineRange,
  type BoundWorkspacePath,
  bindWorkspacePath,
  detectNewline,
  type FileSystemPort,
  isBinaryText,
  isInside,
  type LocalPath,
  MAX_READ_MANY_TARGETS,
  numberLines,
  readLimits,
  type WorkspaceFileRead,
  type WorkspaceReadError,
  type WorkspaceReadLimits,
  type WorkspaceReadManyItem,
  type WorkspaceReadManyResult,
  type WorkspaceReadRange,
  type WorkspaceReadTarget,
} from "../domain/index.ts";

export type WorkspaceReader = {
  read(
    root: LocalPath,
    value: unknown,
    range?: WorkspaceReadRange,
    limits?: Partial<WorkspaceReadLimits>,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceFileRead }
    | { readonly ok: false; readonly error: WorkspaceReadError }
  >;
  readMany(
    root: LocalPath,
    targets: readonly WorkspaceReadTarget[],
    limits?: Partial<WorkspaceReadLimits>,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceReadManyResult }
    | { readonly ok: false; readonly error: WorkspaceReadError }
  >;
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function bindReadPath(
  fileSystem: FileSystemPort,
  root: LocalPath,
  value: unknown,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: BoundWorkspacePath }
  | { readonly ok: false; readonly error: WorkspaceReadError }
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
    if (real.error.code === "cancelled") {
      return { ok: false, error: { code: "cancelled" } };
    }
    if (real.error.code === "not-found") {
      return { ok: false, error: { code: "not-found" } };
    }
    return { ok: false, error: { code: "filesystem", reason: real.error.code } };
  }
  if (!isInside(root, real.value)) {
    return { ok: false, error: { code: "symlink-escape" } };
  }
  return {
    ok: true,
    value: {
      ...lexical.value,
      resolved: real.value,
      logical:
        real.value === root
          ? ""
          : real.value.slice(root.endsWith("/") ? root.length : root.length + 1),
    },
  };
}

async function readBound(
  fileSystem: FileSystemPort,
  bound: BoundWorkspacePath,
  range: WorkspaceReadRange | undefined,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: WorkspaceFileRead }
  | { readonly ok: false; readonly error: WorkspaceReadError }
> {
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const stated = await fileSystem.stat(bound.resolved, signal);
  if (!stated.ok) {
    return stated.error.code === "cancelled"
      ? { ok: false, error: { code: "cancelled" } }
      : { ok: false, error: { code: "filesystem", reason: stated.error.code } };
  }
  if (stated.value === null) {
    return { ok: false, error: { code: "not-found" } };
  }
  if (stated.value.kind !== "file") {
    return { ok: false, error: { code: "not-a-file" } };
  }
  if (stated.value.byteLength > maxFileBytes) {
    return { ok: false, error: { code: "oversized", byteLength: stated.value.byteLength } };
  }
  const text = await fileSystem.readText(bound.resolved, maxFileBytes, signal);
  if (!text.ok) {
    if (text.error.code === "cancelled") {
      return { ok: false, error: { code: "cancelled" } };
    }
    if (text.error.code === "not-found") {
      return { ok: false, error: { code: "not-found" } };
    }
    if (text.error.code === "oversized") {
      return { ok: false, error: { code: "oversized", byteLength: stated.value.byteLength } };
    }
    if (text.error.code === "malformed-encoding") {
      return { ok: false, error: { code: "malformed-encoding" } };
    }
    if (text.error.code === "not-a-directory") {
      return { ok: false, error: { code: "not-a-file" } };
    }
    return { ok: false, error: { code: "filesystem", reason: text.error.code } };
  }
  if (isBinaryText(text.value)) {
    return { ok: false, error: { code: "binary" } };
  }
  const newline = detectNewline(text.value);
  if (range === undefined) {
    return {
      ok: true,
      value: {
        bound,
        kind: stated.value.kind,
        byteLength: stated.value.byteLength,
        newline,
        range: null,
        lines: numberLines(text.value),
        truncated: false,
      },
    };
  }
  if (range.kind === "line") {
    const sliced = applyLineRange(text.value, range.range);
    if ("error" in sliced) {
      return { ok: false, error: { code: "malformed-range" } };
    }
    return {
      ok: true,
      value: {
        bound,
        kind: stated.value.kind,
        byteLength: stated.value.byteLength,
        newline,
        range,
        lines: sliced.lines,
        truncated: sliced.truncated,
      },
    };
  }
  const sliced = applyByteRange(text.value, range.range);
  if ("error" in sliced) {
    return { ok: false, error: { code: sliced.error } };
  }
  return {
    ok: true,
    value: {
      bound,
      kind: stated.value.kind,
      byteLength: stated.value.byteLength,
      newline,
      range,
      lines: numberLines(sliced.text),
      truncated: sliced.truncated,
    },
  };
}

export function createWorkspaceReader(fileSystem: FileSystemPort): WorkspaceReader {
  return {
    async read(root, value, range, limits, signal) {
      const bound = await bindReadPath(fileSystem, root, value, signal);
      if (!bound.ok) {
        return bound;
      }
      return readBound(fileSystem, bound.value, range, readLimits(limits).maxFileBytes, signal);
    },

    async readMany(root, targets, limits, signal) {
      if (targets.length > MAX_READ_MANY_TARGETS) {
        return { ok: false, error: { code: "too-many-targets" } };
      }
      const settings = readLimits(limits);
      const items: WorkspaceReadManyItem[] = [];
      if (targets.length === 0) {
        return { ok: true, value: { items } };
      }

      const boundTargets: (
        | {
            readonly index: number;
            readonly ok: true;
            readonly bound: BoundWorkspacePath;
            readonly range?: WorkspaceReadRange;
          }
        | { readonly index: number; readonly ok: false; readonly error: WorkspaceReadError }
      )[] = [];
      for (let index = 0; index < targets.length; index += 1) {
        if (isAborted(signal)) {
          boundTargets.push({ index, ok: false, error: { code: "cancelled" } });
          continue;
        }
        const target = targets[index];
        if (target === undefined) {
          continue;
        }
        const bound = await bindReadPath(fileSystem, root, target.path, signal);
        if (!bound.ok) {
          boundTargets.push({ index, ok: false, error: bound.error });
          continue;
        }
        if (target.range === undefined) {
          boundTargets.push({ index, ok: true, bound: bound.value });
        } else {
          boundTargets.push({ index, ok: true, bound: bound.value, range: target.range });
        }
      }

      const firstByResolved = new Map<string, number>();
      const uniqueOrder: string[] = [];
      for (const bound of boundTargets) {
        if (!bound.ok) {
          continue;
        }
        if (!firstByResolved.has(bound.bound.resolved)) {
          firstByResolved.set(bound.bound.resolved, bound.index);
          uniqueOrder.push(bound.bound.resolved);
        }
      }

      const uniqueResults = new Map<
        string,
        | { readonly status: "read"; readonly value: WorkspaceFileRead }
        | { readonly status: "failed"; readonly error: WorkspaceReadError }
        | { readonly status: "unscheduled"; readonly error: WorkspaceReadError }
      >();
      let aggregate = 0;
      let nextUnique = 0;

      const runUnique = async (resolved: string): Promise<void> => {
        const firstIndex = firstByResolved.get(resolved);
        const source = boundTargets.find((item) => item.ok && item.index === firstIndex);
        if (firstIndex === undefined || source === undefined || !source.ok) {
          return;
        }
        if (isAborted(signal)) {
          uniqueResults.set(resolved, { status: "failed", error: { code: "cancelled" } });
          return;
        }
        if (aggregate >= settings.maxAggregateBytes) {
          uniqueResults.set(resolved, {
            status: "unscheduled",
            error: { code: "oversized", byteLength: aggregate },
          });
          return;
        }
        const read = await readBound(
          fileSystem,
          source.bound,
          source.range,
          settings.maxFileBytes,
          signal,
        );
        if (!read.ok) {
          uniqueResults.set(resolved, { status: "failed", error: read.error });
          return;
        }
        const size = Buffer.byteLength(
          read.value.lines.map((line) => line.text).join("\n"),
          "utf8",
        );
        if (aggregate + size > settings.maxAggregateBytes) {
          uniqueResults.set(resolved, {
            status: "unscheduled",
            error: { code: "oversized", byteLength: aggregate + size },
          });
          return;
        }
        aggregate += size;
        uniqueResults.set(resolved, { status: "read", value: read.value });
      };

      const workers = Array.from(
        { length: Math.min(settings.maxConcurrency, uniqueOrder.length) },
        async () => {
          while (true) {
            const slot = nextUnique;
            nextUnique += 1;
            const resolved = uniqueOrder[slot];
            if (resolved === undefined) {
              break;
            }
            await runUnique(resolved);
          }
        },
      );
      await Promise.all(workers);

      for (const bound of boundTargets) {
        if (!bound.ok) {
          items.push({ index: bound.index, status: "failed", error: bound.error });
          continue;
        }
        const unique = uniqueResults.get(bound.bound.resolved);
        if (unique === undefined) {
          items.push({ index: bound.index, status: "failed", error: { code: "cancelled" } });
          continue;
        }
        if (unique.status === "read") {
          items.push({
            index: bound.index,
            status: "read",
            value: { ...unique.value, bound: bound.bound },
          });
          continue;
        }
        items.push({ index: bound.index, status: unique.status, error: unique.error });
      }
      items.sort((left, right) => left.index - right.index);
      return { ok: true, value: { items } };
    },
  };
}
