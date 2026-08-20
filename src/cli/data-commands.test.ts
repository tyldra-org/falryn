import { describe, expect, test } from "bun:test";

import {
  createInMemoryFileSystem,
  createStaticEnvironment,
  type InMemoryNode,
  localPath,
} from "../domain/index.ts";
import { runDataReset, runDataUninstall, stoppedResult } from "./commands.ts";
import { dispatch } from "./dispatch.ts";
import { EXIT_CODES, resolveExitCode } from "./exit.ts";
import type { GlobalOptions } from "./options.ts";
import { readCliStream } from "./schema.ts";
import { createServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

const ROOTS = {
  FALRYN_CONFIG_DIR: "/d/config",
  FALRYN_STATE_DIR: "/d/state",
  FALRYN_CACHE_DIR: "/d/cache",
  FALRYN_LOG_DIR: "/d/logs",
  FALRYN_TEMP_DIR: "/d/tmp",
  FALRYN_ARTIFACT_DIR: "/d/artifacts",
  FALRYN_EXPORT_DIR: "/d/exports",
};

const DEFAULTS: GlobalOptions = {
  format: "human",
  color: "auto",
  quiet: false,
  verbose: false,
  nonInteractive: false,
  workspace: null,
  addDirs: [],
  profile: null,
  timeoutMs: null,
  help: false,
  version: false,
};

const TREE: Readonly<Record<string, InMemoryNode>> = {
  "/d": { kind: "directory" },
  "/d/config": { kind: "directory" },
  "/d/config/settings.jsonc": { kind: "file", byteLength: 120 },
  "/d/logs": { kind: "directory" },
  "/d/logs/old.log": { kind: "file", byteLength: 400 },
  "/d/logs/today": { kind: "directory" },
  "/d/logs/today/run.log": { kind: "file", byteLength: 100 },
  "/d/exports": { kind: "directory" },
  "/d/exports/session.zip": { kind: "file", byteLength: 900 },
  "/Users/example": { kind: "directory" },
  "/Users/example/project": { kind: "directory" },
  "/Users/example/project/src.ts": { kind: "file", byteLength: 30 },
};

function providerFor(fileSystem: ReturnType<typeof createInMemoryFileSystem>) {
  return (globals: GlobalOptions) =>
    createServiceProvider(globals, {
      fileSystem,
      environment: createStaticEnvironment(ROOTS),
      home: localPath("/Users/example"),
      platform: "darwin",
      currentDirectory: localPath("/Users/example/project"),
    });
}

async function previewLogs(fileSystem: ReturnType<typeof createInMemoryFileSystem>) {
  const services = providerFor(fileSystem)(DEFAULTS);
  const preview = await runDataReset(services, { classes: ["logs"], confirmation: null });
  if (preview.payload === null) {
    throw new Error("expected a reset plan");
  }
  return { services, preview };
}

describe("data command surface", () => {
  test("declares and previews the exact removal plan in every output contract", async () => {
    for (const format of ["human", "quiet", "json", "jsonl"] as const) {
      const fileSystem = createInMemoryFileSystem({ nodes: TREE });
      const streams = createRecordingCliStreams();
      const code = await dispatch({
        argv: ["data", "reset", "--class", "logs", "--format", format],
        streams,
        services: providerFor(fileSystem),
      });
      const stdout = streams.resultWrites().join("");

      expect(code).toBe(EXIT_CODES.COMPLETED);
      expect(fileSystem.paths()).toContain(localPath("/d/logs/today/run.log"));
      if (format === "human") {
        expect(stdout).toContain("Local data reset plan");
        expect(stdout).toContain("/d/logs");
      } else if (format === "quiet") {
        expect(stdout).toContain("\tlogs\tdelete\t500\t3\t/d/logs");
      } else if (format === "json") {
        const record = JSON.parse(stdout) as { payload?: { plan?: { classes?: unknown[] } } };
        expect(record.payload?.plan?.classes).toBeArray();
      } else {
        const terminal = readCliStream(stdout.split("\n")).terminal as {
          payload?: { plan?: { classes?: unknown[] } };
        } | null;
        expect(terminal?.payload?.plan?.classes).toBeArray();
      }
    }
  });

  test("requires a prior exact plan identity before a confirmed reset removes anything", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const { services, preview } = await previewLogs(fileSystem);
    const planId = preview.payload?.plan.planId;
    if (planId === undefined) {
      throw new Error("expected a reset plan identity");
    }

    const applied = await runDataReset(services, {
      classes: ["logs"],
      confirmation: planId,
    });

    expect(applied.outcome).toEqual({ kind: "completed" });
    expect(applied.effect).toEqual({ intent: "mutate", observed: "completed" });
    expect(applied.payload?.confirmation).toBe("applied");
    expect(fileSystem.paths()).not.toContain(localPath("/d/logs/today/run.log"));
  });

  test("refuses a stale plan identity before it starts deleting", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const { services, preview } = await previewLogs(fileSystem);
    const planId = preview.payload?.plan.planId;
    if (planId === undefined) {
      throw new Error("expected a reset plan identity");
    }
    await fileSystem.removeEntry(localPath("/d/logs/old.log"));

    const refused = await runDataReset(services, { classes: ["logs"], confirmation: planId });

    expect(refused.outcome).toEqual({ kind: "failed", effect: "none" });
    expect(refused.effect).toEqual({ intent: "mutate", observed: "none" });
    expect(refused.errors[0]?.code).toBe("data.removal.plan-mismatch");
    expect(resolveExitCode({ outcome: refused.outcome, error: refused.errors[0] ?? null })).toBe(
      EXIT_CODES.INVALID_USAGE,
    );
    expect(fileSystem.paths()).toContain(localPath("/d/logs/today/run.log"));
  });

  test("never infers destructive intent in non-interactive use", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const streams = createRecordingCliStreams();

    expect(
      await dispatch({
        argv: ["data", "reset", "--class", "logs", "--non-interactive", "--format", "json"],
        streams,
        services: providerFor(fileSystem),
      }),
    ).toBe(EXIT_CODES.COMPLETED);
    expect(fileSystem.paths()).toContain(localPath("/d/logs/today/run.log"));
    const record = JSON.parse(streams.resultWrites().join("")) as {
      effect?: unknown;
      payload?: { confirmation?: string };
    };
    expect(record.effect).toEqual({ intent: "none", observed: "none" });
    expect(record.payload?.confirmation).toBe("not-requested");
  });

  test("keeps an interrupted preview non-mutating", () => {
    const stopped = stoppedResult("data.reset", { kind: "cancelled", effect: "none" });

    expect(stopped.effect).toEqual({ intent: "none", observed: "none" });
  });

  test("reports a partial reset as uncertain effect instead of a clean completion", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: { ...TREE, "/d/logs/today": { kind: "directory", writable: false } },
    });
    const { services, preview } = await previewLogs(fileSystem);
    const planId = preview.payload?.plan.planId;
    if (planId === undefined) {
      throw new Error("expected a reset plan identity");
    }

    const partial = await runDataReset(services, { classes: ["logs"], confirmation: planId });

    expect(partial.outcome).toEqual({ kind: "failed", effect: "partial" });
    expect(partial.effect).toEqual({ intent: "mutate", observed: "partial" });
    expect(resolveExitCode({ outcome: partial.outcome, error: null })).toBe(
      EXIT_CODES.UNCERTAIN_EFFECT,
    );
  });

  test("passes interruption through to a removal already in progress", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const { services, preview } = await previewLogs(fileSystem);
    const planId = preview.payload?.plan.planId;
    if (planId === undefined) {
      throw new Error("expected a reset plan identity");
    }
    const controller = new AbortController();
    const removeEntry = fileSystem.removeEntry.bind(fileSystem);
    fileSystem.removeEntry = async (path, signal) => {
      const result = await removeEntry(path, signal);
      if (path === localPath("/d/logs/old.log")) {
        controller.abort();
      }
      return result;
    };

    const interrupted = await runDataReset(
      services,
      { classes: ["logs"], confirmation: planId },
      controller.signal,
    );

    expect(interrupted.outcome).toEqual({ kind: "failed", effect: "partial" });
    expect(interrupted.payload?.execution?.completeness).toBe("partial");
    expect(fileSystem.paths()).toContain(localPath("/d/logs/today/run.log"));
  });

  test("does not remove a project outside the registered roots during uninstall", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: TREE });
    const services = providerFor(fileSystem)(DEFAULTS);
    const preview = await runDataUninstall(services, { classes: [], confirmation: null });
    const planId = preview.payload?.plan.planId;
    if (planId === undefined) {
      throw new Error("expected an uninstall plan identity");
    }

    await runDataUninstall(services, { classes: [], confirmation: planId });

    expect(fileSystem.paths()).toContain(localPath("/Users/example/project/src.ts"));
    expect(fileSystem.paths()).toContain(localPath("/d/exports/session.zip"));
  });
});
