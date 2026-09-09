import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageInspectionLines } from "../../application/extensions/inspection-report.ts";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { signedVerification } from "../../application/extensions/provenance-fixtures.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { parseInvocation } from "../command-tree.ts";
import { createServiceProvider } from "../runtime/services.ts";
import { runExtensionInspect } from "./extension.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("public trust input verifies offline evidence, confirms refresh, and exposes revocation after restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "falryn-signature-command-"));
  roots.push(home);
  const packageRoot = join(home, "package");
  await mkdir(packageRoot);
  await writeFile(join(packageRoot, "plugin.json"), JSON.stringify(pluginManifest()));
  const invocation = await parseInvocation([
    "extension",
    "inspect",
    packageRoot,
    "--format",
    "json",
    "--non-interactive",
  ]);
  if (invocation.kind !== "run") throw new Error("parse");
  const services = () =>
    createServiceProvider(invocation.options, {
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: join(home, "state"),
        FALRYN_CONFIG_DIR: join(home, "config"),
      }),
      home: localPath(home),
      currentDirectory: localPath(home),
    });
  const inspected = await runExtensionInspect(packageRoot, undefined, services());
  const inspectedTrust = inspected.payload?.status === "inspected" ? inspected.payload.trust : null;
  if (inspectedTrust == null || inspectedTrust.status === "failed") throw new Error("inspect");
  const observation = {
    ...inspectedTrust.trust,
    actor: inspectedTrust.trust.scope.authority,
    now: Date.now(),
  };
  const verification = signedVerification(observation, { status: "revoked" });
  const request = { action: "refresh" as const, expiresAt: null, verification };
  const input = join(home, "request.json");
  await writeFile(input, JSON.stringify(request));
  const parsed = await parseInvocation(["extension", "trust", packageRoot, "--input", input]);
  if (parsed.kind !== "run") throw new Error("refresh parse");
  const preview = await runExtensionInspect(
    packageRoot,
    undefined,
    services(),
    parsed.extensionTrust,
  );
  const projected = preview.payload?.status === "inspected" ? preview.payload.trust : null;
  if (projected?.status !== "preview" || projected.confirmation === null)
    throw new Error("refresh preview");
  expect(preview.effect.observed).toBe("none");
  expect(projected.trust).toMatchObject({
    state: "revoked",
    eligible: false,
    evidence: { signature: "verified", curation: "unavailable" },
  });
  expect(JSON.stringify(preview)).not.toContain(verification.keys[0]?.publicKey ?? "missing");
  const applied = await runExtensionInspect(packageRoot, undefined, services(), {
    ...request,
    confirmation: projected.confirmation,
  });
  expect(applied.effect.observed).toBe("completed");
  const restarted = await runExtensionInspect(packageRoot, undefined, services());
  expect(restarted.payload).toMatchObject({
    trust: { trust: { state: "revoked", eligible: false } },
  });
  if (restarted.payload != null)
    expect(packageInspectionLines(restarted.payload).join("\n")).toContain("signature: verified");
  const denied = await runExtensionInspect(packageRoot, undefined, services(), {
    action: "approve",
    expiresAt: Date.now() + 10000,
  });
  expect(denied.payload).toMatchObject({ trust: { code: "trust-evidence-denied" } });
  await writeFile(
    input,
    JSON.stringify({ action: "grant", expiresAt: null, identity: { mode: "full-user" } }),
  );
  expect((await parseInvocation(["extension", "trust", packageRoot, "--input", input])).kind).toBe(
    "invalid",
  );
  await writeFile(input, '{"action":"approve","action":"revoke","expiresAt":null}');
  expect((await parseInvocation(["extension", "trust", packageRoot, "--input", input])).kind).toBe(
    "invalid",
  );
  await writeFile(input, " ".repeat(65_537));
  expect((await parseInvocation(["extension", "trust", packageRoot, "--input", input])).kind).toBe(
    "invalid",
  );
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
