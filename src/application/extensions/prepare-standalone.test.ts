import { expect, test } from "bun:test";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import type { StandaloneSourceOwnerV1 } from "../../domain/extensions/identity.ts";
import { prepareStandaloneSource } from "./prepare-standalone.ts";

test("standalone content and provenance changes invalidate exact source ownership", () => {
  const owner = {
    sourceCoordinate: {
      kind: "local" as const,
      rootId: "workspace",
      path: "review.md",
      sourceDigest: bytesDigest("source"),
    },
    scope: "workspace" as const,
    scopeAuthorityId: "workspace",
    scopeAuthorityGeneration: 1,
    catalogGeneration: 1,
  };
  const bytes = new TextEncoder().encode("---\ndescription: Review\n---\nprivate instructions");
  const input = {
    kind: "prompt" as const,
    id: "review",
    namespace: "user",
    bytes,
    provenance: { selected: "user" },
    owner,
  };
  const result = prepareStandaloneSource(input);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.identity.owner.kind).toBe("standalone");
  expect(result.state).toBe("declared");
  for (const changed of [
    { ...input, bytes: new TextEncoder().encode("changed") },
    { ...input, provenance: { selected: "project" } },
    { ...input, owner: { ...owner, catalogGeneration: 2 } },
  ]) {
    const next = prepareStandaloneSource(changed);
    expect(next.ok && next.identityDigest).not.toBe(result.identityDigest);
  }
  for (const kind of ["skill", "mcp-connection"] as const) {
    const content =
      kind === "skill"
        ? "---\nname: review\ndescription: Review\n---\n"
        : JSON.stringify({ type: "stdio", command: "node" });
    expect(
      prepareStandaloneSource({ ...input, kind, bytes: new TextEncoder().encode(content) }).ok,
    ).toBe(true);
  }
  expect(
    prepareStandaloneSource({ ...input, kind: "tool" as StandaloneSourceOwnerV1["kind"] }).ok,
  ).toBe(false);
});
