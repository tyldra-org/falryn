import { expect, test } from "bun:test";
import { sourceFixture, sourceScope } from "../../domain/context/instruction-sources.fixtures.ts";
import {
  EMPTY_SOURCE_PREFERENCES,
  type InstructionSource,
} from "../../domain/context/instruction-sources.ts";
import {
  estimatePromptTokens,
  PROMPT_TOKEN_ESTIMATOR,
} from "../../domain/context/prompt-composition.ts";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { createInstructionSourceOwner } from "./instruction-source-owner.ts";

/** A skill source whose body is the marker text; descriptions are its routing evidence. */
function skill(
  name: string,
  description: string,
  overrides: Partial<InstructionSource> = {},
): { source: InstructionSource; body: Uint8Array } {
  const body = new TextEncoder().encode(`BODY_${name}_${overrides.origin ?? "project-agents"}`);
  const path = `.agents/skills/${name}/SKILL.md`;
  return {
    body,
    source: sourceFixture(path, {
      identity: {
        version: 1,
        kind: "skill",
        root: "workspace",
        path: overrides.origin?.startsWith("user-") ? `user/${path}` : path,
        namespace: "skills",
        localId: name,
      },
      digest: bytesDigest(body),
      summary: description,
      ...overrides,
    }),
  };
}

function owner(skills: readonly ReturnType<typeof skill>[]) {
  const reads: string[] = [];
  const bodies = new Map(skills.map((item) => [item.source.digest, item.body]));
  const prepared = createInstructionSourceOwner({
    async scan(signal) {
      signal.throwIfAborted();
      return {
        configuration: "1",
        workspace: "workspace",
        sources: skills.map((item) => item.source),
        preferences: EMPTY_SOURCE_PREFERENCES,
      };
    },
    async read(source, signal) {
      signal.throwIfAborted();
      reads.push(source.identity.localId);
      const body = bodies.get(source.digest);
      if (!body) throw new Error("source-missing");
      return body;
    },
    async current() {
      return true;
    },
  });
  const prepare = (
    task: string,
    active: readonly string[] = [],
    signal?: AbortSignal,
    explicit?: readonly string[],
  ) =>
    prepared.prepare(sourceScope, [], signal, undefined, false, {
      task,
      active,
      ...(explicit === undefined ? {} : { explicit }),
    });
  return { prepare, reads, bodies, owner: prepared };
}

test("routing loads only the selected skill's complete body and records its admission", async () => {
  const f = owner([
    skill("release-notes", "Draft release notes from merged pull requests."),
    skill("incident", "Write an incident postmortem."),
  ]);
  const prepared = await f.prepare("Use release-notes for v2");
  if (!prepared.ok) throw new Error(prepared.code);
  expect(f.reads).toEqual(["release-notes"]);
  const bodies = prepared.binding.sections.map((section) => section.content).join("\n");
  expect(bodies).toContain("BODY_release-notes_project-agents");
  expect(bodies).not.toContain("BODY_incident");
  expect(prepared.binding.sections[0]?.id).toBe("skill-routing");
  const routing = prepared.binding.sections[0]?.content ?? "";
  const listing = "release-notes (named-in-task)";
  expect(prepared.binding.receipt.skills).toEqual({
    candidates: 2,
    routes: [
      {
        name: "release-notes",
        decision: "loaded",
        reason: "named-in-task",
        source: expect.stringMatching(/^sha256:/),
        digest: bytesDigest(new TextEncoder().encode("BODY_release-notes_project-agents")),
        bytes: "BODY_release-notes_project-agents".length,
        tokens: estimatePromptTokens("BODY_release-notes_project-agents"),
        listing: { bytes: listing.length, tokens: estimatePromptTokens(listing) },
      },
    ],
    // The shared section, with header text no route owns, is recorded once.
    section: { bytes: routing.length, tokens: estimatePromptTokens(routing) },
    estimator: PROMPT_TOKEN_ESTIMATOR,
  });
  expect(routing).toContain(listing);
});

test("an ambiguous or ineligible automatic pick is omitted with its reason, never failing the turn", async () => {
  const tied = [
    skill("release-notes", "Draft release notes."),
    skill("release-notes", "Draft release notes.", {
      identity: {
        version: 1,
        kind: "skill",
        root: "workspace",
        path: ".agents/skills/release-notes-copy/SKILL.md",
        namespace: "skills",
        localId: "release-notes",
      },
    }),
  ];
  const f = owner(tied);
  const prepared = await f.prepare("Use release-notes");
  if (!prepared.ok) throw new Error(prepared.code);
  expect(f.reads).toEqual([]);
  expect(prepared.binding.receipt.skills?.routes).toEqual([
    expect.objectContaining({
      name: "release-notes",
      decision: "unavailable",
      reason: "ambiguous-source",
    }),
  ]);
  expect(prepared.binding.sections[0]?.content).toContain(
    "Relevant but unavailable: release-notes",
  );
  // Manual-only and restricted skills never reach routing, descriptions or reads.
  const manual = owner([
    skill("deploy", "Deploy the service.", { eligibility: { user: true, automatic: false } }),
  ]);
  const refused = await manual.prepare("Use deploy now");
  if (!refused.ok) throw new Error(refused.code);
  expect(manual.reads).toEqual([]);
  expect(refused.binding.receipt.skills).toEqual({
    candidates: 0,
    routes: [],
    section: null,
    estimator: PROMPT_TOKEN_ESTIMATOR,
  });
  expect(JSON.stringify(refused.binding.sections)).not.toContain("Deploy the service");
});

