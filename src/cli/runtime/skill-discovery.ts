/**
 * Conventional skill bundles (#136): the immediate directories of one skill location,
 * each with an entrypoint named exactly `SKILL.md`.
 *
 * A symlinked or missing location segment contributes nothing, so nothing outside the
 * admitted root is reached. A symlinked bundle or entrypoint, a non-file entrypoint and a
 * case-insensitive lookalike are reported, never read. A directory without an entrypoint
 * is not a bundle. Supporting files inside a bundle are not discovered here (#137).
 */
import type { DISCOVERY_PROBLEMS } from "../../domain/context/instruction-sources.ts";
import { sourcePathSchema } from "../../domain/context/instruction-sources.ts";
import { type FileSystemPort, joinPath, type LocalPath } from "../../domain/workspace/index.ts";

export const SKILL_ENTRYPOINT = "SKILL.md";
export const SKILL_LOCATIONS = Object.freeze({
  /** Relative to each authorized project root, in default priority order. */
  project: Object.freeze([
    [".falryn/skills", "falryn"],
    [".agents/skills", "agents"],
    [".claude/skills", "claude"],
  ] as const),
  /** Bundles one location may hold; more fails the scan rather than hiding some. */
  bundlesPerLocation: 256,
});

export type DiscoveredSkill = {
  /** The bundle directory's name, which the entrypoint's `name` must equal. */
  readonly bundle: string;
  /** The entrypoint relative to the root it was found under. */
  readonly relative: string;
  readonly path: LocalPath;
  readonly problem: Extract<
    (typeof DISCOVERY_PROBLEMS)[number],
    "unsupported-casing" | "symlink" | "not-a-file"
  > | null;
};

export async function discoverSkillBundles(
  fileSystem: Pick<FileSystemPort, "stat" | "list">,
  root: LocalPath,
  location: string,
  signal: AbortSignal,
): Promise<DiscoveredSkill[]> {
  const segments = location.split("/");
  for (let index = 1; index <= segments.length; index++) {
    signal.throwIfAborted();
    const path = joinPath(root, ...segments.slice(0, index));
    const state = path.ok ? await fileSystem.stat(path.value, signal) : null;
    if (!path.ok || !state?.ok || state.value?.kind !== "directory") return [];
  }
  const directory = joinPath(root, ...segments);
  if (!directory.ok) return [];
  const listed = await fileSystem.list(directory.value, signal);
  if (!listed.ok) return [];
  const bundles = [...listed.value]
    .filter((entry) => entry.kind === "directory" || entry.kind === "symlink")
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (bundles.length > SKILL_LOCATIONS.bundlesPerLocation) throw new Error("skill-location-limit");
  const found: DiscoveredSkill[] = [];
  for (const bundle of bundles) {
    signal.throwIfAborted();
    const name = bundle.path.slice(bundle.path.lastIndexOf("/") + 1);
    const relative = `${location}/${name}/${SKILL_ENTRYPOINT}`;
    // A name the source contract cannot represent is not a source.
    if (!sourcePathSchema.safeParse(relative).success) continue;
    const entrypoint = joinPath(bundle.path, SKILL_ENTRYPOINT);
    if (!entrypoint.ok) continue;
    if (bundle.kind === "symlink") {
      found.push({ bundle: name, relative, path: entrypoint.value, problem: "symlink" });
      continue;
    }
    const entries = await fileSystem.list(bundle.path, signal);
    if (!entries.ok) continue;
    const entry = entries.value.find(
      (item) =>
        item.path.slice(item.path.lastIndexOf("/") + 1).toLowerCase() ===
        SKILL_ENTRYPOINT.toLowerCase(),
    );
    if (entry === undefined) continue;
    const actual = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    found.push({
      bundle: name,
      relative,
      path: entry.path,
      problem:
        actual !== SKILL_ENTRYPOINT
          ? "unsupported-casing"
          : entry.kind === "symlink"
            ? "symlink"
            : entry.kind !== "file"
              ? "not-a-file"
              : null,
    });
  }
  return found;
}
