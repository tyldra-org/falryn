import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { buildIdentity, FALRYN_VERSION, runModeFor, versionText } from "./version.ts";

const MANIFEST = join(dirname(dirname(dirname(import.meta.path))), "package.json");

describe("the reported version", () => {
  test("matches the package manifest", async () => {
    // The constant is duplicated on purpose — a compiled executable has no
    // `package.json` beside it and `rootDir` keeps the manifest out of the
    // module graph. This is what stops the duplication drifting silently.
    const manifest: unknown = JSON.parse(await readFile(MANIFEST, "utf8"));
    const version =
      typeof manifest === "object" && manifest !== null && "version" in manifest
        ? manifest.version
        : null;

    expect(version).toBe(FALRYN_VERSION);
  });
});

describe("the run mode", () => {
  test("reads compiled from the module root a standalone executable mounts", () => {
    // `bun build --compile` mounts modules under `/$bunfs/`. The prefix is the
    // one signal that does not depend on what the binary was named or where it
    // was copied to.
    expect(runModeFor("file:///$bunfs/root/falryn")).toBe("compiled");
    expect(runModeFor("file:///Users/someone/falryn/src/main.ts")).toBe("source");
    // Windows mounts the same graph under a drive letter, because a file URL
    // without one is invalid. Missing this is what made the compiled Windows
    // executable report `source build` to a user reading `--version`.
    expect(runModeFor("file:///B:/~BUN/root/falryn")).toBe("compiled");
    expect(runModeFor("B:\\~BUN\\root\\falryn")).toBe("compiled");
    expect(runModeFor("file:///C:/Users/someone/falryn/src/main.ts")).toBe("source");
    // A checkout that happens to contain the literal name is still a source
    // run, because the marker is a path root rather than a substring anywhere.
    expect(runModeFor("file:///Users/someone/bunfs/src/main.ts")).toBe("source");
  });

  test("reports source when this test runs it", () => {
    // `bun test` interprets, so the identity this process reports is `source`.
    // `src/main.compiled.test.ts` asserts the other branch on a real binary.
    expect(buildIdentity().mode).toBe("source");
  });
});

describe("version output", () => {
  test("names the build rather than printing a bare number", () => {
    // The first question a bug report has to answer is which Falryn ran.
    const text = versionText({
      version: "1.2.3",
      bun: "1.3.14",
      platform: "darwin",
      architecture: "arm64",
      mode: "compiled",
    });

    expect(text.split("\n")).toEqual([
      "falryn 1.2.3",
      "bun 1.3.14",
      "darwin arm64",
      "compiled build",
    ]);
  });

  test("reports this process without being told anything", () => {
    const text = versionText();
    expect(text).toContain(`falryn ${FALRYN_VERSION}`);
    expect(text).toContain(`bun ${Bun.version}`);
    expect(text).toContain(process.platform);
  });
});
