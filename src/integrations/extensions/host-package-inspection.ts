import type { BigIntStats } from "node:fs";
import { constants, lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  bytesDigest,
  ExtensionInputError,
  packageRelativePath,
} from "../../domain/extensions/canonical.ts";
import type {
  InspectionDiagnostic,
  PackageFile,
  PackageSource,
} from "../../domain/extensions/package-source.ts";

/** Reject links rather than following an untrusted package into another tree. */
export function createHostPackageSource(directory: string): PackageSource {
  return {
    async read(signal) {
      const started = performance.now();
      const guard = () => {
        if (signal?.aborted) throw new ExtensionInputError("cancelled");
        if (performance.now() - started > 30_000)
          throw new ExtensionInputError("inspection-deadline");
      };
      guard();
      const root = resolve(directory);
      const files: PackageFile[] = [];
      const diagnostics: InspectionDiagnostic[] = [];
      let omittedDiagnostics = 0;
      let entries = 0;
      let total = 0;
      const paths = new Set<string>();
      const observations: { path: string; physical: string; stat: BigIntStats }[] = [];
      const diagnose = (code: string, path: string) => {
        if (diagnostics.length < 128) diagnostics.push({ code, path });
        else omittedDiagnostics++;
      };
      try {
        const rootStat = await lstat(root, { bigint: true });
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
          throw new ExtensionInputError("invalid-package-root");
        const physicalRoot = await realpath(root);
        const walk = async (relative: string, depth: number): Promise<void> => {
          guard();
          if (depth > 64) throw new ExtensionInputError("directory-depth-limit");
          const directoryPath = join(root, relative);
          const before = await lstat(directoryPath, { bigint: true });
          if (relative === "" && !same(rootStat, before))
            throw new ExtensionInputError("package-input-changed");
          observations.push({
            path: directoryPath,
            physical: join(physicalRoot, relative),
            stat: before,
          });
          if (
            !before.isDirectory() ||
            (await realpath(directoryPath)) !== join(physicalRoot, relative)
          )
            throw new ExtensionInputError("package-input-changed");
          const children = await readdir(directoryPath);
          for (const child of children.sort()) {
            guard();
            if (++entries > 4_096) throw new ExtensionInputError("package-entry-limit");
            const raw = relative === "" ? child : `${relative}/${child}`;
            const path = packageRelativePath(raw);
            if (path === null) throw new ExtensionInputError("unsafe-package-path");
            if (paths.has(path)) throw new ExtensionInputError("duplicate-package-path");
            paths.add(path);
            const hostPath = join(root, raw);
            const initial = await lstat(hostPath, { bigint: true });
            if (initial.isSymbolicLink() || (!initial.isFile() && !initial.isDirectory())) {
              diagnose("unsupported-package-entry", path);
              continue;
            }
            if (initial.isDirectory()) {
              await walk(raw, depth + 1);
              continue;
            }
            const maximum = /(?:\.json|SKILL\.md)$/u.test(path) ? 1_048_576 : 16_777_216;
            if (initial.size > BigInt(maximum) || total + Number(initial.size) > 67_108_864)
              throw new ExtensionInputError("package-byte-limit");
            if ((await realpath(hostPath)) !== join(physicalRoot, raw))
              throw new ExtensionInputError("package-input-changed");
            const handle = await open(
              hostPath,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              const opened = await handle.stat({ bigint: true });
              if (!opened.isFile() || !same(initial, opened))
                throw new ExtensionInputError("package-input-changed");
              const bytes = new Uint8Array(Number(opened.size));
              let offset = 0;
              while (offset < bytes.length) {
                guard();
                const read = await handle.read(
                  bytes,
                  offset,
                  Math.min(65_536, bytes.length - offset),
                  offset,
                );
                if (read.bytesRead === 0) throw new ExtensionInputError("package-input-changed");
                offset += read.bytesRead;
              }
              const after = await handle.stat({ bigint: true });
              const current = await lstat(hostPath, { bigint: true });
              if (
                !same(opened, after) ||
                !same(opened, current) ||
                (await realpath(hostPath)) !== join(physicalRoot, raw)
              )
                throw new ExtensionInputError("package-input-changed");
              total += bytes.length;
              observations.push({
                path: hostPath,
                physical: join(physicalRoot, raw),
                stat: opened,
              });
              files.push({ path, bytes });
            } finally {
              await handle.close();
            }
          }
          if (
            !same(before, await lstat(directoryPath, { bigint: true })) ||
            (await realpath(directoryPath)) !== join(physicalRoot, relative)
          )
            throw new ExtensionInputError("package-input-changed");
        };
        await walk("", 0);
        for (const observation of observations) {
          guard();
          if (
            !same(observation.stat, await lstat(observation.path, { bigint: true })) ||
            (await realpath(observation.path)) !== observation.physical
          )
            throw new ExtensionInputError("package-input-changed");
        }
        guard();
        return {
          sourceId: bytesDigest(physicalRoot),
          ownership: {
            sourceOwner: bytesDigest(
              `${rootStat.dev}:${rootStat.ino}:${rootStat.uid}:${rootStat.gid}`,
            ),
            publisher: null,
          },
          files,
          diagnostics,
          omittedDiagnostics,
        };
      } catch (error) {
        if (error instanceof ExtensionInputError) throw error;
        throw new ExtensionInputError("package-read-failed");
      }
    },
  };
}

function same(
  a: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  b: typeof a,
): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
