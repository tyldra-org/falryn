import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { parseInvocation } from "../command-tree.ts";
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
