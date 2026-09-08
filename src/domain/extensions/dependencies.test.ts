import { expect, test } from "bun:test";
import { bytesDigest } from "./canonical.ts";
import { type DependencyCandidate, resolvePackageDependencies } from "./dependencies.ts";

const dep = (id: string, range = "*", optional = false) => ({ id, range, optional });

test("bounds graph depth independently of root count and visitation order", () => {
  const candidates = Array.from({ length: 100 }, (_, index) =>
    candidate(`p${String(index).padStart(3, "0")}`, "1.0.0"),
  );
  expect(
    resolvePackageDependencies({
      requirements: candidates.map((entry) => dep(entry.id)),
      candidates,
    }).ok,
  ).toBe(true);
  const chain = candidates.slice(0, 35).map((entry, index) => ({
    ...entry,
    dependencies: index === 0 ? [] : [dep(`p${String(index - 1).padStart(3, "0")}`)],
  }));
  expect(
    resolvePackageDependencies({
      requirements: chain.map((entry) => dep(entry.id)),
      candidates: chain,
    }),
  ).toEqual({ ok: false, code: "dependency-limit" });
});
const candidate = (
  id: string,
  packageVersion: string,
  dependencies: DependencyCandidate["dependencies"] = [],
): DependencyCandidate => ({
  id,
  packageVersion,
  dependencies,
  digest: bytesDigest(`${id}@${packageVersion}`),
});
test("backtracks a diamond and orders dependencies before consumers", () => {
  const result = resolvePackageDependencies({
    requirements: [dep("a"), dep("b")],
    candidates: [
      candidate("a", "2.0.0", [dep("c", "^2")]),
      candidate("a", "1.0.0", [dep("c", "^1")]),
      candidate("b", "1.0.0", [dep("c", "<2")]),
      candidate("c", "1.5.0"),
      candidate("c", "2.0.0"),
    ],
  });
  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.lock.map((entry) => `${entry.id}@${entry.packageVersion}`)).toEqual([
      "c@1.5.0",
      "a@1.0.0",
      "b@1.0.0",
    ]);
});
test("prerelease requires opt-in and build metadata remains an exact identity", () => {
  const candidates = [
    candidate("a", "1.0.0+one"),
    candidate("a", "1.0.0+two"),
    candidate("a", "2.0.0-beta.1"),
  ];
  const stable = resolvePackageDependencies({ requirements: [dep("a")], candidates });
  expect(stable.ok && stable.lock[0]?.packageVersion).toBe("1.0.0+two");
  const beta = resolvePackageDependencies({
    requirements: [dep("a", ">=2.0.0-beta.1")],
    candidates,
  });
  expect(beta.ok && beta.lock[0]?.packageVersion).toBe("2.0.0-beta.1");
  const locked = resolvePackageDependencies({
    requirements: [dep("a")],
    candidates,
    locked: [{ id: "a", digest: candidates[0]?.digest ?? "" }],
  });
  expect(locked.ok && locked.lock[0]?.packageVersion).toBe("1.0.0+one");
});
test("cycles, conflicting ranges, locks, and duplicate identities fail explicitly", () => {
  expect(
    resolvePackageDependencies({
      requirements: [dep("a")],
      candidates: [candidate("a", "1.0.0", [dep("b")]), candidate("b", "1.0.0", [dep("a")])],
    }),
  ).toEqual({ ok: false, code: "dependency-cycle" });
  expect(
    resolvePackageDependencies({
      requirements: [dep("a", "^1"), dep("a", "^2")],
      candidates: [candidate("a", "1.0.0")],
    }).ok,
  ).toBe(false);
  expect(
    resolvePackageDependencies({
      requirements: [dep("a")],
      candidates: [candidate("a", "1.0.0"), candidate("a", "1.0.0")],
    }),
  ).toEqual({ ok: false, code: "ambiguous-package" });
  expect(
    resolvePackageDependencies({
      requirements: [],
      candidates: [],
      locked: [{ id: "missing", digest: bytesDigest("") }],
    }).ok,
  ).toBe(false);
});
test("optional absence is degradation and cancellation is not success", () => {
  expect(
    resolvePackageDependencies({ requirements: [dep("missing", "*", true)], candidates: [] }),
  ).toMatchObject({ ok: true, lock: [], degraded: ["missing"] });
  expect(
    resolvePackageDependencies({ requirements: [], candidates: [], signal: AbortSignal.abort() }),
  ).toEqual({ ok: false, code: "cancelled" });
});
