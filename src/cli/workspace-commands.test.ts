/**
 * The `falryn workspace` command surface against a real temporary tree (#606).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStaticEnvironment, localPath } from "../domain/index.ts";
import { parseInvocation } from "./command-tree.ts";
import { dispatch } from "./dispatch.ts";
import { EXIT_CODES } from "./exit.ts";
import type { GlobalOptions } from "./options.ts";
import { createServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

async function seededHome(): Promise<{
  readonly home: string;
  readonly primary: string;
  readonly secondary: string;
  readonly environment: ReturnType<typeof createStaticEnvironment>;
}> {
  const home = await mkdtemp(join(tmpdir(), "falryn-workspace-cli-"));
  homes.push(home);
  const state = join(home, "state");
  const config = join(home, "config");
  const primary = join(home, "primary");
  const secondary = join(home, "secondary");
  for (const directory of [home, state, config, primary, secondary]) {
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o700);
  }
  return {
    home,
    primary,
    secondary,
    environment: createStaticEnvironment({
      FALRYN_STATE_DIR: state,
      FALRYN_CONFIG_DIR: config,
    }),
  };
}

function providerFor(seeded: Awaited<ReturnType<typeof seededHome>>) {
  return (globals: GlobalOptions) =>
    createServiceProvider(globals, {
      home: localPath(seeded.home),
      platform: "darwin",
      environment: seeded.environment,
      currentDirectory: localPath(seeded.primary),
    });
}

async function run(argv: readonly string[], seeded: Awaited<ReturnType<typeof seededHome>>) {
  const streams = createRecordingCliStreams();
  const code = await dispatch({
    argv,
    streams,
    services: providerFor(seeded),
  });
  return {
    code,
    out: streams.resultWrites().join(""),
    err: streams.diagnosticWrites().join(""),
  };
}

describe("workspace command parsing", () => {
  test("routes list, show, save, and load", async () => {
    expect((await parseInvocation(["workspace", "list"])).kind).toBe("run");
    expect((await parseInvocation(["workspace", "show"])).kind).toBe("run");
    const save = await parseInvocation(["workspace", "save", "falryn-app"]);
    expect(save.kind).toBe("run");
    if (save.kind === "run") {
      expect(save.command).toBe("workspace.save");
      expect(save.workspaceArgs).toEqual({
        action: "save",
        name: "falryn-app",
        force: false,
      });
    }
    const load = await parseInvocation(["workspace", "load", "falryn-app"]);
    expect(load.kind).toBe("run");
    if (load.kind === "run") {
      expect(load.command).toBe("workspace.load");
    }
  });

  test("requires --force to overwrite on save parse shape", async () => {
    const forced = await parseInvocation(["workspace", "save", "falryn-app", "--force"]);
    expect(forced.kind).toBe("run");
    if (forced.kind === "run") {
      expect(forced.workspaceArgs).toEqual({
        action: "save",
        name: "falryn-app",
        force: true,
      });
    }
  });

  test("parses repeatable --add-dir", async () => {
    const invocation = await parseInvocation([
      "--add-dir",
      "/tmp/a",
      "--add-dir",
      "/tmp/b",
      "workspace",
      "show",
    ]);
    expect(invocation.kind).toBe("run");
    if (invocation.kind === "run") {
      expect(invocation.options.addDirs).toEqual(["/tmp/a", "/tmp/b"]);
    }
  });
});

describe("workspace command dispatch", () => {
  test("saves, lists, loads, and shows across output contracts", async () => {
    const seeded = await seededHome();

    const saved = await run(
      [
        "--workspace",
        seeded.primary,
        "--add-dir",
        seeded.secondary,
        "--non-interactive",
        "workspace",
        "save",
        "falryn-app",
      ],
      seeded,
    );
    expect(saved.code).toBe(EXIT_CODES.COMPLETED);
    expect(saved.out).toContain("falryn-app");
    expect(saved.out).toContain(seeded.primary);
    expect(saved.out).toContain(seeded.secondary);

    const listed = await run(["--format", "quiet", "workspace", "list"], seeded);
    expect(listed.code).toBe(EXIT_CODES.COMPLETED);
    expect(listed.out).toContain("falryn-app");

    const shown = await run(
      ["--workspace", "falryn-app", "--format", "json", "workspace", "show"],
      seeded,
    );
    expect(shown.code).toBe(EXIT_CODES.COMPLETED);
    const showRecord = JSON.parse(shown.out.trim()) as {
      payload?: { roots?: { path: string }[]; layoutName?: string };
    };
    expect(showRecord.payload?.layoutName).toBe("falryn-app");
    expect(showRecord.payload?.roots?.map((root) => root.path).sort()).toEqual(
      [realpathSync(seeded.primary), realpathSync(seeded.secondary)].sort(),
    );

    const loaded = await run(
      ["--format", "jsonl", "--non-interactive", "workspace", "load", "falryn-app"],
      seeded,
    );
    expect(loaded.code).toBe(EXIT_CODES.COMPLETED);
    expect(loaded.out).toContain(seeded.primary);
  });

  test("refuses overwrite without --force", async () => {
    const seeded = await seededHome();
    const first = await run(["--workspace", seeded.primary, "workspace", "save", "once"], seeded);
    expect(first.code).toBe(EXIT_CODES.COMPLETED);

    const second = await run(["--workspace", seeded.primary, "workspace", "save", "once"], seeded);
    expect(second.code).not.toBe(EXIT_CODES.COMPLETED);
    expect(second.err + second.out).toContain("--force");
  });
});
