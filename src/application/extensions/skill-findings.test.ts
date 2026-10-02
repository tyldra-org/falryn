import { expect, test } from "bun:test";
import { sourceFixture, sourceScope } from "../../domain/context/instruction-sources.fixtures.ts";
import {
  EMPTY_SOURCE_PREFERENCES,
  type InstructionSource,
  instructionSourceKey,
} from "../../domain/context/instruction-sources.ts";
import type { SkillReferenceState, SkillScanFacts } from "../../domain/context/skill-findings.ts";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { createInstructionSourceOwner } from "../context/instruction-source-owner.ts";
import { createSkillFindings, refusalKey, type SkillRefusalHistory } from "./skill-findings.ts";

const scope = { root: sourceScope.root, directory: sourceScope.directory, kind: sourceScope.kind };

function skill(name: string, path: string, overrides: Partial<InstructionSource> = {}) {
  const body = new TextEncoder().encode(`BODY ${path}`);
  return sourceFixture(path, {
    identity: {
      version: 1,
      kind: "skill",
      root: "workspace",
      path,
      namespace: "skills",
      localId: name,
    },
    digest: bytesDigest(body),
    summary: `Skill ${name}`,
    ...overrides,
  });
}

/** The real owner and resolver over sources a test controls; nothing is ever read. */
function fixture(initial: InstructionSource[]) {
  let sources = initial;
  const reads: string[] = [];
  const owner = createInstructionSourceOwner({
    async scan(signal) {
      signal.throwIfAborted();
      return {
        configuration: "1",
        workspace: "workspace",
        sources,
        preferences: EMPTY_SOURCE_PREFERENCES,
      };
    },
    async read(source) {
      reads.push(source.identity.path);
      throw new Error("source-missing");
    },
    async current() {
      return true;
    },
  });
  const facts = new Map<string, SkillScanFacts>();
  const states = new Map<string, SkillReferenceState>();
  let onReference: (() => Promise<void>) | null = null;
  let refusals: ((signal: AbortSignal) => Promise<SkillRefusalHistory>) | undefined;
  const findings = createSkillFindings({
    owner,
    scope,
    diagnostics: {
      facts: (key) => facts.get(key) ?? null,
      async reference(_key, link) {
        await onReference?.();
        return states.get(link) ?? "present";
      },
    },
    mcpServers: () => new Set(["github"]),
    refusals: (signal) =>
      refusals?.(signal) ?? Promise.resolve({ ok: true, refusals: new Map(), complete: true }),
  });
  return {
    owner,
    findings,
    facts,
    states,
    reads,
    replace(next: InstructionSource[]) {
      sources = next;
    },
    onReference(run: (() => Promise<void>) | null) {
      onReference = run;
    },
    refusals(run: (signal: AbortSignal) => Promise<SkillRefusalHistory>) {
      refusals = run;
    },
  };
}

const factsFor = (source: InstructionSource, links: string[] = []): SkillScanFacts => ({
  digest: source.digest ?? "",
  bytes: 64,
  field: null,
  links,
  mcpServers: [],
});

test("a missing publication is reported unavailable, never as healthy", async () => {
  const f = fixture([skill("lint", ".agents/skills/lint/SKILL.md")]);
  expect(await f.findings.collect(new AbortController().signal)).toEqual({
    status: "unavailable",
    code: "discovery-unavailable",
  });
});

test("equal-priority duplicates conflict, and a lower-priority copy is shadowed by name", async () => {
  // Conventional discovery cannot produce equal-priority duplicates today (a name must match
  // its directory, and each location has its own priority), so the resolver gets them directly.
  const first = skill("release-notes", ".agents/skills/release-notes/SKILL.md");
  const second = skill("release-notes", ".agents/skills/release-notes-copy/SKILL.md");
  const user = skill("lint", "user/.agents/skills/lint/SKILL.md", { origin: "user-agents" });
  const project = skill("lint", ".agents/skills/lint/SKILL.md");
  const f = fixture([first, second, user, project]);
  await f.findings.refresh(new AbortController().signal);
  const collected = await f.findings.collect(new AbortController().signal);
  if (collected.status !== "collected") throw new Error(collected.code);
  const byPath = new Map(collected.entries.map((entry) => [entry.path, entry]));
  for (const path of [first.identity.path, second.identity.path])
    expect(byPath.get(path)?.findings).toEqual([
      expect.objectContaining({
        code: "name-conflict",
        severity: "warning",
        evidence: { reason: expect.any(String), sources: 2 },
        fix: "Choose one source in instructions.preferences, or rename one of the skills.",
      }),
    ]);
  expect(byPath.get(user.identity.path)?.findings).toEqual([
    expect.objectContaining({
      code: "shadowed",
      severity: "info",
      evidence: {
        winner: instructionSourceKey(project.identity),
        winnerOrigin: "project-agents",
        winnerPath: project.identity.path,
      },
    }),
  ]);
  expect(byPath.get(project.identity.path)?.findings).toEqual([]);
  expect(collected.complete).toBe(true);
  // Findings read no skill body.
  expect(f.reads).toEqual([]);
});

