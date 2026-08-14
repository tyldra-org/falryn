import { describe, expect, test } from "bun:test";
import {
  type CommandOutcome,
  createInMemoryFileSystem,
  createStubCommandRunner,
  duration,
  localPath,
} from "../domain/index.ts";
import { createWorkspaceTextSearch } from "./workspace-search.ts";

const root = localPath("/work/project");
const rg = localPath("/usr/bin/rg");

function workspaceFs() {
  return createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/src": { kind: "directory" },
      "/work/project/src/a.ts": { kind: "file", text: "alpha sk-live-SECRET\nbeta token\n" },
      "/work/project/src/b.ts": { kind: "file", text: "token in b\n" },
      "/work/project/src/note.md": { kind: "file", text: "token in md\n" },
      "/work/project/.env": { kind: "file", text: "token hidden\n" },
      "/work/project/bin.dat": { kind: "file", text: "token\0binary" },
      "/work/project/out": { kind: "symlink", target: "/etc/passwd" },
      "/work/project/inside-link": { kind: "symlink", target: "/work/project/src" },
      "/work/project/secret": { kind: "directory" },
      "/work/project/secret/key.ts": { kind: "file", text: "token hidden-key\n" },
      "/etc/passwd": { kind: "file", text: "token outside\n" },
    },
  });
}

function searchHarness(outcome: CommandOutcome | ((argv: readonly string[]) => CommandOutcome)) {
  const fileSystem = workspaceFs();
  const commands = createStubCommandRunner((request) =>
    typeof outcome === "function" ? outcome(request.mode === "bash" ? [] : request.argv) : outcome,
  );
  return {
    fileSystem,
    commands,
    search: createWorkspaceTextSearch({ fileSystem, commands }),
  };
}

function matchEvent(path: string, line: string, lineNumber: number, column = 0): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text: `${line}\n` },
      line_number: lineNumber,
      submatches: [{ start: column }],
    },
  });
}

