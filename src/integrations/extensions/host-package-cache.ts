import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ExtensionInputError, packageRelativePath } from "../../domain/extensions/canonical.ts";
import type { PackageBytes } from "../../domain/extensions/lifecycle.ts";
import type { PackageSnapshot } from "../../domain/extensions/package-source.ts";

const idSchema = z.string().uuid();
const headerSchema = z.strictObject({
  version: z.literal(1),
  sourceId: z.string().min(1).max(256),
  ownership: z.strictObject({
    sourceOwner: z.string().max(256).nullable(),
    publisher: z.string().max(256).nullable(),
  }),
  files: z
    .array(
      z.strictObject({ path: z.string().max(4096), length: z.int().nonnegative().max(16_777_216) }),
    )
    .max(4096),
});
const MAX_HEADER = 1_048_576;
const MAX_BYTES = 67_108_864;

/** One inert container per owned version. Package paths are data, never deletion targets. */
export function createHostPackageCache(directory: string): PackageBytes {
  const root = resolve(directory);
  function path(id: string, suffix = ".package") {
    if (!idSchema.safeParse(id).success) throw new ExtensionInputError("invalid-storage-id");
    return join(root, id + suffix);
  }
  function checkRoot(create: boolean) {
    if (create) {
      const parent = lstatSync(dirname(root));
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new ExtensionInputError("unsafe-cache-root");
      try {
        mkdirSync(root, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
    }
    const stat = lstatSync(root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(root) !== join(realpathSync(dirname(root)), root.split(/[\\/]/u).at(-1) ?? "")
    )
      throw new ExtensionInputError("unsafe-cache-root");
  }
  function guard(signal: AbortSignal, started: number) {
    if (signal.aborted) throw new ExtensionInputError("cancelled");
    if (performance.now() - started > 30_000)
      throw new ExtensionInputError("package-cache-timeout");
  }
  function syncDirectory() {
    if (process.platform === "win32") return;
    const fd = openSync(root, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  return {
    stage(id, snapshot, signal) {
      const started = performance.now();
      guard(signal, started);
      checkRoot(true);
      const header = new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          sourceId: snapshot.sourceId,
          ownership: snapshot.ownership ?? { sourceOwner: null, publisher: null },
          files: snapshot.files.map((file) => ({ path: file.path, length: file.bytes.length })),
        }),
      );
      if (
        header.length > MAX_HEADER ||
        snapshot.files.reduce((n, f) => n + f.bytes.length, 0) > MAX_BYTES
      )
        throw new ExtensionInputError("package-cache-limit");
      const prefix = new Uint8Array(4);
      new DataView(prefix.buffer).setUint32(0, header.length);
      const temporary = path(id, ".staged");
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        for (const bytes of [prefix, header, ...snapshot.files.map((f) => f.bytes)]) {
          let offset = 0;
          while (offset < bytes.length) {
            guard(signal, started);
            const written = writeSync(fd, bytes, offset, Math.min(65_536, bytes.length - offset));
            if (written === 0) throw new ExtensionInputError("package-write-failed");
            offset += written;
          }
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      guard(signal, started);
      // The UUID was durably reserved before this transaction acquired the writer.
      try {
        lstatSync(path(id));
        throw new ExtensionInputError("cache-already-exists");
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
      renameSync(temporary, path(id));
      syncDirectory();
    },
    async read(version, signal) {
      const started = performance.now();
      guard(signal, started);
      checkRoot(false);
      const file = path(version.storageId);
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES + MAX_HEADER + 4)
          throw new ExtensionInputError("invalid-cache-file");
        let position = 0;
        function bytes(length: number): Uint8Array {
          const output = new Uint8Array(length);
          let offset = 0;
          while (offset < length) {
            guard(signal, started);
            const count = readSync(fd, output, offset, Math.min(65_536, length - offset), position);
            if (count === 0) throw new ExtensionInputError("truncated-package-cache");
            offset += count;
            position += count;
          }
          return output;
        }
        const prefix = bytes(4);
        const length = new DataView(prefix.buffer).getUint32(0);
        if (length > MAX_HEADER) throw new ExtensionInputError("invalid-cache-header");
        const header = headerSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(length))),
        );
        const paths = new Set<string>();
        let total = 0;
        for (const file of header.files) {
          const safe = packageRelativePath(file.path);
          total += file.length;
          if (safe === null || safe !== file.path || paths.has(safe) || total > MAX_BYTES)
            throw new ExtensionInputError("invalid-cache-inventory");
          paths.add(safe);
        }
        if (
          position + total !== stat.size ||
          total !== version.byteLength ||
          header.files.length !== version.fileCount ||
          header.sourceId !== version.sourceId ||
          JSON.stringify(header.ownership) !== JSON.stringify(version.ownership)
        )
          throw new ExtensionInputError("cache-identity-mismatch");
        const snapshot: PackageSnapshot = {
          sourceId: header.sourceId,
          ownership: header.ownership,
          files: header.files.map((f) => ({ path: f.path, bytes: bytes(f.length) })),
          diagnostics: [],
          omittedDiagnostics: 0,
        };
        return snapshot;
      } finally {
        closeSync(fd);
      }
    },
    async remove(id, signal) {
      const started = performance.now();
      guard(signal, started);
      try {
        checkRoot(false);
      } catch (error) {
        if (hasCode(error, "ENOENT")) return;
        throw error;
      }
      for (const suffix of [".staged", ".package"]) {
        guard(signal, started);
        const file = path(id, suffix);
        try {
          const stat = lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new ExtensionInputError("unsafe-cache-cleanup");
          unlinkSync(file);
        } catch (error) {
          if (!hasCode(error, "ENOENT")) throw error;
        }
      }
      syncDirectory();
    },
  };
}
function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
