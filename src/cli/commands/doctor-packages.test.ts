import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "../../data/fixtures.ts";
import { PRODUCT_SCHEMA_VERSION, PRODUCTION_MIGRATIONS, probeStorage } from "../../data/index.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { openBunSqlite } from "../../integrations/index.ts";
import { dispatch } from "../dispatch.ts";
import type { GlobalOptions } from "../options.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { createServiceProvider } from "../runtime/services.ts";
import { runDoctor } from "./doctor.ts";
import { type DoctorPackages, inspectDoctorPackages } from "./doctor-packages.ts";

afterEach(removeTemporaryRoots);

const GLOBALS: GlobalOptions = {
  format: "json",
  color: "never",
  quiet: false,
  verbose: false,
  nonInteractive: true,
  workspace: null,
  addDirs: [],
  profile: null,
  timeoutMs: null,
  help: false,
  version: false,
};

function environment(root: string) {
  return {
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
}

/** The real command tree in this process, over the fixture's roots. */
function fixtureCli(root: string) {
  const services = (globals: GlobalOptions) =>
    createServiceProvider(globals, {
      home: localPath(root),
      currentDirectory: localPath(root),
      environment: createStaticEnvironment(environment(root)),
    });
  async function run(argv: readonly string[]) {
    const streams = createRecordingCliStreams();
    const code = await dispatch({ argv, streams, services });
    return { code, stdout: streams.resultWrites().join("") };
  }
  async function invoke(args: readonly string[], input: unknown) {
    const file = join(root, "request.json");
    if (input !== undefined) await writeFile(file, JSON.stringify(input));
    const { stdout } = await run([
      ...args,
      ...(input === undefined ? [] : ["--input", file]),
      "--format",
      "json",
    ]);
    return z
      .object({ payload: z.unknown() })
      .parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "null")).payload;
  }
  async function doctor() {
    const json = await run(["doctor", "--format", "json"]);
    const payload = z
      .object({ payload: z.object({ packages: z.unknown(), blocked: z.boolean() }) })
      .parse(JSON.parse(json.stdout.trim().split("\n").at(-1) ?? "null")).payload;
    const human = await run(["doctor", "--format", "human"]);
    return {
      code: json.code,
      packages: payload.packages as DoctorPackages,
      blocked: payload.blocked,
      human: human.stdout,
    };
  }
  return { run, invoke, doctor, services: services(GLOBALS) };
}

async function installed(root: string, cli: ReturnType<typeof fixtureCli>, id: string) {
  const source = join(root, `source-${id}`);
  await mkdir(source);
  await writeFile(
    join(source, "plugin.json"),
    JSON.stringify(pluginManifest({ version: 1 }, { name: id, version: "1.0.0" })),
  );
  const request = {
    packageId: id,
    operationId: randomUUID(),
    expectedRevision: 0,
    sourcePath: source,
  };
  const preview = packageReceiptSchema.parse(await cli.invoke(["package", "install"], request));
  const done = packageReceiptSchema.parse(
    await cli.invoke(["package", "install"], { ...request, confirmation: preview.confirmation }),
  );
  expect(done.status).toBe("completed");
  const approval = { action: "approve", expiresAt: Date.now() + 600_000 };
  const trust = z.object({ trust: z.object({ status: z.string(), confirmation: z.string() }) });
  const previewed = trust.parse(await cli.invoke(["extension", "trust", source], approval));
  const applied = trust.extend({ trust: z.object({ status: z.string() }) }).parse(
    await cli.invoke(["extension", "trust", source], {
      ...approval,
      confirmation: previewed.trust.confirmation,
    }),
  );
  expect(applied.trust.status).toBe("applied");
  await rm(source, { recursive: true });
}

async function hold(
  cli: ReturnType<typeof fixtureCli>,
  action: string,
  id: string,
  reason: string,
) {
  const request = { packageId: id, operationId: randomUUID(), expectedRevision: 1, reason };
  const preview = packageReceiptSchema.parse(await cli.invoke(["package", action], request));
  const done = packageReceiptSchema.parse(
    await cli.invoke(["package", action], { ...request, confirmation: preview.confirmation }),
  );
  expect(done.status).toBe("completed");
}

const standingSchema = z.object({
  data: z.object({ standing: z.object({ state: z.string(), reason: z.string().nullable() }) }),
});
const noticesSchema = z.object({
  notices: z.array(z.object({ notice: z.object({ severity: z.string() }) })),
  suppressed: z.number(),
});

