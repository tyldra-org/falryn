/**
 * Conventional instruction files along admitted ancestor chains (#135).
 *
 * Walks from an admitted root down to each requested directory, one listing per
 * directory, and never above the root. A symlinked, missing or non-directory segment
 * ends that chain, so nothing outside the root is reached. Names match exactly; a
 * case-insensitive lookalike is reported, never loaded, so a case-insensitive file
 * system cannot load one file twice.
 */
import type { DISCOVERY_PROBLEMS } from "../../domain/context/instruction-sources.ts";
import { type FileSystemPort, joinPath, type LocalPath } from "../../domain/workspace/index.ts";

export type DiscoveredInstruction = {
  /** Directory relative to the root; the empty string is the root itself. */
  readonly directory: string;
  /** The entry's actual name. */
  readonly name: string;
  /** The supported name it matches, case-insensitively. */
  readonly matches: string;
  readonly path: LocalPath;
  /** Null when the exact name is a regular file that may be read. */
  readonly problem: Extract<
    (typeof DISCOVERY_PROBLEMS)[number],
    "unsupported-casing" | "symlink" | "not-a-file"
  > | null;
};

/** Every directory from the root down to each requested directory, parents first. */
export function ancestorChains(directories: readonly string[]): string[] {
  const chain = new Set<string>([""]);
  for (const directory of directories) {
    const parts = directory === "" ? [] : directory.split("/");
    for (let index = 1; index <= parts.length; index++) chain.add(parts.slice(0, index).join("/"));
  }
  const depth = (directory: string) => (directory === "" ? 0 : directory.split("/").length);
  return [...chain].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
}

export async function discoverInstructionFiles(
  fileSystem: Pick<FileSystemPort, "stat" | "list">,
  root: LocalPath,
  directories: readonly string[],
  names: readonly string[],
  signal: AbortSignal,
): Promise<DiscoveredInstruction[]> {
  const found: DiscoveredInstruction[] = [];
  const unreachable = new Set<string>();
  for (const directory of ancestorChains(directories)) {
    signal.throwIfAborted();
    const parent = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
    if (directory !== "" && unreachable.has(parent)) {
      unreachable.add(directory);
      continue;
    }
    const path =
      directory === ""
        ? { ok: true as const, value: root }
        : joinPath(root, ...directory.split("/"));
    const state = path.ok ? await fileSystem.stat(path.value, signal) : null;
    // A symlinked or missing segment ends the chain; its descendants are never reached.
    if (!path.ok || !state?.ok || state.value?.kind !== "directory") {
      unreachable.add(directory);
      continue;
    }
    const entries = await fileSystem.list(path.value, signal);
    if (!entries.ok) {
      unreachable.add(directory);
      continue;
    }
    // Parents first (the chain order), then names in a stable order within a directory.
    const ordered = [...entries.value].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    for (const entry of ordered) {
      const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      const matches = names.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      if (!matches) continue;
      found.push({
        directory,
        name,
        matches,
        path: entry.path,
        problem:
          name !== matches
            ? "unsupported-casing"
            : entry.kind === "symlink"
              ? "symlink"
              : entry.kind !== "file"
                ? "not-a-file"
                : null,
      });
    }
  }
  return found;
}
