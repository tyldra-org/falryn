import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
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
  const manifest = (version: string) => JSON.stringify(pluginManifest(undefined, { version }));
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
  const preview = await invoke("install", installRequest);
  expect(preview.receipt.status).toBe("preview");
  expect(await readdir(root)).not.toContain("state");
  const installed = await apply("install", installRequest);
  expect(installed).toMatchObject({
    exitCode: 0,
    receipt: { status: "completed", revision: 1, activation: "unavailable" },
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
  expect(await readdir(join(state, "packages"))).toEqual([]);
  expect(await readdir(source)).toContain("plugin.json");
}
