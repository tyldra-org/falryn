import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { CONFIGURATION_FILE_NAME } from "../../config/index.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { packageHealthResultSchema } from "../../domain/extensions/package-health.ts";
import { nativeHealthFixture } from "../../integrations/extensions/package-health-fixtures.ts";

export async function preparePackageCliFixture(
  command: readonly string[],
  root: string,
  mode = "healthy",
  tool = false,
) {
  const source = join(root, "package");
  await mkdir(source);
  const secret = join(root, "outside-secret");
  await writeFile(secret, "PRIVATE-CONTENT");
  const fixture = await nativeHealthFixture(
    root,
    mode === "cancel" ? "timeout" : mode,
    secret,
    tool,
  );
  if (mode === "cancel" && fixture.declaration.execution)
    fixture.declaration.execution.resources.startupMs = 5000;
  await writeFile(join(source, "health-peer"), fixture.bytes);
  await writeFile(
    join(source, "plugin.json"),
    JSON.stringify(
      pluginManifest({
        version: 1,
        contributions: tool
          ? [fixture.declaration, { ...fixture.declaration, id: "disabled" }]
          : [fixture.declaration],
        files: [{ path: "health-peer", digest: fixture.digest }],
      }),
    ),
  );
  const config = join(root, "config");
  await mkdir(config);
  await writeFile(
    join(config, CONFIGURATION_FILE_NAME),
    JSON.stringify({
      schemaVersion: 1,
      tools: { sandbox: { version: 1, mode: "strict", readRoots: [], writeRoots: [] } },
    }),
  );
  const environment = {
    PATH: process.env.PATH ?? "",
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? "",
    HOME: root,
    NO_COLOR: "1",
    FALRYN_HEALTH_SECRET: "HEALTH-SECRET-NEVER-IN-CHILD",
    FALRYN_CONFIG_DIR: config,
    FALRYN_STATE_DIR: join(root, "state"),
    FALRYN_CACHE_DIR: join(root, "cache"),
    FALRYN_LOG_DIR: join(root, "logs"),
    FALRYN_TEMP_DIR: join(root, "temporary"),
    FALRYN_ARTIFACT_DIR: join(root, "artifacts"),
    FALRYN_EXPORT_DIR: join(root, "exports"),
  };
  async function invoke<T>(args: string[], input: unknown, schema: z.ZodType<T>, format = "json") {
    const file = join(root, "request.json");
    await writeFile(file, JSON.stringify(input));
    const child = Bun.spawnSync([...command, ...args, "--input", file, "--format", format], {
      cwd: root,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    const stdout = new TextDecoder().decode(child.stdout);
    const decoded = z
      .object({ payload: z.unknown() })
      .safeParse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "null"));
    if (!decoded.success)
      throw new Error(`health command failed: ${stdout} ${new TextDecoder().decode(child.stderr)}`);
    expect(stdout).not.toContain("HEALTH-SECRET-NEVER-IN-CHILD");
    return schema.parse(decoded.data.payload);
  }
  const install = {
    packageId: "fixture",
    operationId: randomUUID(),
    expectedRevision: 0,
    sourcePath: source,
  };
  const preview = await invoke(["package", "install"], install, packageReceiptSchema);
  const installed = await invoke(
    ["package", "install"],
    { ...install, confirmation: preview.confirmation },
    packageReceiptSchema,
  );
  expect(installed.status).toBe("completed");
  const approval = { action: "approve", expiresAt: Date.now() + 300_000 };
  const trustSchema = z.object({
    contributions: z.array(z.object({ identityDigest: z.string() })),
    trust: z.object({ status: z.string(), confirmation: z.string().nullable() }),
  });
  const trust = await invoke(["extension", "trust", source], approval, trustSchema);
  expect(
    (
      await invoke(
        ["extension", "trust", source],
        { ...approval, confirmation: trust.trust.confirmation },
        trustSchema,
      )
    ).trust.status,
  ).toBe("applied");
  const scope = {
    action: "scope",
    packageId: "fixture",
    scope: "user",
    request: {
      operationId: randomUUID(),
      expectedRevision: 0,
      packageIdentity: installed.currentDigest,
      choice: { enabled: true, preferred: false, explicitOnly: !tool },
    },
  };
  const scopeSchema = z.object({
    status: z.string(),
    receipt: z.object({ confirmation: z.string() }),
  });
  const scoped = await invoke(["extension", "scope"], scope, scopeSchema);
  expect(
    (
      await invoke(
        ["extension", "scope"],
        { ...scope, request: { ...scope.request, confirmation: scoped.receipt.confirmation } },
        scopeSchema,
      )
    ).status,
  ).toBe("applied");
  const catalogStart = performance.now();
  const catalog = await invoke(
    ["extension", "catalog"],
    { action: "catalog" },
    z.object({
      page: z.object({
        entries: z.array(z.object({ contribution: z.unknown(), enabled: z.boolean() })),
      }),
    }),
  );
  expect(catalog.page.entries).toHaveLength(tool ? 2 : 1);
  const catalogMs = performance.now() - catalogStart;
  const warmCatalogStart = performance.now();
  await invoke(["extension", "catalog"], { action: "catalog" }, z.object({ page: z.unknown() }));
  const warmCatalogMs = performance.now() - warmCatalogStart;
  const main = catalog.page.entries.find(
    (entry) => z.object({ localId: z.string() }).parse(entry.contribution).localId === "health",
  );
  expect(main?.enabled).toBe(true);
  const contribution = canonicalDigest(main?.contribution);
  expect(trust.contributions.some((entry) => entry.identityDigest === contribution)).toBe(true);
  if (tool) {
    const disabled = catalog.page.entries.find(
      (entry) => z.object({ localId: z.string() }).parse(entry.contribution).localId === "disabled",
    );
    const request = {
      ...scope.request,
      operationId: randomUUID(),
      expectedRevision: 1,
      contribution: canonicalDigest(disabled?.contribution),
      choice: { enabled: false, preferred: false, explicitOnly: true },
    };
    const preview = await invoke(["extension", "scope"], { ...scope, request }, scopeSchema);
    const changed = await invoke(
      ["extension", "scope"],
      { ...scope, request: { ...request, confirmation: preview.receipt.confirmation } },
      scopeSchema,
    );
    expect(changed.status).toBe("applied");
  }
  return { invoke, contribution, source, environment, catalogMs, warmCatalogMs, scope, installed };
}

