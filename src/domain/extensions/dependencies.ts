/** Finite-inventory dependency resolution. No registry, installation, or network authority. */
import { compareBuild, satisfies, validRange } from "semver";
import { z } from "zod";
import { canonicalDigest, freezeMetadata } from "./canonical.ts";
import { digestSchema, exactVersionSchema, identityText } from "./identity.ts";

export const versionRangeSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => validRange(value) !== null);
export const dependencySchema = z.strictObject({
  id: identityText,
  range: versionRangeSchema,
  optional: z.boolean().default(false),
});
export const dependencyCandidateSchema = z.strictObject({
  id: identityText,
  packageVersion: exactVersionSchema,
  digest: digestSchema,
  dependencies: z.array(dependencySchema).max(256).default([]),
});
export type PackageDependency = z.infer<typeof dependencySchema>;
export type DependencyCandidate = z.infer<typeof dependencyCandidateSchema>;
export type DependencyResolution =
  | {
      readonly ok: true;
      readonly lock: readonly DependencyCandidate[];
      readonly degraded: readonly string[];
      readonly digest: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | "invalid-dependencies"
        | "ambiguous-package"
        | "dependency-conflict"
        | "dependency-cycle"
        | "dependency-limit"
        | "cancelled";
    };

export function resolvePackageDependencies(input: {
  readonly requirements: readonly PackageDependency[];
  readonly candidates: readonly DependencyCandidate[];
  readonly locked?: readonly { readonly id: string; readonly digest: string }[];
  readonly signal?: AbortSignal;
}): DependencyResolution {
  const parsed = z
    .strictObject({
      requirements: z.array(dependencySchema).max(256),
      candidates: z.array(dependencyCandidateSchema).max(256),
      locked: z
        .array(z.strictObject({ id: identityText, digest: digestSchema }))
        .max(256)
        .optional(),
    })
    .safeParse({
      requirements: input.requirements,
      candidates: input.candidates,
      ...(input.locked === undefined ? {} : { locked: input.locked }),
    });
  if (!parsed.success) return { ok: false, code: "invalid-dependencies" };
  const { requirements, candidates } = parsed.data;
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.id, candidate.packageVersion]);
    if (seen.has(key)) return { ok: false, code: "ambiguous-package" };
    seen.add(key);
  }
  const locks = new Map<string, string>();
  for (const lock of parsed.data.locked ?? []) {
    if (locks.has(lock.id)) return { ok: false, code: "ambiguous-package" };
    locks.set(lock.id, lock.digest);
  }
  let decisions = 0;
  let failure: Extract<DependencyResolution, { ok: false }>["code"] = "dependency-conflict";
  const search = (
    selected: Map<string, DependencyCandidate>,
    ignored: Set<string>,
    depth: number,
  ): { lock: DependencyCandidate[]; degraded: string[] } | null => {
    if (input.signal?.aborted) {
      failure = "cancelled";
      return null;
    }
    if (++decisions > 10_000 || depth > 512) {
      failure = "dependency-limit";
      return null;
    }
    const all = [...requirements, ...[...selected.values()].flatMap((value) => value.dependencies)];
    const grouped = new Map<string, PackageDependency[]>();
    for (const dependency of all)
      grouped.set(dependency.id, [...(grouped.get(dependency.id) ?? []), dependency]);
    for (const [id, constraints] of [...grouped].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const required = constraints.filter((entry) => !entry.optional);
      const effective = required.length === 0 ? constraints : required;
      if (required.length === 0 && ignored.has(id)) continue;
      const current = selected.get(id);
      if (current !== undefined) {
        if (!effective.every((entry) => satisfies(current.packageVersion, entry.range)))
          return null;
        continue;
      }
      const matching = candidates
        .filter(
          (entry) =>
            entry.id === id &&
            effective.every((constraint) => satisfies(entry.packageVersion, constraint.range)) &&
            (!locks.has(id) || locks.get(id) === entry.digest),
        )
        .sort(
          (a, b) =>
            compareBuild(b.packageVersion, a.packageVersion) || (a.digest < b.digest ? -1 : 1),
        );
      for (const candidate of matching) {
        const next = new Map(selected).set(id, candidate);
        const found = search(next, ignored, depth + 1);
        if (found !== null) return found;
        if (failure === "dependency-limit" || failure === "cancelled") return null;
      }
      if (required.length === 0 && !locks.has(id))
        return search(selected, new Set([...ignored, id]), depth + 1);
      return null;
    }
    if ([...locks.keys()].some((id) => !selected.has(id))) return null;
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const heights = new Map<string, number>();
    const lock: DependencyCandidate[] = [];
    const order = (id: string, level: number): boolean => {
      if (level > 32) {
        failure = "dependency-limit";
        return false;
      }
      if (visiting.has(id)) {
        failure = "dependency-cycle";
        return false;
      }
      if (visited.has(id)) return true;
      const candidate = selected.get(id);
      if (candidate === undefined) return true;
      visiting.add(id);
      for (const dep of [...candidate.dependencies].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const target = selected.get(dep.id);
        if (
          target !== undefined &&
          satisfies(target.packageVersion, dep.range) &&
          !order(dep.id, level + 1)
        )
          return false;
      }
      visiting.delete(id);
      const height = Math.max(
        0,
        ...candidate.dependencies
          .filter((dependency) => {
            const target = selected.get(dependency.id);
            return target !== undefined && satisfies(target.packageVersion, dependency.range);
          })
          .map((dependency) => 1 + (heights.get(dependency.id) ?? 0)),
      );
      if (height > 32) {
        failure = "dependency-limit";
        return false;
      }
      heights.set(id, height);
      visited.add(id);
      lock.push(candidate);
      return true;
    };
    for (const id of [...selected.keys()].sort()) if (!order(id, 0)) return null;
    const degraded = [
      ...new Set(
        all
          .filter(
            (dep) =>
              dep.optional &&
              (!selected.has(dep.id) ||
                !satisfies(selected.get(dep.id)?.packageVersion ?? "", dep.range)),
          )
          .map((dep) => dep.id),
      ),
    ].sort();
    return { lock, degraded };
  };
  const found = search(new Map(), new Set(), 0);
  if (found === null) return { ok: false, code: failure };
  try {
    return freezeMetadata({ ok: true, ...found, digest: canonicalDigest(found) });
  } catch {
    return { ok: false, code: "dependency-limit" };
  }
}
