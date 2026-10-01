import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { CONFIGURATION_FILE_NAME } from "../../config/index.ts";
import { bytesDigest, canonicalDigest } from "../../domain/extensions/canonical.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { packageHealthResultSchema } from "../../domain/extensions/package-health.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { nativeHealthFixture } from "../../integrations/extensions/package-health-fixtures.ts";
import { dispatch } from "../dispatch.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { createServiceProvider } from "../runtime/services.ts";

export type ExtraPackageFixture = {
  declarations: readonly import("zod").infer<
    typeof import("../../domain/extensions/manifest.ts").contributionDeclarationSchema
  >[];
  files: Readonly<Record<string, string>>;
  /** How the user answers each HTTP or evaluator hook approval requirement at enable time. */
  grant?: (
    requirement: import("../../domain/extensions/hook-grants.ts").HookGrantRequirement,
  ) => import("../../domain/extensions/hook-grants.ts").HookGrant;
};
/**
 * How a fixture runs its CLI commands. `"in-process"` dispatches each one in this process
 * over the fixture's roots, which skips a source-mode process start per command: most of
 * these suites' time on hosted runners. A command (the compiled executable) spawns each
 * one, so the compiled smoke still crosses the real process boundary.
 */
export type FixtureCli = readonly string[] | "in-process";

async function runFixtureCommand(
  cli: FixtureCli,
  argv: readonly string[],
  root: string,
  environment: Readonly<Record<string, string>>,
): Promise<{ readonly stdout: string; readonly failure: string }> {
  if (cli === "in-process") {
    const streams = createRecordingCliStreams();
    const code = await dispatch({
      argv,
      streams,
      services: (globals) =>
        createServiceProvider(globals, {
          home: localPath(root),
          currentDirectory: localPath(root),
          environment: createStaticEnvironment(environment),
        }),
    });
    return {
      stdout: streams.resultWrites().join(""),
      failure: `exit ${code}: ${streams.diagnosticWrites().join("").slice(0, 2_000)}`,
    };
  }
  const child = Bun.spawnSync([...cli, ...argv], {
    cwd: root,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  // A child killed by its timeout or a signal prints nothing; say so instead of a parse error.
  return {
    stdout: new TextDecoder().decode(child.stdout),
    failure: `exit ${child.exitCode}, signal ${child.signalCode ?? "none"}, timed out ${child.exitedDueToTimeout === true}: ${new TextDecoder().decode(child.stderr).slice(0, 2_000)}`,
  };
}

export async function preparePackageCliFixture(
  command: FixtureCli,
  root: string,
  mode = "healthy",
  tool = false,
  extra?: ExtraPackageFixture,
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
  for (const [path, text] of Object.entries(extra?.files ?? {}))
    await writeFile(join(source, path), text);
  await writeFile(
    join(source, "plugin.json"),
    JSON.stringify(
      pluginManifest({
        version: 1,
        contributions: tool
          ? [
              fixture.declaration,
              { ...fixture.declaration, id: "disabled" },
              ...(extra?.declarations ?? []),
            ]
          : [fixture.declaration],
        files: [
          { path: "health-peer", digest: fixture.digest },
          ...Object.entries(extra?.files ?? {}).map(([path, text]) => ({
            path,
            digest: bytesDigest(new TextEncoder().encode(text)),
          })),
        ],
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
    const { stdout, failure } = await runFixtureCommand(
      command,
      [...args, "--input", file, "--format", format],
      root,
      environment,
    );
    if (stdout.trim() === "")
      throw new Error(`health command ${args.join(" ")} produced no output (${failure})`);
    const decoded = z
      .object({ payload: z.unknown() })
      .safeParse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "null"));
    if (!decoded.success) throw new Error(`health command failed: ${stdout} ${failure}`);
    expect(stdout).not.toContain("HEALTH-SECRET-NEVER-IN-CHILD");
    const parsed = schema.safeParse(decoded.data.payload);
    if (!parsed.success)
      throw new Error(`fixture command ${args.join(" ")}: ${JSON.stringify(decoded.data.payload)}`);
    return parsed.data;
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
  expect(catalog.page.entries).toHaveLength((tool ? 2 : 1) + (extra?.declarations.length ?? 0));
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
  return {
    invoke,
    contribution,
    source,
    environment,
    catalogMs,
    warmCatalogMs,
    scope,
    installed,
    extraContributions: catalog.page.entries
      .filter((entry) => {
        const id = z.object({ localId: z.string() }).parse(entry.contribution).localId;
        return extra?.declarations.some((d) => d.id === id);
      })
      .map((entry) => canonicalDigest(entry.contribution)),
  };
}

export async function packageHealthCliJourney(command: FixtureCli, root: string, mode = "healthy") {
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