export async function packageHealthCliJourney(
  command: readonly string[],
  root: string,
  mode = "healthy",
) {
  const { invoke, contribution, catalogMs, warmCatalogMs } = await preparePackageCliFixture(
    command,
    root,
    mode,
  );
  const request = {
    packageId: "fixture",
    operationId: randomUUID(),
    expectedRevision: 1,
    health: { contribution },
  };
  const healthPreview = await invoke(["package", "health"], request, packageReceiptSchema);
  expect(healthPreview).toMatchObject({ status: "preview", code: "health-confirmation-required" });
  expect(await readdir(join(root, "state"))).not.toContain("package-health");
  const confirmed = { ...request, confirmation: healthPreview.confirmation };
  const started = performance.now();
  if (mode === "cancel") {
    // Global cancellation publishes its terminal envelope first. The command
    // drains cleanup before exit; replay retrieves the durable health facts.
    expect(
      await invoke(["package", "health", "--timeout", "1000"], confirmed, z.null()),
    ).toBeNull();
  }
  const health = await invoke(["package", "health"], confirmed, packageReceiptSchema);
  const elapsedMs = performance.now() - started;
  expect(health).toMatchObject({
    status: mode === "cancel" ? "failed" : "completed",
    code: mode === "cancel" ? "cancelled" : "health-completed",
    activation: "unavailable",
  });
  const result = packageHealthResultSchema.parse(health.data);
  expect(result).toMatchObject({
    state: mode === "cancel" ? "failed" : "healthy",
    requests: mode === "cancel" ? 0 : 4,
    terminated: true,
    cleanup: "removed",
  });
  expect(result.sandbox?.readRoots).toEqual(["package-root"]);
  const replay = await invoke(["package", "health"], confirmed, packageReceiptSchema, "jsonl");
  expect(replay.data).toEqual(health.data);
  const control = await invoke(
    ["package", "health"],
    {
      ...request,
      operationId: randomUUID(),
      health: { contribution, requiredControls: ["memory"] },
    },
    packageReceiptSchema,
  );
  expect(control.code).toBe("health-memory-control-unavailable");
  const measurement = { mode, elapsedMs, catalogMs, warmCatalogMs, ...result.timings };
  if (process.env.FALRYN_HEALTH_MEASURE === "1") console.info(JSON.stringify(measurement));
  return measurement;
}
