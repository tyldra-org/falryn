import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { catalogHandleSchema, catalogQuerySchema } from "../../domain/extensions/catalog.ts";
import { catalogHistorySchema } from "../../domain/extensions/catalog-history.ts";
import { digestSchema } from "../../domain/extensions/identity.ts";
import { parseInvocation } from "../command-tree.ts";

afterEach(removeTemporaryRoots);
const payloadSchema = z.object({
  payload: z.object({
    sessionId: z.string().optional(),
    workspaceId: z.string().optional(),
    extensionCatalog: catalogHistorySchema.optional(),
    currentExtensions: z
      .object({
        status: z.string(),
        page: z.object({ entries: z.array(z.object({ enabled: z.boolean() })) }).optional(),
      })
      .optional(),
    status: z.string().optional(),
    currentDigest: digestSchema.nullable().optional(),
    confirmation: digestSchema.nullable().optional(),
    trust: z.object({ confirmation: digestSchema.nullable(), status: z.string() }).optional(),
    receipt: z.object({ confirmation: digestSchema, revision: z.number() }).optional(),
    page: z
      .object({
        catalog: digestSchema,
        total: z.number(),
        next: catalogHandleSchema.nullable(),
        entries: z.array(
          z.object({ enabled: z.boolean(), availability: z.string(), reason: z.string() }),
        ),
      })
      .optional(),
  }),
});