test("the higher-priority same-name skill wins and session activation outlives the prompt", async () => {
  const f = owner([
    skill("release-notes", "Draft release notes.", { origin: "user-agents" }),
    skill("release-notes", "Draft release notes.", { origin: "project-falryn" }),
  ]);
  const named = await f.prepare("Use release-notes");
  if (!named.ok) throw new Error(named.code);
  expect(f.reads).toEqual(["release-notes"]);
  const text = named.binding.sections.map((section) => section.content).join("\n");
  expect(text).toContain("BODY_release-notes_project-falryn");
  expect(text).not.toContain("BODY_release-notes_user-agents");
  expect(named.binding.receipt.sources.find((item) => item.origin === "user-agents")?.state).toBe(
    "shadowed",
  );
  const later = await f.prepare("Fix the build", ["release-notes"]);
  if (!later.ok) throw new Error(later.code);
  expect(later.binding.receipt.skills?.routes).toEqual([
    expect.objectContaining({
      name: "release-notes",
      decision: "loaded",
      reason: "session-active",
    }),
  ]);
});

test("cancellation before admission reads no skill body", async () => {
  const f = owner([skill("release-notes", "Draft release notes.")]);
  const controller = new AbortController();
  controller.abort();
  const prepared = await f.prepare("Use release-notes", [], controller.signal);
  expect(prepared).toMatchObject({ ok: false, code: "cancelled" });
  expect(f.reads).toEqual([]);
});

test("an explicit pick is refused on a tie or a changed body, and nothing else is read", async () => {
  const tied = owner([
    skill("release-notes", "Draft release notes."),
    skill("release-notes", "Draft release notes.", {
      identity: {
        version: 1,
        kind: "skill",
        root: "workspace",
        path: ".agents/skills/release-notes-copy/SKILL.md",
        namespace: "skills",
        localId: "release-notes",
      },
    }),
    skill("incident", "Write an incident postmortem."),
  ]);
  const refused = await tied.prepare("Summarize incident", [], undefined, ["release-notes"]);
  expect(refused.ok).toBe(false);
  expect(tied.reads).toEqual([]);

  const changing = skill("release-notes", "Draft release notes.");
  const changed = owner([changing]);
  changed.bodies.set(changing.source.digest, new TextEncoder().encode("BODY_tampered"));
  const stale = await changed.prepare("Anything", [], undefined, ["release-notes"]);
  expect(stale.ok).toBe(false);

  const manual = owner([
    skill("deploy", "Deploy the service.", { eligibility: { user: true, automatic: false } }),
  ]);
  const loaded = await manual.prepare("Ship it", [], undefined, ["deploy"]);
  if (!loaded.ok) throw new Error(loaded.code);
  expect(manual.reads).toEqual(["deploy"]);
  expect(loaded.binding.receipt.skills?.routes).toEqual([
    expect.objectContaining({ name: "deploy", decision: "loaded", reason: "explicit-invocation" }),
  ]);
});

test("the catalog lists every skill with its state and command, without reading a body", async () => {
  const f = owner([
    skill("release-notes", "Draft release notes.", { origin: "user-agents" }),
    skill("release-notes", "Draft release notes.", { origin: "project-falryn" }),
    skill("triage", "Triage issues.", { eligibility: { user: false, automatic: true } }),
  ]);
  expect(f.owner.skillCatalog(sourceScope)).toBeNull();
  const prepared = await f.prepare("Fix the build");
  if (!prepared.ok) throw new Error(prepared.code);
  const readsBefore = f.reads.length;
  expect([...f.owner.skillNames()].sort()).toEqual(["release-notes", "triage"]);
  const page = f.owner.skillCatalog(sourceScope);
  expect(page?.total).toBe(3);
  expect(page?.nextOffset).toBeNull();
  const entries = page?.entries ?? [];
  expect(entries.find((item) => item.origin === "project-falryn")).toMatchObject({
    name: "release-notes",
    state: "selected",
    command: "/skill:release-notes",
  });
  expect(entries.find((item) => item.origin === "user-agents")).toMatchObject({
    state: "shadowed",
    command: null,
  });
  expect(entries.find((item) => item.name === "triage")).toMatchObject({
    userInvocable: false,
    command: null,
  });
  expect(
    f.owner.skillCatalog(sourceScope, { filter: "tri" })?.entries.map((item) => item.name),
  ).toEqual(["triage"]);
  expect(() => f.owner.skillCatalog(sourceScope, { offset: -1 })).toThrow("invalid-skill-cursor");
  expect(f.reads.length).toBe(readsBefore);
});
