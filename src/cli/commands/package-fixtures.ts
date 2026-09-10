import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setting, stateFamily } from "../../application/extensions/package-data.fixtures.ts";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { packageConfigurationPrefix } from "../../config/resolution/package-configuration.ts";
import {
  type PackageAction,
  type PackageRequest,
  packageReceiptSchema,
} from "../../domain/extensions/lifecycle.ts";

/** The same external-process journey qualifies source and compiled composition. */
export async function packageCliJourney(command: readonly string[], root: string) {
  const source = join(root, "input-package");
  const state = join(root, "state");
  await mkdir(source);
  const manifest = (version: string) =>
    JSON.stringify(
      pluginManifest({ version: 1, configuration: [setting], state: [stateFamily] }, { version }),
    );
  await writeFile(join(source, "plugin.json"), manifest("1.0.0"));
  await writeFile(join(source, "do-not-run.js"), "throw new Error('PACKAGE-CODE-MUST-NOT-RUN')");
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    FALRYN_CONFIG_DIR: join(root, "config"),
    FALRYN_STATE_DIR: state,
    FALRYN_CACHE_DIR: join(root, "cache"),
    FALRYN_LOG_DIR: join(root, "logs"),
    FALRYN_TEMP_DIR: join(root, "temporary"),
    FALRYN_ARTIFACT_DIR: join(root, "artifacts"),
    FALRYN_EXPORT_DIR: join(root, "exports"),
    NO_COLOR: "1",
  };
  const input = join(root, "request.json");
  async function invoke(action: PackageAction, request: PackageRequest, format = "json") {
    await writeFile(input, JSON.stringify(request));
    const child = Bun.spawnSync(
      [...command, "package", action, "--input", input, "--format", format],
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
    expect(stderr).not.toContain("PACKAGE-CODE-MUST-NOT-RUN");
    const records = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const record = records.at(-1);
    expect(record.command).toBe("package");
    return { receipt: packageReceiptSchema.parse(record.payload), exitCode: child.exitCode };
  }
  const request = (revision: number, extra: Partial<PackageRequest> = {}): PackageRequest => ({
    packageId: "fixture",
    operationId: randomUUID(),
    expectedRevision: revision,
    retention: "retain",
    ...extra,
  });
  async function apply(action: PackageAction, req: PackageRequest) {
    const preview = await invoke(action, req);
    expect(preview.receipt.status).toBe("preview");
    if (preview.receipt.confirmation === null) throw new Error("missing confirmation");
    return invoke(action, { ...req, confirmation: preview.receipt.confirmation }, "jsonl");
  }
  const installRequest = request(0, { sourcePath: source });
  const inertPreview = await invoke(
    "data",
    request(0, {
      data: {
        version: 1,
        operation: "import",
        operationId: randomUUID(),
        expectedRevision: 0,
        bundle: {
          version: 1,
          exportId: randomUUID(),
          packageId: "fixture",
          configuration: [],
          state: [],
          omissions: [],
        },
      },
    }),
  );
  expect(inertPreview.receipt.status).toBe("preview");
  expect(await readdir(root)).not.toContain("state");
  const preview = await invoke("install", installRequest);
  expect(preview.receipt.status).toBe("preview");
  expect(await readdir(root)).not.toContain("state");
  const installed = await apply("install", installRequest);
  expect(installed).toMatchObject({
    exitCode: 0,
    receipt: { status: "completed", revision: 1, activation: "unavailable" },
  });
  const inspection = await invoke(
    "data",
    request(1, {
      data: { version: 1, operation: "inspect", operationId: randomUUID(), expectedRevision: 1 },
    }),
  );
  const inspected = JSON.parse(JSON.stringify(inspection.receipt.data));
  expect(inspected.status).toBe("inspected");
  const owner = inspected.payload.scopes.user as string;
  const configuration = request(1, {
    data: {
      version: 1,
      operation: "configuration",
      operationId: randomUUID(),
      expectedRevision: 1,
      layer: { scope: "user", owner, revision: 0, values: { "display.label": "configured" } },
    },
  });
  const saved = await apply("data", configuration);
  expect(saved.receipt).toMatchObject({
    status: "completed",
    revision: 1,
    dataEffect: "completed",
    data: { receipt: { afterRevision: 2 } },
  });
  expect((await invoke("data", configuration)).receipt).toMatchObject({
    status: "completed",
    revision: 1,
    data: { receipt: { afterRevision: 2 } },
  });
  const stateRequest = request(1, {
    data: {
      version: 1,
      operation: "state",
      operationId: randomUUID(),
      expectedRevision: 2,
      state: {
        version: 1,
        operation: "put",
        identity: {
          version: 1,
          packageId: "fixture",
          contribution: null,
          family: "preferences",
          key: "view",
          scope: "user",
          owner,
        },
        expectedRevision: 0,
        value: { color: "blue" },
      },
    },
  });
  expect((await apply("data", stateRequest)).receipt).toMatchObject({
    status: "completed",
    revision: 1,
    data: { receipt: { afterRevision: 3 } },
  });
  const config = Bun.spawnSync([...command, "config", "show", "--format", "json"], {
    cwd: root,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  expect(config.exitCode).toBe(0);
  const shown = new TextDecoder().decode(config.stdout);
  expect(shown).toContain(`${packageConfigurationPrefix("fixture")}.display.label`);
  expect(shown).toContain("configured");
  const configuredFile = Bun.spawnSync(
    [
      ...command,
      "config",
      "set",
      `${packageConfigurationPrefix("fixture")}.display.label`,
      "from-file-override",
      "--format",
      "json",
    ],
    { cwd: root, env: environment, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
  );
  expect(configuredFile.exitCode).toBe(0);
  const fileShown = Bun.spawnSync([...command, "config", "show", "--format", "json"], {
    cwd: root,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  expect(fileShown.exitCode).toBe(0);
  expect(new TextDecoder().decode(fileShown.stdout)).toContain("from-file");
  await writeFile(
    join(source, "plugin.json"),
    JSON.stringify(
      pluginManifest(
        {
          version: 1,
          configuration: [{ ...setting, schema: { type: "string", maxLength: 10 } }],
          state: [stateFamily],
        },
        { version: "2.0.0" },
      ),
    ),
  );
  expect((await invoke("update", request(1, { sourcePath: source }))).receipt).toMatchObject({
    status: "failed",
    code: "invalid-candidate-configuration",
    revision: 1,
  });
  expect((await invoke("inspect", request(1))).receipt).toMatchObject({
    revision: 1,
    currentDigest: installed.receipt.currentDigest,
  });
  const resumed = await invoke(
    "data",
    request(1, {
      data: {
        version: 1,
        operation: "state",
        operationId: randomUUID(),
        expectedRevision: 3,
        state: {
          version: 1,
          operation: "get",
          identity: {
            version: 1,
            packageId: "fixture",
            contribution: null,
            family: "preferences",
            key: "view",
            scope: "user",
            owner,
          },
        },
      },
    }),
  );
  expect(JSON.parse(JSON.stringify(resumed.receipt.data))).toMatchObject({
    status: "inspected",
    payload: { result: { value: { color: "blue" } } },
  });
  await writeFile(join(source, "plugin.json"), manifest("2.0.0"));
  const updated = await apply("update", request(1, { sourcePath: source }));
  expect(updated).toMatchObject({ exitCode: 0, receipt: { status: "completed", revision: 2 } });
  expect(updated.receipt.currentDigest).not.toBe(installed.receipt.currentDigest);
  const rolled = await apply(
    "rollback",
    request(2, { versionDigest: installed.receipt.currentDigest ?? undefined }),
  );
  expect(rolled.receipt.currentDigest).toBe(installed.receipt.currentDigest);
  expect((await invoke("enable", request(3))).receipt.code).toBe("activation-owner-unavailable");
  const removed = await apply("uninstall", request(3, { retention: "remove" }));
  expect(removed).toMatchObject({
    exitCode: 0,
    receipt: { status: "completed", revision: 4, currentDigest: null, pendingCleanup: 0 },
  });
  expect(removed.receipt.data).toMatchObject({
    configuration: { retained: 1 },
    state: { retained: 1 },
  });
  expect(await readdir(join(state, "packages"))).toEqual([]);
  expect(await readdir(source)).toContain("plugin.json");
}