test("CLI scope preview, confirmation, restart pagination and revocation share current catalog facts", async () => {
  const root = await temporaryRoot("falryn-scope-cli-");
  const source = join(root, "package");
  await mkdir(join(source, "skills", "one"), { recursive: true });
  await mkdir(join(source, "skills", "two"), { recursive: true });
  await writeFile(join(source, "plugin.json"), JSON.stringify(pluginManifest()));
  for (const name of ["one", "two"])
    await writeFile(
      join(source, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Example\n---\nDO NOT DISCLOSE`,
    );
  await writeFile(join(source, "never.js"), 'throw new Error("MUST NOT EXECUTE")');
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    NO_COLOR: "1",
    FALRYN_CONFIG_DIR: join(root, "config"),
    FALRYN_STATE_DIR: join(root, "state"),
    FALRYN_CACHE_DIR: join(root, "cache"),
    FALRYN_LOG_DIR: join(root, "logs"),
    FALRYN_TEMP_DIR: join(root, "temporary"),
    FALRYN_ARTIFACT_DIR: join(root, "artifacts"),
    FALRYN_EXPORT_DIR: join(root, "exports"),
  };
  async function invoke(command: string[], input?: unknown, format = "json", expectedExit = 0) {
    const inputPath = join(root, "request.json");
    if (input !== undefined) await writeFile(inputPath, JSON.stringify(input));
    const child = Bun.spawnSync(
      [
        process.execPath,
        "run",
        join(dirname(dirname(dirname(import.meta.path))), "main.ts"),
        ...command,
        "--format",
        format,
        ...(input === undefined ? [] : ["--input", inputPath]),
      ],
      {
        cwd: root,
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    expect(stderr).not.toContain("MUST NOT EXECUTE");
    expect(stdout).not.toContain("DO NOT DISCLOSE");
    if (child.exitCode !== expectedExit) throw new Error(`${child.exitCode}: ${stdout}\n${stderr}`);
    return payloadSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).payload;
  }
  const empty = await invoke(["extension", "catalog"]);
  expect(empty.page?.total).toBe(0);
  expect(await readdir(root)).not.toContain("state");
  const install = {
    packageId: "fixture",
    operationId: randomUUID(),
    expectedRevision: 0,
    sourcePath: source,
  };
  const proposed = await invoke(["package", "install"], install);
  const installed = await invoke(["package", "install"], {
    ...install,
    confirmation: proposed.confirmation,
  });
  const approval = { action: "approve", expiresAt: Date.now() + 60_000 };
  const trust = await invoke(["extension", "trust", source], approval);
  expect(trust.trust?.status).toBe("preview");
  expect(
    (
      await invoke(["extension", "trust", source], {
        ...approval,
        confirmation: trust.trust?.confirmation,
      })
    ).trust?.status,
  ).toBe("applied");
  const request = {
    operationId: randomUUID(),
    expectedRevision: 0,
    packageIdentity: installed.currentDigest,
    choice: { enabled: true, preferred: false, explicitOnly: false },
  };
  const change = { action: "scope", packageId: "fixture", scope: "user", request };
  for (const scope of ["process", "development"])
    await expect(invoke(["extension", "scope"], { ...change, scope })).rejects.toThrow(
      "scope-requires-live-host",
    );
  const preview = await invoke(["extension", "scope"], change);
  expect(preview.status).toBe("preview");
  expect((await invoke(["extension", "catalog"])).page?.total).toBe(0);
  const confirmed = {
    ...change,
    request: { ...request, confirmation: preview.receipt?.confirmation },
  };
  expect((await invoke(["extension", "scope"], confirmed, "jsonl")).status).toBe("applied");
  expect((await invoke(["extension", "scope"], confirmed)).status).toBe("applied");
  const first = await invoke(["extension", "catalog"]);
  expect(first.page?.total).toBe(2);
  expect(
    first.page?.entries.every((entry) => entry.enabled && entry.availability === "unavailable"),
  ).toBe(true);
  const query = catalogQuerySchema.parse({ catalog: first.page?.catalog, limit: 1 });
  const page = await invoke(["extension", "catalog"], { action: "catalog", query });
  expect(page.page?.next).not.toBeNull();
  const next = await invoke(["extension", "catalog"], {
    action: "catalog",
    query: { ...query, handle: page.page?.next },
  });
  expect(next.page?.entries).toHaveLength(1);
  expect(next.page?.next).toBeNull();
  const run = await invoke(["run", "Inspect scope", "--mode", "ask"], undefined, "jsonl", 8);
  if (!run.sessionId || !run.workspaceId) throw new Error("missing-run-session");
  const sessionArgs = [run.sessionId, "--workspace-id", run.workspaceId];
  const shown = await invoke(["session", "show", ...sessionArgs]);
  expect(shown.extensionCatalog?.total).toBe(2);
  expect(shown.extensionCatalog?.entries.every((entry) => entry.wasEnabled)).toBe(true);
  const forked = await invoke(["session", "fork", ...sessionArgs]);
  expect(forked.extensionCatalog).toEqual(shown.extensionCatalog);
  const replayed = await invoke(["session", "replay", ...sessionArgs]);
  expect(replayed.extensionCatalog).toEqual(shown.extensionCatalog);
  const sessionChoice = {
    ...change,
    scope: "session",
    session: run.sessionId,
    request: { ...request, operationId: randomUUID() },
  };
  const sessionPreview = await invoke(["extension", "scope"], sessionChoice);
  await invoke(["extension", "scope"], {
    ...sessionChoice,
    request: { ...sessionChoice.request, confirmation: sessionPreview.receipt?.confirmation },
  });
  expect(
    (await invoke(["extension", "catalog"], { action: "catalog", session: run.sessionId })).page
      ?.total,
  ).toBe(4);
  const foreign = join(root, "foreign-workspace");
  await mkdir(foreign);
  await expect(
    invoke(["extension", "scope", "--workspace", foreign], {
      ...sessionChoice,
      request: { ...request, operationId: randomUUID(), expectedRevision: 1 },
    }),
  ).rejects.toThrow("session-workspace-unverified");
  const revoke = { action: "revoke", expiresAt: null };
  const revocation = await invoke(["extension", "trust", source], revoke);
  await invoke(["extension", "trust", source], {
    ...revoke,
    confirmation: revocation.trust?.confirmation,
  });
  const revoked = await invoke(["extension", "catalog"]);
  expect(
    revoked.page?.entries.every((entry) => !entry.enabled && entry.reason === "trust-revoked"),
  ).toBe(true);
  expect(revoked.page?.catalog).not.toBe(first.page?.catalog);
  await expect(invoke(["extension", "catalog"], { action: "catalog", query })).rejects.toThrow(
    "stale-catalog-handle",
  );
  const resumed = await invoke(["session", "resume", ...sessionArgs]);
  expect(resumed.extensionCatalog).toEqual(shown.extensionCatalog);
  expect(resumed.currentExtensions?.status).toBe("inspected");
  expect(resumed.currentExtensions?.page?.entries.every((entry) => !entry.enabled)).toBe(true);
  await expect(
    invoke(["extension", "scope"], {
      ...change,
      request: { ...request, operationId: randomUUID(), expectedRevision: 1 },
    }),
  ).rejects.toThrow("scope-package-admission-required");
  const disable = {
    ...change,
    request: {
      ...request,
      operationId: randomUUID(),
      expectedRevision: 1,
      choice: { enabled: false, preferred: false, explicitOnly: false },
    },
  };
  const disabling = await invoke(["extension", "scope"], disable);
  await invoke(["extension", "scope"], {
    ...disable,
    request: { ...disable.request, confirmation: disabling.receipt?.confirmation },
  });
  const restored = await invoke(["extension", "trust", source], approval);
  await invoke(["extension", "trust", source], {
    ...approval,
    confirmation: restored.trust?.confirmation,
  });
  expect(
    (await invoke(["extension", "catalog"])).page?.entries.every((entry) => !entry.enabled),
  ).toBe(true);
}, 30_000);

test("extension catalog/scope parse strictly while help remains inert", async () => {
  expect((await parseInvocation(["extension", "catalog"])).kind).toBe("run");
  expect((await parseInvocation(["extension", "scope"])).kind).toBe("invalid");
  expect((await parseInvocation(["extension", "inspect"])).kind).toBe("invalid");
  expect((await parseInvocation(["extension", "catalog", "/untrusted/path"])).kind).toBe("invalid");
  expect((await parseInvocation(["extension", "scope", "--help"])).kind).toBe("help");
});
