import { describe, expect, test } from "bun:test";
import { sourceFixture, sourceScope } from "./instruction-sources.fixtures.ts";
import {
  EMPTY_SOURCE_PREFERENCES,
  instructionSourceKey,
  resolveInstructionSources,
  sourcePreferencesSchema,
} from "./instruction-sources.ts";

describe("source choice and instruction authority", () => {
  test("orders compatible instructions without promoting project authority or leaking roots", () => {
    const global = sourceFixture("AGENTS.md", { origin: "user-falryn" });
    const root = sourceFixture("FALRYN.md", { origin: "project-falryn" });
    const nested = sourceFixture("src/AGENTS.md", { scope: "src" });
    const foreign = sourceFixture("elsewhere/AGENTS.md", { scope: "elsewhere" });
    const result = resolveInstructionSources({
      sources: [nested, root, global, foreign],
      scope: sourceScope,
      preferences: EMPTY_SOURCE_PREFERENCES,
    });
    expect(result.selected).toEqual([global, root, nested]);
    expect(
      result.decisions.find((item) => item.source === instructionSourceKey(foreign.identity))
        ?.reason,
    ).toBe("outside-execution-scope");
  });
  test("missing, disabled and revoked explicit preferences never choose alternatives", () => {
    const preferred = sourceFixture("AGENTS.md");
    const alternate = sourceFixture("FALRYN.md");
    const preferences = {
      ...EMPTY_SOURCE_PREFERENCES,
      choices: [
        {
          kind: "instruction" as const,
          name: "workspace:",
          source: instructionSourceKey(preferred.identity),
        },
      ],
    };
    for (const sources of [
      [alternate],
      [alternate, { ...preferred, enabled: false }],
      [alternate, { ...preferred, trusted: false }],
    ]) {
      const result = resolveInstructionSources({ sources, scope: sourceScope, preferences });
      expect(result.selected).toEqual([]);
      expect(result.unavailable).toHaveLength(1);
    }
  });
  test("preferences remain attached to source identity across content revisions", () => {
    const old = sourceFixture("AGENTS.md");
    const updated = { ...old, digest: sourceFixture("different content").digest };
    expect(instructionSourceKey(old.identity)).toBe(instructionSourceKey(updated.identity));
    const moved = { ...old, identity: { ...old.identity, root: "moved" } };
    expect(instructionSourceKey(old.identity)).not.toBe(instructionSourceKey(moved.identity));
  });
  test("equal-priority skill collisions require a choice and retain shadowed alternatives", () => {
    const a = sourceFixture("a/SKILL.md");
    a.identity = { ...a.identity, kind: "skill", localId: "review" };
    const b = sourceFixture("b/SKILL.md");
    b.identity = { ...b.identity, kind: "skill", localId: "review" };
    const selections = [{ kind: "skill" as const, name: "review", origin: "user" as const }];
    const ambiguous = resolveInstructionSources({
      sources: [a, b],
      scope: sourceScope,
      preferences: EMPTY_SOURCE_PREFERENCES,
      selections,
    });
    expect(ambiguous.selected).toEqual([]);
    expect(ambiguous.decisions.every((item) => item.state === "conflicting")).toBe(true);
    const chosen = resolveInstructionSources({
      sources: [a, b],
      scope: sourceScope,
      preferences: {
        ...EMPTY_SOURCE_PREFERENCES,
        choices: [{ kind: "skill", name: "review", source: instructionSourceKey(a.identity) }],
      },
      selections,
    });
    expect(chosen.selected).toEqual([a]);
    expect(chosen.unavailable).toEqual([]);
  });
  test("unknown and deny-only eligibility cannot be overridden by source preference", () => {
    const source = sourceFixture("SKILL.md");
    source.identity = { ...source.identity, kind: "skill", localId: "review" };
    const preferences = {
      ...EMPTY_SOURCE_PREFERENCES,
      choices: [
        { kind: "skill" as const, name: "review", source: instructionSourceKey(source.identity) },
      ],
    };
    for (const eligibility of [null, { user: true, automatic: false }]) {
      const result = resolveInstructionSources({
        sources: [{ ...source, eligibility }],
        scope: sourceScope,
        preferences,
        selections: [{ kind: "skill", name: "review", origin: "automatic" }],
      });
      expect(result.selected).toEqual([]);
      expect(result.unavailable).toHaveLength(1);
    }
  });
  test("picking one skill does not resolve a declared conflict with another active skill", () => {
    const a = sourceFixture("a.md"),
      b = sourceFixture("b.md");
    const result = resolveInstructionSources({
      sources: [{ ...a, conflicts: [instructionSourceKey(b.identity)] }, b],
      scope: sourceScope,
      preferences: EMPTY_SOURCE_PREFERENCES,
    });
    expect(result.unavailable).toContain(
      `instruction-conflict:${instructionSourceKey(a.identity)}`,
    );
  });
  test("rejects duplicate or malformed source-bound controls", () => {
    const item = {
      kind: "skill",
      name: "review",
      source: instructionSourceKey(sourceFixture("a.md").identity),
    };
    expect(
      sourcePreferencesSchema.safeParse({ version: 1, choices: [item, item], restrictions: [] })
        .success,
    ).toBe(false);
    expect(
      sourcePreferencesSchema.safeParse({
        version: 1,
        choices: [],
        restrictions: [{ source: item.source, automatic: "true", user: true }],
      }).success,
    ).toBe(false);
  });
});

test("explicit prompts replace only a same-package native identity, never another package", () => {
  const conventional = sourceFixture("prompts/review.md", { declaration: "conventional" });
  conventional.identity = {
    ...conventional.identity,
    kind: "prompt",
    localId: "review",
    namespace: "one",
  };
  const explicit = {
    ...conventional,
    declaration: "explicit" as const,
    identity: { ...conventional.identity },
  };
  const resolve = (sources: (typeof conventional)[]) =>
    resolveInstructionSources({
      sources,
      scope: sourceScope,
      preferences: EMPTY_SOURCE_PREFERENCES,
      selections: [{ kind: "prompt", name: "review", origin: "user" }],
    });
  expect(resolve([conventional, explicit]).selected).toEqual([explicit]);
  const differentPath = { ...explicit, identity: { ...explicit.identity, path: "custom.md" } };
  expect(resolve([conventional, differentPath]).unavailable).toEqual(["ambiguous-source:review"]);
  const other = { ...explicit, identity: { ...explicit.identity, namespace: "two" } };
  expect(resolve([conventional, explicit, other]).unavailable).toEqual(["ambiguous-source:review"]);
});
