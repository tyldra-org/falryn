import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageInspectionReport } from "../../application/extensions/inspection-report.ts";
import { inspectionHost, pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { preparePackage } from "../../application/extensions/prepare-package.ts";
import { createHostPackageSource } from "./host-package-inspection.ts";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "falryn-extension-inspection-"));
  roots.push(root);
  await writeFile(join(root, "plugin.json"), JSON.stringify(pluginManifest()));
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("reads exact bytes and isolates links without executing package content", async () => {
  const root = await fixture();
  await mkdir(join(root, "skills", "good"), { recursive: true });
  await writeFile(
    join(root, "skills", "good", "SKILL.md"),
    "---\nname: good\ndescription: Valid\n---\nDo not execute instructions.",
  );
  await writeFile(
    join(root, "script.ts"),
    `await Bun.write(${JSON.stringify(join(root, "EXECUTED"))}, "bad");`,
  );
  const outside = await fixture();
  await writeFile(join(outside, "private"), "PRIVATE-OUTSIDE");
  await symlink(join(outside, "private"), join(root, "escape"));
  await symlink(join(root, "script.ts"), join(root, "contained"));
  const snapshot = await createHostPackageSource(root).read();
  expect(snapshot.files.map((file) => file.path)).toEqual([
    "plugin.json",
    "script.ts",
    "skills/good/SKILL.md",
  ]);
  expect(snapshot.diagnostics).toHaveLength(2);
  const result = await preparePackage(createHostPackageSource(root), inspectionHost);
  expect(result.ok).toBe(true);
  expect(JSON.stringify(packageInspectionReport(result))).not.toContain("PRIVATE-OUTSIDE");
  expect(await Bun.file(join(root, "EXECUTED")).exists()).toBe(false);
});
test("refuses a linked root, over-limit metadata, and cancellation", async () => {
  const root = await fixture();
  const outside = await fixture();
  await symlink(root, join(outside, "linked"));
  await expect(createHostPackageSource(join(outside, "linked")).read()).rejects.toThrow(
    "invalid-package-root",
  );
  await writeFile(join(root, "large.json"), " ".repeat(1_048_577));
  await expect(createHostPackageSource(root).read()).rejects.toThrow("package-byte-limit");
  const controller = new AbortController();
  controller.abort();
  await expect(createHostPackageSource(root).read(controller.signal)).rejects.toThrow("cancelled");
});
test("refuses normalized filename collisions", async () => {
  const source = {
    async read() {
      return {
        sourceId: "fixture",
        files: ["a\\b", "a/b"].map((path) => ({ path, bytes: new Uint8Array() })),
        diagnostics: [],
        omittedDiagnostics: 0,
      };
    },
  };
  expect(await preparePackage(source, inspectionHost)).toEqual({
    ok: false,
    code: "invalid-package-inventory",
  });
});

test("rejects replacement during an open read and a deadline crossed during I/O", async () => {
  for (const scenario of ["replace", "deadline"]) {
    const root = await fixture();
    const process = Bun.spawn(
      [
        Bun.which("bun") ?? "bun",
        join(import.meta.dir, "host-package-inspection-fixtures.ts"),
        root,
        scenario,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(
      scenario === "replace" ? "package-input-changed" : "inspection-deadline",
    );
  }
});