test("doctor reports each installed package with the standing, notices and evaluation their own commands report", async () => {
  const root = await temporaryRoot("falryn-doctor-packages-");
  const cli = fixtureCli(root);
  for (const id of ["alpha", "beta", "gamma"]) await installed(root, cli, id);
  await hold(cli, "revoke", "beta", "policy");
  await hold(cli, "quarantine", "gamma", "unexpected-behavior");
  await cli.invoke(["package", "evaluate"], {
    packageId: "alpha",
    operationId: randomUUID(),
    expectedRevision: 1,
  });

  const report = await cli.doctor();
  // Package standing is advisory: two held packages do not make doctor fail.
  expect(report.code).toBe(0);
  expect(report.blocked).toBe(false);
  if (report.packages.status !== "inspected") throw new Error(JSON.stringify(report.packages));
  expect(report.packages.omitted).toBe(0);
  expect(report.packages.packages.map((entry) => entry.packageId)).toEqual([
    "alpha",
    "beta",
    "gamma",
  ]);
  for (const entry of report.packages.packages) {
    const standing = standingSchema.parse(
      await cli.invoke(["package", "standing"], {
        packageId: entry.packageId,
        operationId: randomUUID(),
        expectedRevision: 0,
      }),
    ).data.standing;
    expect(entry.standing as unknown).toEqual({ status: "read", ...standing });
    const notices = noticesSchema.parse(
      await cli.invoke(["extension", "notices", "--installed", entry.packageId], undefined),
    );
    expect(entry.notices).toEqual({
      status: "counted",
      blocking: notices.notices.filter((item) => item.notice.severity === "blocking").length,
      warning: notices.notices.filter((item) => item.notice.severity === "warning").length,
      suppressed: notices.suppressed,
    });
  }
  const [alpha, beta, gamma] = report.packages.packages;
  expect(alpha?.standing).toMatchObject({ state: "eligible" });
  expect(alpha?.evaluation).toMatchObject({ status: "recorded", stale: false });
  expect(beta?.standing).toMatchObject({ state: "revoked", reason: "ecosystem-trust-revoked" });
  expect(beta?.evaluation).toBeNull();
  expect(gamma?.standing).toMatchObject({ state: "quarantined" });
  expect(report.human).toContain("Packages   3 installed, 1 eligible");
  expect(report.human).toContain("beta: revoked (ecosystem-trust-revoked)");
  expect(report.human).toContain("gamma: quarantined");
  // Names packages and states, never the home directory, a source path or key material.
  expect(JSON.stringify(report.packages)).not.toContain(root);

  // The listing is bounded and counts what it leaves out.
  const store = await openProductStoreOrThrow(localPath(join(root, "state")));
  try {
    expect(createPackageLifecycleRepository(store).installed(1)).toEqual({
      ok: true,
      value: { packageIds: ["alpha"], omitted: 2 },
    });
  } finally {
    await store.close();
  }

  // Without cached bytes the notices cannot be derived, but standing still can.
  await rm(join(root, "state", "packages"), { recursive: true });
  const damaged = await cli.doctor();
  if (damaged.packages.status !== "inspected") throw new Error(JSON.stringify(damaged.packages));
  for (const entry of damaged.packages.packages) {
    expect(entry.standing.status).toBe("read");
    expect(entry.notices.status).toBe("unavailable");
  }

  // A cancelled run reports cancellation and changes no state.
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await runDoctor(cli.services, GLOBALS, aborted.signal);
  expect(cancelled.payload?.packages).toEqual({ status: "unavailable", code: "cancelled" });
  expect((await cli.doctor()).packages).toEqual(damaged.packages);

  // A damaged installed record is reported on that package alone.
  const writer = await openProductStoreOrThrow(localPath(join(root, "state")));
  try {
    const written = writer.write((sql) =>
      sql.run("UPDATE package_versions SET metadata = '{}' WHERE package_id = 'beta'"),
    );
    expect(written.ok).toBe(true);
  } finally {
    await writer.close();
  }
  const corrupt = await cli.doctor();
  if (corrupt.packages.status !== "inspected") throw new Error(JSON.stringify(corrupt.packages));
  expect(corrupt.packages.packages.find((entry) => entry.packageId === "beta")).toMatchObject({
    revision: null,
    standing: { status: "unavailable" },
  });
  expect(
    corrupt.packages.packages
      .filter((entry) => entry.packageId !== "beta")
      .map((entry) => entry.standing.status),
  ).toEqual(["read", "read"]);
  expect(corrupt.code).toBe(0);
  // Installs, approvals, holds and an evaluation run real product work; hosted runners are slower.
}, 60_000);

test("doctor answers absent with no database and creates none", async () => {
  const root = await temporaryRoot("falryn-doctor-packages-absent-");
  const report = await fixtureCli(root).doctor();
  expect(report.packages).toEqual({ status: "absent" });
  expect(report.human).toContain("Packages   none installed (no database)");
  expect(
    await access(join(root, "state", "falryn.sqlite")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

test("the package section reports an older schema unavailable and never opens it", async () => {
  const root = await temporaryRoot("falryn-doctor-packages-older-");
  const stateRoot = localPath(join(root, "state"));
  await mkdir(stateRoot, { recursive: true });
  const older = await openProductStoreOrThrow(stateRoot, {
    migrations: PRODUCTION_MIGRATIONS.slice(0, -1),
  });
  await older.close();
  const databasePath = localPath(join(stateRoot, "falryn.sqlite"));
  const before = await probeStorage({ open: openBunSqlite, databasePath });
  expect(before).toMatchObject({
    kind: "present",
    schemaVersion: PRODUCTION_MIGRATIONS.at(-2)?.version,
    expectedVersion: PRODUCT_SCHEMA_VERSION,
  });
  // Reading package state would mean migrating; the section refuses before opening the file.
  const section = await inspectDoctorPackages(
    fixtureCli(root).services,
    before,
    databasePath,
    new AbortController().signal,
  );
  expect(section).toEqual({ status: "unavailable", code: "package-state-unavailable" });
  expect(await probeStorage({ open: openBunSqlite, databasePath })).toEqual(before);
  // Through the command, the section answers from doctor's own probe of the older file.
  const report = await fixtureCli(root).doctor();
  expect(report.packages).toEqual({ status: "unavailable", code: "package-state-unavailable" });
  expect(report.code).toBe(0);
});
