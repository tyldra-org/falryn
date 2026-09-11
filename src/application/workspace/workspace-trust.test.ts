import { expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import {
  type WorkspaceDecision,
  type WorkspaceTrustStore,
  workspaceTrustReportSchema,
} from "../../domain/security/workspace-trust.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { createWorkspaceTrust } from "./workspace-trust.ts";
import { createWorkspaceInventory } from "./workspace-trust-inventory.ts";

export function memoryWorkspaceTrustStore(): WorkspaceTrustStore {
  const records = new Map<string, WorkspaceDecision>();
  return {
    get: (key) => ok(records.get(key) ?? null),
    replace(key, revision, decision, signal) {
      if (signal?.aborted) return err({ code: "cancelled" });
      if ((records.get(key)?.revision ?? 0) !== revision) return err({ code: "conflict" });
      records.set(key, decision);
      return ok(null);
    },
  };
}
function fixture(store = memoryWorkspaceTrustStore()) {
  const fs = createInMemoryFileSystem({
    nodes: {
      "/work": { kind: "directory" },
      "/work/.falryn": { kind: "directory" },
      "/work/.falryn/falryn.jsonc": { kind: "file", text: '{"project":true}' },
      "/work/AGENTS.md": { kind: "file", text: "secret-token-do-not-echo" },
      "/work/.falryn/mcp.json": { kind: "file", text: "{}" },
      "/work/.falryn/hooks.json": { kind: "file", text: "{}" },
      "/work/.agents": { kind: "directory" },
      "/work/.agents/skills": { kind: "directory" },
      "/work/.agents/skills/example": { kind: "directory" },
      "/work/.agents/skills/example/SKILL.md": { kind: "file", text: "private instruction" },
    },
  });
  const inventory = createWorkspaceInventory({
    fileSystem: fs,
    roots: [localPath("/work")],
    configuration: canonicalDigest("config"),
    now: () => 100,
    validate: () => true,
  });
  const create = (actor = canonicalDigest("actor")) =>
    createWorkspaceTrust({ inventory, store, actor, now: () => 100 });
  return { fs, inventory, create, trust: create() };
}
test("first open is inert; refusal suppresses loaders; exact committed approval survives restart", async () => {
  const { trust, create } = fixture();
  const first = await trust.resolve();
  expect(first.status).toBe("review-required");
  expect(new Set(first.inventory?.loaders.map((entry) => entry.family)).size).toBe(5);
  expect(workspaceTrustReportSchema.safeParse(first).success).toBe(true);
  expect(JSON.stringify(first)).not.toContain("secret-token");
  expect(JSON.stringify(first)).not.toContain("/work");
  expect((await trust.project()).text).toBeNull();
  expect((await trust.resolve(async () => "refuse")).status).toBe("refused");
  expect((await trust.resolve(async () => "proceed")).status).toBe("refused");
  const approved = create();
  expect((await approved.resolve(async () => "proceed")).status).toBe("accepted");
  expect((await approved.project()).text).toBe('{"project":true}');
  const restarted = create();
  expect((await restarted.resolve()).status).toBe("accepted");
  expect((await restarted.project()).text).toBe('{"project":true}');
  expect((await create(canonicalDigest("another-actor")).resolve()).status).toBe("review-required");
});
test("changes during review, after commit, and before a reload cannot activate new bytes", async () => {
  const { trust, fs, create } = fixture();
  expect(
    (
      await trust.resolve(async () => {
        fs.put("/work/AGENTS.md", { kind: "file", text: "changed" });
        return "proceed";
      })
    ).status,
  ).toBe("stale");
  expect((await create().resolve()).status).toBe("review-required");
  expect((await trust.resolve(async () => "proceed")).status).toBe("accepted");
  fs.put("/work/.falryn/falryn.jsonc", { kind: "file", text: "changed configuration" });
  const reload = await trust.project();
  expect(reload.text).toBeNull();
  expect(reload.report.status).toBe("stale");
  expect(reload.report.changed).toBe(1);
});
test("cancellation, store faults and partial decisions grant no authority", async () => {
  for (const code of ["unavailable", "uncertain", "conflict", "malformed"]) {
    const { trust } = fixture({ get: () => ok(null), replace: () => err({ code }) });
    expect((await trust.resolve(async () => "proceed")).reason).toBe(`trust-store-${code}`);
    expect((await trust.project()).text).toBeNull();
  }
  const { trust } = fixture();
  const stop = new AbortController();
  expect(
    (
      await trust.resolve(async () => {
        stop.abort();
        return "proceed";
      }, stop.signal)
    ).status,
  ).toBe("refused");
  expect((await trust.project()).text).toBeNull();
});
test("links, unreadable input, oversized content, and hostile recursion fail closed", async () => {
  const { inventory, fs } = fixture();
  fs.put("/work/.falryn", { kind: "symlink", target: "/outside" });
  expect(await inventory.inspect()).toMatchObject({ error: { code: "inventory-path-escape" } });
  fs.put("/work/.falryn", { kind: "directory" });
  fs.put("/work/AGENTS.md", { kind: "file", byteLength: 1024 * 1024 + 1 });
  expect(await inventory.inspect()).toMatchObject({ error: { code: "inventory-byte-limit" } });
  expect(await inventory.inspect(AbortSignal.abort())).toMatchObject({
    error: { code: "cancelled" },
  });
});

test("inventory bounds reject excessive files, bytes and depth without accepting a partial inventory", async () => {
  for (const kind of ["files", "bytes", "depth", "wrong-kind"] as const) {
    const { inventory, fs } = fixture();
    if (kind === "files") {
      for (let n = 0; n < 1025; n++)
        fs.put(`/work/.agents/skills/file-${n}`, { kind: "file", text: "x" });
    } else if (kind === "bytes") {
      for (let n = 0; n < 17; n++)
        fs.put(`/work/.agents/skills/file-${n}`, {
          kind: "file",
          bytes: new Uint8Array(1024 * 1024),
        });
    } else if (kind === "depth") {
      let path = "/work/.agents/skills";
      for (let n = 0; n < 18; n++) {
        path += "/nested";
        fs.put(path, { kind: "directory" });
      }
    } else fs.put("/work/.falryn/falryn.jsonc", { kind: "directory" });
    const code =
      kind === "wrong-kind"
        ? "inventory-malformed"
        : `inventory-${kind === "files" ? "file" : kind === "bytes" ? "byte" : "depth"}-limit`;
    expect(await inventory.inspect()).toMatchObject({ ok: false, error: { code } });
  }
});

test("unreadable declarations and expired inventory deadlines fail closed", async () => {
  const { fs } = fixture();
  let clock = 0;
  const inventory = createWorkspaceInventory({
    fileSystem: fs,
    roots: [localPath("/work")],
    configuration: canonicalDigest("config"),
    now: () => (clock += 30_000),
    validate: () => true,
  });
  expect(await inventory.inspect()).toMatchObject({ error: { code: "inventory-timeout" } });
  const unreadable = createWorkspaceInventory({
    fileSystem: {
      ...fs,
      readBytes: async (path) =>
        err({ kind: "filesystem", code: "permission-denied", path, operation: "read-bytes" }),
    },
    roots: [localPath("/work")],
    configuration: canonicalDigest("config"),
    now: () => 100,
    validate: () => true,
  });
  expect(await unreadable.inspect()).toMatchObject({ error: { code: "inventory-unreadable" } });
});

test("workflow inventory joins the reviewed loader families without granting execution", async () => {
  const { fs, trust } = fixture();
  fs.put("/work/.falryn/workflows", { kind: "directory" });
  fs.put("/work/.falryn/workflows/check", { kind: "directory" });
  fs.put("/work/.falryn/workflows/check/workflow.jsonc", { kind: "file", text: "{}" });
  const reviewed = await trust.resolve(async () => "proceed");
  expect(reviewed.status).toBe("accepted");
  expect(new Set(reviewed.inventory?.loaders.map((loader) => loader.family)).size).toBe(6);
  expect(
    reviewed.inventory?.loaders.find((loader) => loader.family === "workflows")?.activation,
  ).toBe("definition");
});
