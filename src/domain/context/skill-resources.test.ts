import { expect, test } from "bun:test";
import {
  loadSkillResources,
  resolveSkillResourcePath,
  SKILL_RESOURCE_LIMITS,
  type SkillResourceRead,
  skillResourceIndexText,
  skillResourceKind,
  skillResourceLinks,
  skillResourceMediaType,
} from "./skill-resources.ts";

const encode = (text: string) => new TextEncoder().encode(text);
/** An in-memory bundle; anything absent is missing. */
function bundle(files: Record<string, string | Uint8Array>) {
  const reads: string[] = [];
  const read = async (path: string): Promise<SkillResourceRead> => {
    reads.push(path);
    const value = files[path];
    if (value === undefined) return { ok: false, problem: "missing" };
    return { ok: true, bytes: typeof value === "string" ? encode(value) : value };
  };
  return { read, reads };
}
const signal = new AbortController().signal;
const statuses = (resources: readonly { path: string; status: string }[]) =>
  resources.map((item) => `${item.path}:${item.status}`);

test("paths resolve beneath the bundle and never above it", () => {
  expect(resolveSkillResourcePath("", "references/guide.md")).toEqual({
    ok: true,
    path: "references/guide.md",
  });
  expect(resolveSkillResourcePath("references", "../assets/logo.png")).toEqual({
    ok: true,
    path: "assets/logo.png",
  });
  for (const outside of [
    "../outside.md",
    "/etc/passwd",
    "C:/x",
    "a\\\\b",
    "references/../../x",
    "",
  ])
    expect(resolveSkillResourcePath("", outside).ok).toBe(false);
  // Hidden files such as credentials or VCS metadata are never skill resources.
  for (const hidden of [".env", "references/.secret.md", ".git/config"])
    expect(resolveSkillResourcePath("", hidden)).toEqual({ ok: false, reason: "hidden" });
  expect(resolveSkillResourcePath("", "a/".repeat(SKILL_RESOURCE_LIMITS.depth) + "x").ok).toBe(
    false,
  );
});

test("resources are classified by folder and extension, never as executable", () => {
  expect(skillResourceKind("scripts/check.ts")).toBe("script");
  expect(skillResourceKind("references/a.md")).toBe("reference");
  expect(skillResourceKind("notes.md")).toBe("other");
  expect(skillResourceMediaType("assets/logo.png")).toBe("image/png");
  expect(skillResourceMediaType("assets/blob")).toBe("application/octet-stream");
  expect(
    skillResourceIndexText(
      [
        {
          path: "scripts/check.ts",
          kind: "script",
          mediaType: "text/typescript",
          bytes: 9,
          executable: false,
        },
      ],
      2,
    ),
  ).toBe("scripts/check.ts (script, text/typescript, 9 bytes, not executable); 2 more");
});

test("markdown links outside fenced code are relative resources; schemes and fragments are not", () => {
  expect(
    skillResourceLinks(
      [
        "See [guide](details.md#part) and ![logo](../assets/logo%20v2.png).",
        "[web](https://example.test/x) [anchor](#top) [mail](mailto:a@b.test)",
        "~~~",
        "[ignored](inside-code.md)",
        "~~~",
      ].join("\n"),
    ),
  ).toEqual(["details.md", "../assets/logo v2.png"]);
});

test("a requested reference loads alone; its links are named for a later request", async () => {
  const files = bundle({
    "references/guide.md": "Guide. [details](details.md)",
    "references/details.md": "Details.",
  });
  const loaded = await loadSkillResources(
    { path: "references/guide.md", depth: 0 },
    files.read,
    signal,
  );
  expect(statuses(loaded.resources)).toEqual([
    "references/guide.md:loaded",
    "references/details.md:depth-limit",
  ]);
  expect(files.reads).toEqual(["references/guide.md"]);
  expect(loaded.resources[0]).toMatchObject({
    text: "Guide. [details](details.md)",
    executable: false,
  });
  expect(loaded.resources[0]?.digest).toMatch(/^sha256:/u);
});

test("an include chain reports cycles, escapes, missing files and binary assets separately", async () => {
  const files = bundle({
    "references/a.md":
      "[b](b.md) [escape](../../outside.md) [gone](missing.md) [logo](../assets/logo.png)",
    "references/b.md": "[back](a.md) [again](../references/b.md)",
    "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]),
  });
  const loaded = await loadSkillResources(
    { path: "references/a.md", depth: 4 },
    files.read,
    signal,
  );
  expect(statuses(loaded.resources)).toEqual([
    "references/a.md:loaded",
    "../../outside.md:escaped",
    "references/b.md:loaded",
    "references/missing.md:missing",
    "assets/logo.png:binary",
    "references/a.md:cycle",
    "references/b.md:cycle",
  ]);
  const logo = loaded.resources.find((item) => item.path === "assets/logo.png");
  expect(logo).toMatchObject({ bytes: 6, mediaType: "image/png", kind: "asset" });
  expect(logo?.text).toBeUndefined();
  // Each file was read at most once.
  expect(new Set(files.reads).size).toBe(files.reads.length);
});

test("the byte budget and reference limit stop returning text within one request", async () => {
  // a.md (19 bytes) and b.md leave 31 bytes; c.md needs 40.
  const big = "x".repeat(SKILL_RESOURCE_LIMITS.bytes - 50);
  const budget = bundle({ "a.md": "[b](b.md) [c](c.md)", "b.md": big, "c.md": "c".repeat(40) });
  const spent = await loadSkillResources({ path: "a.md", depth: 1 }, budget.read, signal);
  expect(statuses(spent.resources)).toEqual([
    "a.md:loaded",
    "b.md:loaded",
    "c.md:budget-exhausted",
  ]);

  const many: Record<string, string> = {
    "index.md": Array.from({ length: 64 }, (_, i) => `[r](r${i}.md)`).join(" "),
  };
  for (let i = 0; i < 64; i++) many[`r${i}.md`] = "leaf";
  const wide = await loadSkillResources({ path: "index.md", depth: 1 }, bundle(many).read, signal);
  expect(wide.resources).toHaveLength(SKILL_RESOURCE_LIMITS.references + 1);
  expect(wide.resources.at(-1)?.status).toBe("reference-limit");
});

test("an escaped request reads nothing, and cancellation stops before the next read", async () => {
  const files = bundle({ "a.md": "[b](b.md)", "b.md": "b" });
  const escaped = await loadSkillResources({ path: "../x.md", depth: 0 }, files.read, signal);
  expect(statuses(escaped.resources)).toEqual(["../x.md:escaped"]);
  expect(files.reads).toEqual([]);
  const stop = new AbortController();
  const cancelled = await loadSkillResources(
    { path: "a.md", depth: 2 },
    async (path) => {
      stop.abort();
      return files.read(path);
    },
    stop.signal,
  );
  expect(cancelled).toMatchObject({ cancelled: true });
  expect(statuses(cancelled.resources)).toEqual(["a.md:loaded"]);
});