test("a reload publishing during link checks leaves one consistent generation", async () => {
  const lint = skill("lint", ".agents/skills/lint/SKILL.md");
  const f = fixture([lint]);
  f.facts.set(instructionSourceKey(lint.identity), factsFor(lint, ["references/a.md"]));
  f.states.set("references/a.md", "missing");
  await f.findings.refresh(new AbortController().signal);
  const before = f.owner.snapshot()?.generation;
  const renamed = skill("format", ".agents/skills/format/SKILL.md");
  f.onReference(async () => {
    f.onReference(null);
    f.replace([renamed]);
    await f.findings.refresh(new AbortController().signal);
  });
  const collected = await f.findings.collect(new AbortController().signal);
  if (collected.status !== "collected") throw new Error(collected.code);
  const after = f.owner.snapshot()?.generation;
  expect(after).not.toBe(before);
  // Every entry belongs to the generation that was current when collection began.
  expect(collected.generation).toBe(before ?? "");
  expect(
    collected.entries.map((entry) => [entry.name, entry.findings.map((item) => item.code)]),
  ).toEqual([["lint", ["reference-missing"]]]);
  // The next collection derives the new generation from scratch.
  const next = await f.findings.collect(new AbortController().signal);
  if (next.status !== "collected") throw new Error(next.code);
  expect(next.generation).toBe(after ?? "");
  expect(next.entries.map((entry) => entry.name)).toEqual(["format"]);
});

test("cancelling link checks returns labelled partial findings, never complete health", async () => {
  const lint = skill("lint", ".agents/skills/lint/SKILL.md");
  const f = fixture([lint]);
  f.facts.set(
    instructionSourceKey(lint.identity),
    factsFor(lint, ["references/a.md", "references/b.md", "references/c.md"]),
  );
  f.states.set("references/a.md", "missing");
  await f.findings.refresh(new AbortController().signal);
  const controller = new AbortController();
  f.onReference(async () => {
    f.onReference(null);
    controller.abort();
  });
  const collected = await f.findings.collect(controller.signal);
  if (collected.status !== "collected") throw new Error(collected.code);
  expect(collected.complete).toBe(false);
  expect(collected.omissions).toEqual(["references-unchecked:2", "cancelled"]);
  expect(collected.entries[0]?.findings.map((item) => item.code)).toEqual(["reference-missing"]);
});

test("facts recorded for other content are never applied", async () => {
  const lint = skill("lint", ".agents/skills/lint/SKILL.md");
  const f = fixture([lint]);
  f.facts.set(instructionSourceKey(lint.identity), {
    ...factsFor(lint, ["missing.md"]),
    digest: bytesDigest(new TextEncoder().encode("older content")),
  });
  f.states.set("missing.md", "missing");
  await f.findings.refresh(new AbortController().signal);
  const collected = await f.findings.collect(new AbortController().signal);
  expect(collected.status === "collected" && collected.entries[0]?.findings).toEqual([]);
});

test("recorded refusals of the exact content are activation failures; unreadable history is an omission", async () => {
  const lint = skill("lint", ".agents/skills/lint/SKILL.md");
  const f = fixture([lint]);
  await f.findings.refresh(new AbortController().signal);
  const key = refusalKey(instructionSourceKey(lint.identity), lint.digest ?? "");
  f.refusals(async () => ({
    ok: true,
    refusals: new Map([[key, { "skill-changed": 2 }]]),
    complete: true,
  }));
  const refused = await f.findings.collect(new AbortController().signal);
  expect(refused.status === "collected" && refused.entries[0]?.findings).toEqual([
    expect.objectContaining({
      code: "activation-failed",
      severity: "error",
      evidence: { reason: "skill-changed", count: 2, recorded: "admission" },
    }),
  ]);
  f.refusals(async () => ({ ok: false, code: "admission-history-unavailable" }));
  const unread = await f.findings.collect(new AbortController().signal);
  expect(unread.status === "collected" && [unread.complete, unread.omissions]).toEqual([
    false,
    ["admission-history-unavailable"],
  ]);
});
