import { expect, test } from "bun:test";
import {
  deriveSkillFindings,
  pageSkillFindings,
  SKILL_FINDING_CODES,
  SKILL_FINDING_SEVERITY,
  type SkillFindingEntry,
  type SkillFindingInput,
  type SkillScanFacts,
  skillFindingsQuerySchema,
  topFindings,
} from "./skill-findings.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const FACTS: SkillScanFacts = {
  digest: DIGEST,
  bytes: 900_000,
  field: null,
  links: [],
  mcpServers: [],
};
const base = (overrides: Partial<SkillFindingInput> = {}): SkillFindingInput => ({
  entry: {
    name: "lint",
    source: `sha256:${"b".repeat(64)}`,
    origin: "project-falryn",
    path: ".falryn/skills/lint/SKILL.md",
    scope: "",
    state: "selected",
    reason: "selected",
    userInvocable: true,
    automatic: true,
    command: "/skill:lint",
    digest: DIGEST,
  },
  trusted: true,
  problem: null,
  eligibility: { user: true, automatic: true },
  restriction: null,
  winner: null,
  rivals: 0,
  facts: FACTS,
  references: [],
  mcpServers: new Set<string>(),
  refusals: {},
  ...overrides,
});
const codes = (input: SkillFindingInput) =>
  deriveSkillFindings(input).findings.map((item) => item.code);

test("every code has one fixed severity", () => {
  expect(Object.keys(SKILL_FINDING_SEVERITY).sort()).toEqual([...SKILL_FINDING_CODES].sort());
});

test("a healthy skill has no finding, whatever its size", () => {
  const entry = deriveSkillFindings(base());
  expect(entry.findings).toEqual([]);
  // Size is a fact on the entry, never a failure.
  expect(entry.bytes).toBe(900_000);
});

test("discovery problems map to metadata, version and activation findings with the field and a fix", () => {
  for (const problem of [
    "unsupported-casing",
    "malformed-utf8",
    "malformed-metadata",
    "name-mismatch",
    "malformed-eligibility",
  ])
    expect(codes(base({ problem }))).toEqual(["metadata-invalid"]);
  const missing = deriveSkillFindings(
    base({ problem: "malformed-metadata", facts: { ...FACTS, field: "description" } }),
  ).findings[0];
  expect(missing).toMatchObject({
    severity: "error",
    evidence: { problem: "malformed-metadata", field: "description" },
  });
  expect(missing?.fix).toContain("description");
  expect(
    deriveSkillFindings(
      base({ problem: "unsupported-control", facts: { ...FACTS, field: "model" } }),
    ).findings,
  ).toEqual([
    expect.objectContaining({
      code: "version-incompatible",
      evidence: { problem: "unsupported-control", field: "model" },
    }),
  ]);
  for (const problem of ["symlink", "not-a-file", "oversized", "unreadable"])
    expect(deriveSkillFindings(base({ problem })).findings).toEqual([
      expect.objectContaining({ code: "activation-failed", evidence: { reason: problem } }),
    ]);
  expect(deriveSkillFindings(base({ trusted: false, facts: null })).findings).toEqual([
    expect.objectContaining({
      code: "activation-failed",
      evidence: { reason: "workspace-untrusted" },
    }),
  ]);
});

test("links, MCP servers and restrictions are checked; healthy links and configured servers are silent", () => {
  expect(
    deriveSkillFindings(
      base({
        references: [
          { path: "references/guide.md", state: "present" },
          { path: "scripts/run.sh", state: "missing" },
          { path: "../outside.md", state: "escaped" },
        ],
      }),
    ).findings.map((item) => [item.code, item.evidence]),
  ).toEqual([
    ["reference-missing", { path: "scripts/run.sh", state: "missing" }],
    ["reference-missing", { path: "../outside.md", state: "escaped" }],
  ]);
  const servers = { ...FACTS, mcpServers: ["github", "jira"] };
  expect(
    deriveSkillFindings(base({ facts: servers, mcpServers: new Set(["github"]) })).findings.map(
      (item) => item.evidence,
    ),
  ).toEqual([{ server: "jira", field: "allowed-tools" }]);
  // Unknown configuration cannot prove a server missing.
  expect(codes(base({ facts: servers, mcpServers: null }))).toEqual([]);
  expect(codes(base({ eligibility: { user: true, automatic: false } }))).toEqual(["restricted"]);
  expect(
    deriveSkillFindings(base({ restriction: { user: true, automatic: false } })).findings[0]
      ?.evidence,
  ).toEqual({ field: "instructions.preferences" });
});

test("findings carry identities, codes and relative paths, never body text or absolute paths", () => {
  const entry = deriveSkillFindings(
    base({
      problem: "malformed-metadata",
      references: [{ path: "scripts/run.sh", state: "missing" }],
      refusals: { "skill-changed": 1 },
    }),
  );
  const text = JSON.stringify(entry);
  expect(text).not.toContain("BODY");
  expect(text).not.toMatch(/"\/(Users|home|tmp)\//u);
});

test("pages hold at most 100 entries, filter by code, severity and name, and count the whole generation", () => {
  const entries: SkillFindingEntry[] = Array.from({ length: 150 }, (_, index) =>
    deriveSkillFindings(
      base({
        entry: { ...base().entry, name: `skill-${String(index).padStart(3, "0")}` },
        ...(index % 3 === 0 ? { problem: "oversized" } : {}),
      }),
    ),
  );
  const first = pageSkillFindings(
    { generation: "g", complete: true, omissions: [] },
    entries,
    skillFindingsQuerySchema.parse({}),
  );
  expect([first.entries.length, first.total, first.nextOffset, first.counts]).toEqual([
    100,
    150,
    100,
    { error: 50, warning: 0, info: 0 },
  ]);
  const errors = pageSkillFindings(
    { generation: "g", complete: true, omissions: [] },
    entries,
    skillFindingsQuerySchema.parse({ severity: "error", offset: 10 }),
  );
  expect([errors.total, errors.entries.length, errors.nextOffset]).toEqual([50, 40, null]);
  expect(
    pageSkillFindings(
      { generation: "g", complete: true, omissions: [] },
      entries,
      skillFindingsQuerySchema.parse({ name: "skill-001", findingsOnly: true }),
    ).total,
  ).toBe(0);
  expect(skillFindingsQuerySchema.safeParse({ unknown: true }).success).toBe(false);
});

test("doctor names the most severe findings first and counts the rest", () => {
  const entries = [
    deriveSkillFindings(
      base({
        entry: { ...base().entry, name: "b" },
        eligibility: { user: true, automatic: false },
      }),
    ),
    deriveSkillFindings(base({ entry: { ...base().entry, name: "c" }, problem: "oversized" })),
    deriveSkillFindings(
      base({
        entry: { ...base().entry, name: "a" },
        references: [{ path: "x.md", state: "missing" }],
      }),
    ),
  ];
  const top = topFindings(entries, 2);
  expect(top.findings.map((item) => [item.severity, item.skill.name])).toEqual([
    ["error", "c"],
    ["warning", "a"],
  ]);
  expect(top.omitted).toBe(1);
});
