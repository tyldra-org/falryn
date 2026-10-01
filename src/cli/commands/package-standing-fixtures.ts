import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { openProductStoreOrThrow } from "../../data/fixtures.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { localPath } from "../../domain/workspace/index.ts";

type Receipt = z.infer<typeof packageReceiptSchema>;
type Standing = {
  state: string;
  reason: string | null;
  revision: number;
  identityDigest: string | null;
  lastKnownGood: string | null;
  dependencies: { id: string; state: string; eligible: boolean }[];
  recovery: { choice: string; versionDigest?: string }[];
  versions: { identityDigest: string; packageVersion: string | null; state: string }[];
};

/**
 * One user's journey through revocation, a blocked dependent, rollback and quarantine, every step
 * its own process so each is a restart, and with the package sources deleted so each is offline.
 */
export async function packageStandingCliJourney(command: readonly string[], root: string) {
  const environment = {
    PATH: process.env.PATH ?? "",
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? "",
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
  async function invoke<T>(args: string[], input: unknown, schema: z.ZodType<T>) {
    const file = join(root, "request.json");
    await writeFile(file, JSON.stringify(input));
    const child = Bun.spawnSync([...command, ...args, "--input", file, "--format", "json"], {
      cwd: root,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    const stdout = new TextDecoder().decode(child.stdout);
    if (stdout.trim() === "")
      throw new Error(
        `${args.join(" ")} produced no output (exit ${child.exitCode}): ${new TextDecoder().decode(child.stderr).slice(0, 2_000)}`,
      );
    const decoded = z
      .object({ payload: z.unknown() })
      .parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "null"));
    const parsed = schema.safeParse(decoded.payload);
    if (!parsed.success) throw new Error(`${args.join(" ")}: ${JSON.stringify(decoded.payload)}`);
    return parsed.data;
  }
  const receipt = (args: string[], input: unknown) => invoke(args, input, packageReceiptSchema);
  async function apply(action: string, input: Record<string, unknown>) {
    const preview = await receipt(["package", action], input);
    expect(preview.status).toBe("preview");
    return receipt(["package", action], { ...input, confirmation: preview.confirmation });
  }
  async function standing(packageId: string): Promise<Standing> {
    const read = await receipt(["package", "standing"], {
      packageId,
      operationId: randomUUID(),
      expectedRevision: 0,
    });
    expect(read).toMatchObject({ status: "completed", code: "standing" });
    // Standing names digests and package ids, never a source path or the home directory.
    expect(JSON.stringify(read)).not.toContain(root);
    return (read.data as { standing: Standing }).standing;
  }
  /** The same standing as a person reads it in a terminal. */
  async function humanStanding(packageId: string) {
    const file = join(root, "request.json");
    await writeFile(
      file,
      JSON.stringify({ packageId, operationId: randomUUID(), expectedRevision: 0 }),
    );
    const child = Bun.spawnSync(
      [...command, "package", "standing", "--input", file, "--format", "human"],
      {
        cwd: root,
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    return new TextDecoder().decode(child.stdout);
  }
  const trustSchema = z.object({ trust: z.object({ status: z.string() }) });
  async function approve(source: string) {
    const request = { action: "approve", expiresAt: Date.now() + 600_000 };
    const preview = await invoke(["extension", "trust", source], request, z.unknown());
    const confirmation = (preview as { trust: { confirmation: string } }).trust.confirmation;
    const applied = await invoke(
      ["extension", "trust", source],
      { ...request, confirmation },
      trustSchema,
    );
    expect(applied.trust.status).toBe("applied");
  }
  /** `extension trust` over a source path with any action; returns the applied trust state. */
  async function trustAction(source: string, request: Record<string, unknown>) {
    const preview = await invoke(["extension", "trust", source], request, z.unknown());
    const confirmation = (preview as { trust: { confirmation: string } }).trust.confirmation;
    return invoke(
      ["extension", "trust", source],
      { ...request, confirmation },
      z.object({ trust: z.object({ status: z.string(), state: z.string().optional() }) }),
    );
  }
  async function writeSource(name: string, packageName: string, version: string, extra = {}) {
    const dir = join(root, name);
    await mkdir(dir);
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify(pluginManifest({ version: 1, ...extra }, { name: packageName, version })),
    );
    return dir;
  }
  const request = (packageId: string, expectedRevision: number, extra = {}) => ({
    packageId,
    operationId: randomUUID(),
    expectedRevision,
    ...extra,
  });

  // Install and approve the base package, update it, then install and approve a dependent.
  const baseV1 = await writeSource("base-v1", "fixture", "1.0.0");
  const baseV2 = await writeSource("base-v2", "fixture", "1.1.0");
  const dependentSource = await writeSource("dependent", "dependent", "1.0.0", {
    dependencies: [{ id: "fixture", range: "^1.0.0" }],
  });
  expect((await apply("install", request("fixture", 0, { sourcePath: baseV1 }))).status).toBe(
    "completed",
  );
  await approve(baseV1);
  expect((await apply("update", request("fixture", 1, { sourcePath: baseV2 }))).status).toBe(
    "completed",
  );
  await approve(baseV2);
  expect(
    (await apply("install", request("dependent", 0, { sourcePath: dependentSource }))).status,
  ).toBe("completed");
  await approve(dependentSource);
  // `extension trust` holds a source path too: quarantine, release (which approves nothing), approve.
  expect(
    (
      await trustAction(dependentSource, {
        action: "quarantine",
        expiresAt: null,
        reason: "policy",
      })
    ).trust.status,
  ).toBe("applied");
  expect(
    (await trustAction(dependentSource, { action: "release", expiresAt: null })).trust.status,
  ).toBe("applied");
  await approve(dependentSource);
  // From here on there is no source and no network: only installed records.
  for (const dir of [baseV1, baseV2, dependentSource]) await rm(dir, { recursive: true });

  const healthy = await standing("dependent");
  expect(healthy).toMatchObject({ state: "eligible", dependencies: [{ id: "fixture" }] });
  const before = await standing("fixture");
  expect(before.state).toBe("eligible");
  const v1 = before.versions.find((entry) => entry.packageVersion === "1.0.0");
  if (v1 === undefined) throw new Error("retained v1 missing");
  expect(before.lastKnownGood).toBe(v1.identityDigest);

  // Revoking the dependency blocks its dependent and offers recovery without choosing for the user.
  const revoked = await apply("revoke", request("fixture", before.revision, { reason: "policy" }));
  expect(revoked).toMatchObject({ status: "completed", code: "revoked" });
  expect(revoked.data).toMatchObject({
    before: "eligible",
    standing: { state: "revoked" },
    runningWork: {
      newAdmission: "denied-immediately",
      runningAttempts: "stopped-at-next-boundary",
    },
  });
  expect(await standing("dependent")).toMatchObject({
    state: "dependency-blocked",
    reason: "dependency-not-eligible",
    dependencies: [{ id: "fixture", state: "revoked", eligible: false }],
  });
  const human = await humanStanding("dependent");
  expect(human).toContain("standing: dependency-blocked (dependency-not-eligible)");
  expect(human).toContain("dependency fixture: revoked (ecosystem-trust-revoked)");
  expect(human).toContain("recovery choices: inspect, update, uninstall");
  const revokedStanding = await standing("fixture");
  expect(revokedStanding.state).toBe("revoked");
  expect(revokedStanding.identityDigest).toBe(before.identityDigest);
  expect(revokedStanding.recovery).toContainEqual({
    choice: "rollback",
    versionDigest: v1.identityDigest,
  });

  // A rollback that cannot proceed names why and changes nothing.
  const failed = await receipt(
    ["package", "rollback"],
    request("fixture", revokedStanding.revision, {
      versionDigest: `sha256:${"0".repeat(64)}`,
    }),
  );
  expect(failed).toMatchObject({ status: "failed", code: "rollback-version-unavailable" });
  expect((await standing("fixture")).revision).toBe(revokedStanding.revision);

  // A live dependent locks the revoked version, so rolling the dependency back is refused.
  const rollback = request("fixture", revokedStanding.revision, {
    versionDigest: v1.identityDigest,
  });
  const rollbackPreview = await receipt(["package", "rollback"], rollback);
  expect(rollbackPreview).toMatchObject({
    status: "preview",
    data: { rollback: { restoresApproval: false, target: { state: "eligible" } } },
  });
  expect(
    await receipt(["package", "rollback"], {
      ...rollback,
      confirmation: rollbackPreview.confirmation,
    }),
  ).toMatchObject({ status: "failed", code: "package-required" });
  expect(await standing("fixture")).toMatchObject({
    state: "revoked",
    identityDigest: before.identityDigest,
  });

  // Quarantine keeps its bytes until a purge that previews what it deletes.
  const dependent = await standing("dependent");
  const quarantined = await apply(
    "quarantine",
    request("dependent", dependent.revision, { reason: "unexpected-behavior" }),
  );
  expect(quarantined).toMatchObject({ status: "completed", code: "quarantined" });
  const removal = request("dependent", dependent.revision, { retention: "remove" });
  const refused = await receipt(["package", "uninstall"], removal);
  expect(refused).toMatchObject({ status: "failed", code: "quarantined-evidence-retained" });
  expect(refused.data).toMatchObject({ quarantinedEvidence: { versions: 1 } });
  expect((await standing("dependent")).state).toBe("quarantined");
  const purged = await apply("uninstall", { ...removal, purgeQuarantined: true });
  expect(purged).toMatchObject({ status: "completed", code: "uninstalled" });
  expect((await standing("dependent")).state).toBe("not-installed");

  // With the dependent gone, the explicit rollback restores the retained approved bytes. It restores
  // bytes only: the package is inert and its eligibility is whatever that version's own record says.
  const rolled = await apply("rollback", { ...rollback, operationId: randomUUID() });
  expect(rolled).toMatchObject({ status: "completed", activation: "unavailable" });
  expect(await standing("fixture")).toMatchObject({
    state: "eligible",
    identityDigest: v1.identityDigest,
  });

  // The decisions and their receipts outlive the removed bytes.
  const store = await openProductStoreOrThrow(localPath(join(root, "state")));
  try {
    const rows = store.read("SELECT DISTINCT action FROM package_trust_receipts ORDER BY action");
    if (!rows.ok) throw new Error(rows.error.code);
    expect(rows.value.map((row) => row.action)).toEqual([
      "approve",
      "quarantine",
      "release",
      "revoke",
    ]);
  } finally {
    await store.close();
  }
  return { revoked, rolled, purged } satisfies Record<string, Receipt>;
}

/** Standing with no database: human and JSON both say nothing is installed and what can be done. */
export function packageStandingEmptyJourney(command: readonly string[], root: string) {
  const run = (format: string) => {
    const file = join(root, "request.json");
    Bun.write(
      file,
      JSON.stringify({ packageId: "fixture", operationId: randomUUID(), expectedRevision: 0 }),
    );
    return Bun.spawnSync([...command, "package", "standing", "--input", file, "--format", format], {
      cwd: root,
      env: {
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
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
  };
  const human = new TextDecoder().decode(run("human").stdout);
  expect(human).toContain("fixture: completed (standing)");
  expect(human).toContain("standing: not-installed");
  expect(human).toContain("recovery choices: inspect");
  const json = new TextDecoder().decode(run("json").stdout);
  const payload = z
    .object({ payload: z.unknown() })
    .parse(JSON.parse(json.trim().split("\n").at(-1) ?? "null")).payload;
  const parsed = packageReceiptSchema.parse(payload);
  expect(parsed).toMatchObject({
    status: "completed",
    code: "standing",
    data: { standing: { state: "not-installed" } },
  });
}
