/**
 * The `falryn data backup|restore|inspect|diagnostics` command surface.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openProductStoreOrThrow, removeTemporaryRoots } from "../data/fixtures.ts";
import {
  backupName,
  createStaticEnvironment,
  localPath,
  userBackupFileName,
} from "../domain/index.ts";
import { parseInvocation } from "./command-tree.ts";
import { runDataBackup, runDataInspect, runDataRestore } from "./data-backup-commands.ts";
import { dispatch } from "./dispatch.ts";
import { EXIT_CODES } from "./exit.ts";
import type { GlobalOptions } from "./options.ts";
import { createServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

afterEach(removeTemporaryRoots);

const BACKUP = backupName.from("daily");
const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

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

async function commandOf(...argv: string[]): Promise<string> {
  const invocation = await parseInvocation(argv);
  return invocation.kind === "run" ? invocation.command : invocation.kind;
}

async function seededHome(): Promise<{
  readonly state: string;
  readonly provider: (globals: GlobalOptions) => ReturnType<typeof createServiceProvider>;
  readonly services: ReturnType<typeof createServiceProvider>;
}> {
  const home = await mkdtemp(join(tmpdir(), "falryn-backup-cli-"));
  homes.push(home);
  const state = join(home, "state");
  const config = join(home, "config");
  await mkdir(state, { recursive: true });
  await mkdir(config, { recursive: true });
  await chmod(state, 0o700);
  await chmod(config, 0o700);

  const store = await openProductStoreOrThrow(localPath(state));
  await store.close();

  const environment = createStaticEnvironment({
    FALRYN_STATE_DIR: state,
    FALRYN_CONFIG_DIR: config,
    FALRYN_CACHE_DIR: join(home, "cache"),
    FALRYN_LOG_DIR: join(home, "logs"),
    FALRYN_TEMP_DIR: join(home, "tmp"),
    FALRYN_ARTIFACT_DIR: join(home, "artifacts"),
    FALRYN_EXPORT_DIR: join(home, "exports"),
  });

  const provider = (globals: GlobalOptions) =>
    createServiceProvider(globals, {
      environment,
      home: localPath(home),
      platform: "darwin",
      currentDirectory: localPath(home),
    });

  return { state, provider, services: provider(DEFAULTS) };
}

describe("data backup lifecycle commands", () => {
  test("routes backup, restore, inspect, and diagnostics through the tree", async () => {
    expect(await commandOf("data", "backup", "daily")).toBe("data.backup");
    expect(await commandOf("data", "restore", "daily")).toBe("data.restore");
    expect(await commandOf("data", "inspect", "daily")).toBe("data.inspect");
    expect(await commandOf("data", "diagnostics")).toBe("data.diagnostics");
  });

  test("writes a named backup and inspects it without upgrading", async () => {
    const { state, services } = await seededHome();

    const backed = await runDataBackup(services, { action: "backup", name: BACKUP });
    expect(backed.outcome).toEqual({ kind: "completed" });
    expect(backed.effect).toEqual({ intent: "mutate", observed: "completed" });
    expect(backed.payload?.fileName).toBe(userBackupFileName(BACKUP));

    const files = await readdir(state);
    expect(files).toContain(userBackupFileName(BACKUP));

    const inspected = await runDataInspect(services, { action: "inspect", name: BACKUP });
    expect(inspected.outcome).toEqual({ kind: "completed" });
    expect(inspected.payload?.byteLength).toBeGreaterThan(0);
  });

  test("previews restore until the backup name is confirmed", async () => {
    const { services } = await seededHome();
    await runDataBackup(services, { action: "backup", name: BACKUP });

    const preview = await runDataRestore(services, {
      action: "restore",
      name: BACKUP,
      confirmation: null,
    });
    expect(preview.payload?.confirmation).toBe("not-requested");
    expect(preview.effect).toEqual({ intent: "none", observed: "none" });

    const applied = await runDataRestore(services, {
      action: "restore",
      name: BACKUP,
      confirmation: BACKUP,
    });
    expect(applied.payload?.confirmation).toBe("applied");
    expect(applied.effect).toEqual({ intent: "mutate", observed: "completed" });
  });

  test("never applies restore in non-interactive use without confirmation", async () => {
    const { state, provider, services } = await seededHome();
    await runDataBackup(services, { action: "backup", name: BACKUP });
    const streams = createRecordingCliStreams();

    const code = await dispatch({
      argv: ["data", "restore", "daily", "--non-interactive", "--format", "json"],
      streams,
      services: provider,
    });

    expect(code).toBe(EXIT_CODES.COMPLETED);
    const record = JSON.parse(streams.resultWrites().join("")) as {
      payload?: { confirmation?: string };
    };
    expect(record.payload?.confirmation).toBe("not-requested");
    const files = await readdir(state);
    expect(files).toContain("falryn.sqlite");
    expect(files).not.toContain("falryn.sqlite.previous");
  });

  test("collects local diagnostics read-only", async () => {
    const { provider } = await seededHome();
    const streams = createRecordingCliStreams();

    const code = await dispatch({
      argv: ["data", "diagnostics", "--format", "json"],
      streams,
      services: provider,
    });

    expect(code).toBe(EXIT_CODES.COMPLETED);
    const record = JSON.parse(streams.resultWrites().join("")) as {
      payload?: { schemaVersion?: number; crashSignals?: unknown; sweep?: unknown };
    };
    expect(record.payload?.schemaVersion).toBeNumber();
    expect(record.payload?.crashSignals).toBeObject();
    expect(record.payload?.sweep).toBeNull();
  });
});
