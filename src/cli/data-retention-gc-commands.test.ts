/**
 * The `falryn data retention|gc` command surface.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openProductStoreOrThrow, removeTemporaryRoots } from "../data/fixtures.ts";
import { createRecordRepositories } from "../data/repositories.ts";
import { sessionRecord, turnRecord } from "../domain/fixtures.ts";
import {
  createStaticEnvironment,
  localPath,
  sessionId as sessionIdCodec,
} from "../domain/index.ts";
import { parseInvocation } from "./command-tree.ts";
import { runDataGc, runDataRetention } from "./data-retention-gc-commands.ts";
import type { GlobalOptions } from "./options.ts";
import { createServiceProvider } from "./services.ts";

afterEach(removeTemporaryRoots);

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

async function seededHome(): Promise<ReturnType<typeof createServiceProvider>> {
  const home = await mkdtemp(join(tmpdir(), "falryn-retention-gc-cli-"));
  homes.push(home);
  const state = join(home, "state");
  const config = join(home, "config");
  await mkdir(state, { recursive: true });
  await mkdir(config, { recursive: true });

  const store = await openProductStoreOrThrow(localPath(state));
  const repositories = createRecordRepositories(store);
  const open = sessionRecord({ sessionId: sessionIdCodec.from("open-session"), closedAt: null });
  const closed = sessionRecord({
    sessionId: sessionIdCodec.from("closed-session"),
    closedAt: open.startedAt,
    outcome: { kind: "completed" },
  });
  repositories.sessions.insert(open);
  repositories.sessions.insert(closed);
  repositories.turns.insert(turnRecord({ sessionId: open.sessionId }));
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

  return createServiceProvider(DEFAULTS, {
    environment,
    home: localPath(home),
    platform: "darwin",
    currentDirectory: localPath(home),
  });
}

describe("data retention and gc commands", () => {
  test("routes retention and gc through the tree", async () => {
    expect(await commandOf("data", "retention")).toBe("data.retention");
    expect(await commandOf("data", "gc")).toBe("data.gc");
  });

  test("reports retention without deleting anything", async () => {
    const services = await seededHome();
    const result = await runDataRetention(services);
    expect(result.outcome).toEqual({ kind: "completed" });
    expect(result.payload?.report.totalItems).toBeGreaterThan(0);
  });

  test("previews gc until the plan identity is confirmed", async () => {
    const services = await seededHome();
    const preview = await runDataGc(services, {
      action: "gc",
      confirmation: null,
      pinnedSessions: [],
    });
    expect(preview.payload?.confirmation).toBe("not-requested");
    expect(preview.effect).toEqual({ intent: "none", observed: "none" });

    const planId = preview.payload?.plan.planId;
    expect(planId).toBeDefined();
    const applied = await runDataGc(services, {
      action: "gc",
      confirmation: planId ?? null,
      pinnedSessions: [],
    });
    expect(applied.payload?.confirmation).toBe("applied");
  });

  test("never deletes a pinned session", async () => {
    const services = await seededHome();
    const preview = await runDataGc(services, {
      action: "gc",
      confirmation: null,
      pinnedSessions: ["closed-session"],
    });
    expect(
      preview.payload?.plan.candidates.some(
        (candidate) => candidate.kind === "session" && candidate.identity === "closed-session",
      ),
    ).toBe(false);
  });
});
