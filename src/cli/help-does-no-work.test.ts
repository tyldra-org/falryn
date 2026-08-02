/**
 * The negative control behind `reference/CLI.md`'s rule that help does no work.
 *
 * Help must initialize no provider, open no database for mutation, scan no
 * workspace, and start no integration. Asserting that by reading the code is
 * how it stops being true six commits later, so instead every path that must
 * not construct a service is run against a provider that throws if it is
 * called at all — and the whole point of `ServiceProvider` being a function is
 * that this is possible.
 *
 * It also asserts the positive: a command that *should* build services does,
 * so the control is testing a boundary rather than an unreachable branch.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStaticEnvironment, localPath } from "../domain/index.ts";
import { dispatch } from "./dispatch.ts";
import { EXIT_CODES } from "./exit.ts";
import type { ServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

/** A provider that fails the test if anything asks it for a service. */
function poisoned(): ServiceProvider {
  return () => {
    throw new Error("a service was constructed on a path that must construct none");
  };
}

const roots: string[] = [];

async function temporaryHome(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "falryn-help-"));
  roots.push(created);
  return created;
}

async function cleanup(): Promise<void> {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

describe("help and version", () => {
  test("construct no service, on every form", async () => {
    for (const argv of [
      [],
      ["--help"],
      ["-h"],
      ["--version"],
      ["config", "--help"],
      ["doctor", "--help"],
      ["config", "show", "--help"],
      // Invalid usage is refused before any work too, which is the same rule
      // stated from the other side: nothing is constructed to reject a flag.
      ["--nope"],
      ["--quiet", "--verbose"],
    ]) {
      const streams = createRecordingCliStreams();
      const permitted: readonly number[] = [EXIT_CODES.COMPLETED, EXIT_CODES.INVALID_USAGE];
      const code: number = await dispatch({ argv, streams, services: poisoned });
      expect(permitted).toContain(code);
    }
  });

  test("put help on stdout and refusals on stderr", async () => {
    const help = createRecordingCliStreams();
    expect(await dispatch({ argv: ["--help"], streams: help, services: poisoned })).toBe(
      EXIT_CODES.COMPLETED,
    );
    // Help is the result of asking for help, so it is the result format.
    expect(help.resultWrites().join("")).toContain("falryn [command] [options]");
    expect(help.diagnosticWrites()).toEqual([]);

    const invalid = createRecordingCliStreams();
    expect(await dispatch({ argv: ["--nope"], streams: invalid, services: poisoned })).toBe(
      EXIT_CODES.INVALID_USAGE,
    );
    // An invocation with no result writes nothing to stdout, however much it
    // has to say on stderr.
    expect(invalid.resultWrites()).toEqual([]);
    expect(invalid.diagnosticWrites().join("")).toContain("Unknown argument: nope");
  });

  test("create no directory and no database", async () => {
    const home = await temporaryHome();
    try {
      for (const argv of [["--help"], ["--version"], []]) {
        const streams = createRecordingCliStreams();
        await dispatch({
          argv,
          streams,
          serviceOverrides: {
            home: localPath(home),
            platform: "darwin",
            environment: createStaticEnvironment({ FALRYN_STATE_DIR: home }),
          },
        });
      }
      // Nothing was constructed, so nothing was resolved, so nothing was made.
      expect(await readdir(home)).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("a command that needs services", () => {
  test("does construct them, so the control above tests a real boundary", async () => {
    let constructed = 0;
    const counting: ServiceProvider = () => {
      constructed += 1;
      throw new Error("stop here; construction is the only fact under test");
    };

    const streams = createRecordingCliStreams();
    // `doctor` catches its own failures into a result, so this reports a
    // failure rather than throwing — what matters is that it asked at all.
    await dispatch({ argv: ["doctor"], streams, services: () => counting });
    expect(constructed).toBe(1);
  });
});
