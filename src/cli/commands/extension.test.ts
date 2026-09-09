import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageInspectionLines } from "../../application/extensions/inspection-report.ts";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { parseInvocation } from "../command-tree.ts";
import { createServiceProvider } from "../runtime/services.ts";
import { runExtensionInspect } from "./extension.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
test("routes an explicit directory and rejects missing paths or activation verbs", async () => {
  const parsed = await parseInvocation(["extension", "inspect", "./package", "--format", "json"]);
  expect(parsed.kind === "run" && parsed.command).toBe("extension.inspect");
  expect(parsed.kind === "run" && parsed.extensionPath).toBe("./package");
  expect((await parseInvocation(["extension", "inspect"])).kind).toBe("invalid");
  expect((await parseInvocation(["extension", "activate", "./package"])).kind).toBe("invalid");
});
test("command exposes only its safe inspection projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "falryn-extension-command-"));
  roots.push(root);
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify(pluginManifest({ version: 1 }, { unknown: "PRIVATE-METADATA" })),
  );
  const result = await runExtensionInspect(root);
  expect(result.command).toBe("extension.inspect");
  expect(result.payload?.status).toBe("inspected");
  expect(JSON.stringify(result)).not.toContain("PRIVATE-METADATA");
  await writeFile(join(root, "plugin.json"), "bad json");
  const failed = await runExtensionInspect(root);
  expect(failed.payload?.status).toBe("failed");
  expect(failed.errors).toHaveLength(1);
});

test("public command previews and persists exact trust; same names and changed bytes never inherit approval", async () => {
  const home = await mkdtemp(join(tmpdir(), "falryn-trust-command-"));
  roots.push(home);
  const packageRoot = join(home, "package");
  const otherRoot = join(home, "other");
  await mkdir(packageRoot);
  await mkdir(otherRoot);
  const manifest = JSON.stringify(
    pluginManifest(
      { version: 1 },
      { author: { name: "claimed-publisher" }, unknown: "PRIVATE-METADATA" },
    ),
  );
  await writeFile(join(packageRoot, "plugin.json"), manifest);
  await writeFile(join(otherRoot, "plugin.json"), manifest);
  const parsed = await parseInvocation([
    "extension",
    "inspect",
    packageRoot,
    "--format",
    "json",
    "--non-interactive",
  ]);
  if (parsed.kind !== "run") throw new Error("parse");
  const services = () =>
    createServiceProvider(parsed.options, {
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: join(home, "state"),
        FALRYN_CONFIG_DIR: join(home, "config"),
      }),
      home: localPath(home),
      currentDirectory: localPath(home),
    });
  const expiresAt = Date.now() + 60_000;
  const request = { action: "approve" as const, expiresAt };
  const preview = await runExtensionInspect(packageRoot, undefined, services(), request);
  const evidence = preview.payload?.status === "inspected" ? preview.payload.trust : null;
  if (evidence?.status !== "preview" || evidence.confirmation === null)
    throw new Error(JSON.stringify(preview));
  expect(evidence.trust.subject.ownership.publisher).toBeNull();
  expect(JSON.stringify(preview)).not.toContain("PRIVATE-METADATA");
  const input = join(home, "request.json");
  await writeFile(input, JSON.stringify({ ...request, confirmation: evidence.confirmation }));
  const invocation = await parseInvocation(["extension", "trust", packageRoot, "--input", input]);
  expect(invocation.kind === "run" && invocation.extensionTrust?.confirmation).toBe(
    evidence.confirmation,
  );
  const applied = await runExtensionInspect(packageRoot, undefined, services(), {
    ...request,
    confirmation: evidence.confirmation,
  });
  expect(applied.effect.observed).toBe("completed");
  const restarted = await runExtensionInspect(packageRoot, undefined, services());
  expect(restarted.payload).toMatchObject({ trust: { trust: { state: "user-approved" } } });
  if (restarted.payload !== null)
    expect(packageInspectionLines(restarted.payload).join("\n")).toContain("Trust: user-approved");
  expect((await runExtensionInspect(otherRoot, undefined, services())).payload).toMatchObject({
    trust: { trust: { state: "unverified" } },
  });
  await writeFile(
    join(packageRoot, "plugin.json"),
    JSON.stringify(pluginManifest({ version: 1 }, { description: "changed" })),
  );
  expect((await runExtensionInspect(packageRoot, undefined, services())).payload).toMatchObject({
    trust: { trust: { state: "unverified" } },
  });
  const stale = await runExtensionInspect(packageRoot, undefined, services(), {
    ...request,
    confirmation: evidence.confirmation,
  });
  expect(stale.payload).toMatchObject({ trust: { code: "stale-trust-confirmation" } });
  expect(stale.effect.observed).toBe("none");
});