describe("createWorkspaceTextSearch", () => {
  test("uses the TypeScript fallback when no executable is supplied", async () => {
    const { commands, search } = searchHarness({ kind: "exited", exitCode: 0, stdout: "" });
    const found = await search.search(root, { query: "token" });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected search");
    }
    expect(found.value.engine).toBe("typescript-fallback");
    expect(found.value.fallbackReason).toBe("unavailable");
    expect(commands.requests()).toEqual([]);
    expect(found.value.matches.map((match) => match.logical)).toEqual([
      "secret/key.ts",
      "src/a.ts",
      "src/b.ts",
      "src/note.md",
    ]);
    expect(found.value.matches.map((match) => match.line)).toEqual([1, 2, 1, 1]);
  });

  test("falls back once when ripgrep cannot spawn and never retries rg", async () => {
    const { commands, search } = searchHarness({ kind: "spawn-failed", code: "ENOENT" });
    const found = await search.search(root, {
      query: "token",
      ripgrepExecutable: rg,
    });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected search");
    }
    expect(found.value.engine).toBe("typescript-fallback");
    expect(found.value.fallbackReason).toBe("spawn-failed");
    expect(commands.requests()).toHaveLength(1);
    const [request] = commands.requests();
    expect(request?.executable).toBe(rg);
    expect(request?.environment).toEqual({});
    if (request === undefined || request.mode === "bash") {
      throw new Error("expected a direct argv request");
    }
    expect(request.argv).toContain("--no-config");
    expect(request.argv).toContain("--no-ignore");
  });

  test("parses ripgrep JSON matches without using the fallback", async () => {
    const stdout = [
      matchEvent("/work/project/src/b.ts", "token in b", 1, 0),
      matchEvent("src/a.ts", "beta token", 2, 5),
    ].join("\n");
    const { commands, search } = searchHarness({ kind: "exited", exitCode: 0, stdout });
    const found = await search.search(root, { query: "token", ripgrepExecutable: rg });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected search");
    }
    expect(found.value.engine).toBe("ripgrep");
    expect(found.value.fallbackReason).toBeNull();
    expect(found.value.matches.map((match) => match.logical)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(found.value.matches[0]?.column).toBe(6);
    expect(commands.requests()).toHaveLength(1);
  });

  test("treats ripgrep exit 1 as an empty success", async () => {
    const { search } = searchHarness({ kind: "exited", exitCode: 1, stdout: "" });
    const found = await search.search(root, { query: "token", ripgrepExecutable: rg });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected search");
    }
    expect(found.value.engine).toBe("ripgrep");
    expect(found.value.matches).toEqual([]);
    expect(found.value.truncated).toBe(false);
  });

  test("does not fall back on a non-zero ripgrep status other than 1", async () => {
    const { commands, search } = searchHarness({ kind: "exited", exitCode: 2, stdout: "" });
    const found = await search.search(root, {
      query: "token",
      kind: "regex",
      ripgrepExecutable: rg,
    });
    expect(found).toEqual({ ok: false, error: { code: "malformed-regex" } });
    expect(commands.requests()).toHaveLength(1);
  });

  test("does not fall back when ripgrep times out or is cancelled", async () => {
    const timed = searchHarness({ kind: "timed-out", timeoutMs: duration(10_000) });
    expect(await timed.search.search(root, { query: "token", ripgrepExecutable: rg })).toEqual({
      ok: false,
      error: { code: "timed-out" },
    });
    expect(timed.commands.requests()).toHaveLength(1);

    const cancelled = searchHarness({ kind: "cancelled" });
    expect(await cancelled.search.search(root, { query: "token", ripgrepExecutable: rg })).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
  });

  test("returns a typed output-limit when ripgrep exceeds the byte bound", async () => {
    const { search } = searchHarness({ kind: "output-exceeded", maxOutputBytes: 64 * 1024 });
    const found = await search.search(root, { query: "token", ripgrepExecutable: rg });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected search");
    }
    expect(found.value).toMatchObject({
      matches: [],
      truncated: true,
      truncation: "output-limit",
      engine: "ripgrep",
      fallbackReason: null,
    });
  });

  test("matches regex, skips hidden and binary, and honors exclude globs", async () => {
    const { search } = searchHarness({ kind: "spawn-failed", code: "ENOENT" });
    const found = await search.search(root, {
      query: "tok.n",
      kind: "regex",
      exclude: ["secret/"],
    });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected search");
    }
    const logicals = found.value.matches.map((match) => match.logical);
    expect(logicals).toEqual(["src/a.ts", "src/b.ts", "src/note.md"]);
    expect(logicals).not.toContain("secret/key.ts");
    expect(logicals).not.toContain(".env");
    expect(logicals).not.toContain("bin.dat");
  });

  test("includes hidden and binary files only when asked", async () => {
    const { search } = searchHarness({ kind: "exited", exitCode: 0, stdout: "" });
    const found = await search.search(root, {
      query: "token",
      includeHidden: true,
      includeBinary: true,
    });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected search");
    }
    const logicals = found.value.matches.map((match) => match.logical);
    expect(logicals).toContain(".env");
    expect(logicals).toContain("bin.dat");
  });

  test("truncates at the match budget and keeps path/line order", async () => {
    const { search } = searchHarness({ kind: "exited", exitCode: 0, stdout: "" });
    const found = await search.search(root, { query: "token", maxMatches: 2 });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected search");
    }
    expect(found.value.matches).toHaveLength(2);
    expect(found.value.truncated).toBe(true);
    expect(found.value.truncation).toBe("match-limit");
    expect(found.value.matches.map((match) => match.logical)).toEqual([
      "secret/key.ts",
      "src/a.ts",
    ]);
  });

  test("does not descend through a symlink and refuses an escaping start", async () => {
    const { search } = searchHarness({ kind: "exited", exitCode: 0, stdout: "" });
    const found = await search.search(root, { query: "token" });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected search");
    }
    const logicals = found.value.matches.map((match) => match.logical);
    expect(logicals.filter((path) => path.startsWith("inside-link/"))).toEqual([]);
    expect(await search.search(root, { query: "token", start: "out" })).toEqual({
      ok: false,
      error: { code: "symlink-escape" },
    });
  });

  test("cancels before walking when the signal is already aborted", async () => {
    const { commands, search } = searchHarness({ kind: "exited", exitCode: 0, stdout: "" });
    const controller = new AbortController();
    controller.abort();
    expect(await search.search(root, { query: "token" }, controller.signal)).toEqual({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(commands.requests()).toEqual([]);
  });

  test("returns context lines from the TypeScript path", async () => {
    const { search } = searchHarness({ kind: "exited", exitCode: 0, stdout: "" });
    const found = await search.search(root, { query: "token", include: ["src/a.ts"], context: 1 });
    expect(found.ok).toBe(true);
    if (!found.ok) {
      throw new Error("expected search");
    }
    expect(found.value.matches).toHaveLength(1);
    expect(found.value.matches[0]?.before).toEqual(["alpha sk-live-SECRET"]);
    expect(found.value.matches[0]?.after).toEqual([]);
  });

  test("does not echo file secrets in a malformed request error", async () => {
    const { search } = searchHarness({ kind: "exited", exitCode: 0, stdout: "" });
    const found = await search.search(root, { query: "" });
    expect(found).toEqual({
      ok: false,
      error: { code: "malformed-query", reason: "empty" },
    });
    expect(JSON.stringify(found)).not.toContain("sk-live-SECRET");
    expect(JSON.stringify(found)).not.toContain("hidden-key");
  });
});
