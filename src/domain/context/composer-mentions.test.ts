import { describe, expect, test } from "bun:test";
import {
  type ComposerToken,
  describeMentionReceipt,
  detectMentionTrigger,
  insertTokenText,
  isShellLikeDollarQuery,
  MENTION_TOKEN_LIMITS,
  reconcileTokens,
  restoreTokenPlaceholders,
  tokenLimitReason,
  tokensMatchText,
  withTokenPlaceholders,
} from "./composer-mentions.ts";

const DOLLAR = new Set(["$"] as const);

function token(
  label: string,
  start: number,
  id = label,
  kind: ComposerToken["kind"] = "skill",
): ComposerToken {
  return {
    id,
    trigger: "$",
    kind,
    identity: `skill:${label}`,
    label,
    source: "workspace",
    generation: "g1",
    start,
    end: start + label.length,
  };
}

describe("detectMentionTrigger", () => {
  test("opens at the start, after whitespace and after one opener", () => {
    expect(detectMentionTrigger("$", 1, DOLLAR)).toEqual({
      trigger: "$",
      start: 0,
      end: 1,
      query: "",
    });
    expect(detectMentionTrigger("use $gm", 7, DOLLAR)?.query).toBe("gm");
    expect(detectMentionTrigger("see ($rel", 9, DOLLAR)?.start).toBe(5);
    expect(detectMentionTrigger('say "$mcp:gm', 12, DOLLAR)?.query).toBe("mcp:gm");
    expect(detectMentionTrigger("line\n$sk", 8, DOLLAR)?.query).toBe("sk");
  });

  test("stays closed after a letter, digit or underscore", () => {
    for (const text of ["a$b", "US$5", "x_$y", "cost9$"]) {
      expect(detectMentionTrigger(text, text.length, DOLLAR)).toBeNull();
    }
  });

  test("stays closed for shell-like text", () => {
    for (const text of [
      "$HOME",
      "$PATH",
      "$5",
      "$$",
      "$?",
      "$_",
      "$-",
      "$" + "{X}",
      "$(pwd)",
      "$@",
    ]) {
      expect(detectMentionTrigger(text, text.length, DOLLAR)).toBeNull();
    }
    expect(isShellLikeDollarQuery("ARGUMENTS")).toBe(false);
    expect(isShellLikeDollarQuery("home")).toBe(false);
  });

  test("only enabled triggers open, and never inside a token", () => {
    expect(detectMentionTrigger("@src", 4, DOLLAR)).toBeNull();
    expect(detectMentionTrigger("use $gmail now", 10, DOLLAR, [token("$gmail", 4)])).toBeNull();
  });

  test("a word longer than the query bound does not open", () => {
    const long = `$${"a".repeat(MENTION_TOKEN_LIMITS.queryCharacters + 3)}`;
    expect(detectMentionTrigger(long, long.length, DOLLAR)).toBeNull();
  });
});

test("insertTokenText replaces the query and adds one space", () => {
  expect(insertTokenText("use $gm", { start: 4, end: 7 }, "$gmail")).toEqual({
    text: "use $gmail ",
    start: 4,
    end: 10,
    cursor: 11,
  });
  expect(insertTokenText("use $gm now", { start: 4, end: 7 }, "$gmail").text).toBe(
    "use $gmail now",
  );
});

describe("reconcileTokens", () => {
  test("moves tokens to reported ranges, drops deleted ones and demotes edited ones", () => {
    const a = token("$gmail", 4, "a");
    const b = token("$notes", 11, "b");
    const c = token("$other", 20, "c");
    const text = "xx use $gmail and $nots";
    const result = reconcileTokens(
      [a, b, c],
      text,
      new Map([
        ["a", { start: 7, end: 13 }],
        ["b", { start: 18, end: 23 }],
      ]),
    );
    expect(result.tokens.map((item) => [item.id, item.start])).toEqual([["a", 7]]);
    expect(result.demoted.map((item) => item.id)).toEqual(["b"]);
  });

  test("without ranges, a token survives only where its label still reads", () => {
    const kept = token("$gmail", 0, "k");
    expect(reconcileTokens([kept], "$gmail x").tokens).toHaveLength(1);
    expect(reconcileTokens([kept], "$gmai x").demoted).toHaveLength(1);
    expect(tokensMatchText([kept], "$gmail")).toBe(true);
  });
});

describe("placeholders", () => {
  const first = token("$gmail", 4, "a");
  const second = token("$notes", 16, "b");
  const tokens = [first, second];

  test("round-trip through a rewrite that keeps every placeholder once", () => {
    expect(withTokenPlaceholders("use $gmail then $notes!", tokens)).toBe(
      "use \u27E61\u27E7 then \u27E62\u27E7!",
    );
    expect(
      restoreTokenPlaceholders("Please \u27E62\u27E7, then use \u27E61\u27E7.", tokens),
    ).toEqual({
      ok: true,
      text: "Please $notes, then use $gmail.",
      tokens: [
        { ...second, start: 7, end: 13 },
        { ...first, start: 24, end: 30 },
      ],
    });
  });

  test("a rewrite that drops, duplicates or invents a pick is refused", () => {
    for (const proposal of [
      "only \u27E61\u27E7",
      "\u27E61\u27E7 \u27E61\u27E7 \u27E62\u27E7",
      "\u27E61\u27E7 \u27E62\u27E7 \u27E63\u27E7",
    ]) {
      expect(restoreTokenPlaceholders(proposal, tokens)).toEqual({
        ok: false,
        reason: "token-mismatch",
      });
    }
  });
});

test("tokenLimitReason enforces the capability, skill and draft bounds", () => {
  const skills = Array.from({ length: 4 }, (_, index) => token(`$s${index}`, index * 5));
  expect(tokenLimitReason(skills, { trigger: "$", kind: "skill" })).toBe(
    "At most 4 skills per prompt.",
  );
  expect(tokenLimitReason(skills, { trigger: "$", kind: "package" })).toBeNull();
  const eight = Array.from({ length: 8 }, (_, index) =>
    token(`$p${index}`, index * 5, `p${index}`, "package"),
  );
  expect(tokenLimitReason(eight, { trigger: "$", kind: "mcp-server" })).toBe(
    "At most 8 capabilities per prompt.",
  );
  const full = Array.from({ length: 64 }, () => ({ trigger: "@" as const, kind: "file" as const }));
  expect(tokenLimitReason(full, { trigger: "@", kind: "file" })).toBe(
    "A draft holds at most 64 mentions.",
  );
});

test("describeMentionReceipt lists capability picks once each", () => {
  expect(
    describeMentionReceipt([
      { trigger: "$", kind: "package", label: "$gmail", source: "gmail 1.2.0" },
      { trigger: "$", kind: "skill", label: "$release-notes", source: "" },
      { trigger: "$", kind: "package", label: "$gmail", source: "gmail 1.2.0" },
    ]),
  ).toBe("Using: gmail (package, gmail 1.2.0) · release-notes (skill)");
  expect(describeMentionReceipt([])).toBeNull();
});
