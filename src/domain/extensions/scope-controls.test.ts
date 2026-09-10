import { expect, test } from "bun:test";
import { bytesDigest } from "./canonical.ts";
import { catalogFixture } from "./catalog-fixtures.ts";
import { type ScopeControl, scopeControlSchema } from "./scope-controls.ts";

test("compact aliases use the catalog spelling and reject canonical duplicates", () => {
  const entry = catalogFixture();
  if (entry.source.kind !== "package") throw new Error("fixture-package");
  const record: ScopeControl = {
    version: 1,
    actor: bytesDigest("actor"),
    authority: { scope: "user", id: bytesDigest("actor"), generation: 1 },
    scopeBinding: bytesDigest("scope-binding"),
    package: entry.source.owner,
    compatibilityHost: bytesDigest("inspection-host"),
    installedRevision: 1,
    revision: 1,
    choice: { enabled: true, preferred: false, explicitOnly: false },
    contributions: [
      {
        identity: entry.contribution,
        aliases: ["e\u0301"],
        family: "read",
        effects: ["observation"],
        compatibility: "compatible",
      },
    ],
    overrides: [],
  };
  expect(scopeControlSchema.parse(record).contributions[0]?.aliases).toEqual(["é"]);
  const contribution = record.contributions[0];
  if (contribution === undefined) throw new Error("fixture-contribution");
  expect(
    scopeControlSchema.safeParse({
      ...record,
      contributions: [{ ...contribution, aliases: ["e\u0301", "é"] }],
    }).success,
  ).toBe(false);
});
