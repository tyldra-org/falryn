import { describe, expect, test } from "bun:test";
import {
  admitCapabilityMentions,
  type CapabilityMentionCandidate,
  capabilityMentionLabels,
  capabilityMentionPick,
  capabilityMentionSection,
  describeCapabilityMentionFailures,
  exactCapabilityMention,
  rankCapabilityMentions,
} from "./capability-mentions.ts";
import type { ComposerToken } from "./composer-mentions.ts";

function candidate(
  kind: CapabilityMentionCandidate["kind"],
  name: string,
  extra: Partial<CapabilityMentionCandidate> = {},
): CapabilityMentionCandidate {
  return {
    kind,
    name,
    identity: `${kind}:${name}@1`,
    generation: "g1",
    source: kind === "package" ? `${name} 1.0.0` : "workspace",
    availability: { kind: "available" },
    capabilityIds: kind === "skill" ? [] : [`${name}:tool`],
    ...(kind === "mcp-server" ? { catalog: "current" as const } : {}),
    ...extra,
  };
}

const catalog = [
  candidate("skill", "release-notes"),
  candidate("skill", "gmail-triage"),
  candidate("package", "gmail"),
  candidate("package", "outlook"),
  candidate("mcp-server", "linear", { catalog: "unknown" }),
  candidate("skill", "notes", {
    availability: {
      kind: "unavailable",
      reason: "not trusted in this workspace",
      repair: "/extensions",
    },
  }),
];

function tokenFor(
  row: ReturnType<typeof exactCapabilityMention>,
  id: string,
  start = 0,
): ComposerToken {
  if (row === null) throw new Error("no row");
  const pick = capabilityMentionPick(row);
  return { ...pick, id, start, end: start + pick.label.length };
}

describe("rankCapabilityMentions", () => {
  test("exact, then prefix, then fuzzy; ties by kind and label", () => {
    const page = rankCapabilityMentions("gmail", catalog);
    expect(page.rows.map((row) => [row.label, row.match])).toEqual([
      ["$gmail", "exact"],
      ["$gmail-triage", "prefix"],
    ]);
    expect(rankCapabilityMentions("", catalog).rows.map((row) => row.label)).toEqual([
      "$gmail-triage",
      "$notes",
      "$release-notes",
      "$gmail",
      "$outlook",
      "$mcp:linear",
    ]);
    expect(rankCapabilityMentions("rlnts", catalog).rows[0]?.match).toBe("fuzzy");
  });

  test("a kind prefix filters, and the page is bounded", () => {
    expect(rankCapabilityMentions("mcp:", catalog).rows.map((row) => row.label)).toEqual([
      "$mcp:linear",
    ]);
    expect(rankCapabilityMentions("package:gm", catalog).rows.map((row) => row.label)).toEqual([
      "$gmail",
    ]);
    const many = Array.from({ length: 1000 }, (_, index) => candidate("skill", `skill-${index}`));
    const page = rankCapabilityMentions("skill", many);
    expect(page.rows).toHaveLength(50);
    expect(page.total).toBe(1000);
  });
});

test("names shared across kinds are kind-qualified", () => {
  const labels = capabilityMentionLabels([
    candidate("skill", "gmail"),
    candidate("package", "gmail"),
  ]);
  expect([...labels.values()]).toEqual(["$skill:gmail", "$package:gmail"]);
});

test("exactCapabilityMention needs one available exact label", () => {
  expect(exactCapabilityMention("gmail", catalog)?.candidate.kind).toBe("package");
  expect(exactCapabilityMention("gmai", catalog)).toBeNull();
  expect(exactCapabilityMention("notes", catalog)).toBeNull();
});

describe("admitCapabilityMentions", () => {
  test("skills load, packages and servers are preferred, stale catalogs connect", () => {
    const tokens = [
      tokenFor(exactCapabilityMention("release-notes", catalog), "a"),
      tokenFor(exactCapabilityMention("gmail", catalog), "b", 20),
      tokenFor(exactCapabilityMention("mcp:linear", catalog), "c", 30),
      tokenFor(exactCapabilityMention("gmail", catalog), "d", 45),
    ];
    const admission = admitCapabilityMentions(tokens, catalog);
    expect(admission).toEqual({
      ok: true,
      skills: ["release-notes"],
      preferredCapabilityIds: ["gmail:tool", "linear:tool"],
      mcpServers: ["linear"],
      packages: ["gmail"],
      connect: ["linear"],
    });
    if (admission.ok) expect(capabilityMentionSection(admission)).toContain("MCP server linear");
  });

  test("a changed identity is stale, an unavailable one names its reason, and all failures report", () => {
    const gmail = tokenFor(exactCapabilityMention("gmail", catalog), "a");
    const notes: ComposerToken = {
      ...gmail,
      id: "b",
      kind: "skill",
      identity: "skill:notes@1",
      label: "$notes",
    };
    const updated = catalog.map((item) =>
      item.name === "gmail" ? { ...item, identity: "package:gmail@2" } : item,
    );
    const admission = admitCapabilityMentions([gmail, notes], updated);
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.failures.map((failure) => [failure.tokenId, failure.code])).toEqual([
      ["a", "mention.stale"],
      ["b", "mention.untrusted"],
    ]);
    expect(describeCapabilityMentionFailures(admission.failures)).toContain(
      "$gmail changed since you picked it (pick it again from the list)",
    );
  });

  test("more than the capability or skill bound is refused", () => {
    const skills = ["a", "b", "c", "d", "e"].map((name) => candidate("skill", name));
    const tokens = skills.map((item, index) =>
      tokenFor(exactCapabilityMention(item.name, skills), `t${index}`, index * 3),
    );
    const refused = admitCapabilityMentions(tokens, skills);
    expect(refused.ok ? null : refused.failures[0]?.code).toBe("mention.limit");
  });
});
