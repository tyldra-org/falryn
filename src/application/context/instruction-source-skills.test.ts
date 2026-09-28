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
  const prepare = (task: string, active: readonly string[] = [], signal?: AbortSignal) =>
    prepared.prepare(sourceScope, [], signal, undefined, false, { task, active });
  return { prepare, reads };
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
