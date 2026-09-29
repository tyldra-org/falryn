import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootChild, sqliteDatabasePath } from "../../data/index.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { openBunSqlite } from "../../integrations/index.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { createServiceProvider } from "./services.ts";
import { workspaceProfilePreference } from "./workspace-profile-preferences.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function services() {
  const home = await mkdtemp(join(tmpdir(), "falryn-profile-preference-"));
  homes.push(home);
  const workspace = join(home, "workspace");
  await mkdir(workspace, { recursive: true });
  return createServiceProvider(
    {
      format: "json",
      color: "never",
      quiet: false,
      verbose: false,
      nonInteractive: true,
      workspace,
      addDirs: [],
      profile: null,
      timeoutMs: null,
      help: false,
      version: false,
    },
    {
      home: localPath(home),
      currentDirectory: localPath(workspace),
      environment: createStaticEnvironment({
        FALRYN_CONFIG_DIR: join(home, "config"),
        FALRYN_STATE_DIR: join(home, "state"),
      }),
    },
  );
}

test("another process reading the database does not make the preference unavailable", async () => {
  const provider = await services();
  const graph = provider();
  await graph.ensureWorkspaceSet();
  // Create the product database, then write a preference so the log holds frames.
  const created = await openProductArtifactSession(graph);
  if (!created) throw new Error("store");
  await created.close();
  expect(await workspaceProfilePreference(graph, undefined, { profile: "work" })).toMatchObject({
    ok: true,
  });
  const stateRoot = rootChild(graph.localData.layout, "state");
  const path = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
  if (path === null) throw new Error("path");
  // Another process holds a read snapshot open, as a running schedule host or terminal
  // does, and a third then writes: the log now holds frames that snapshot still needs,
  // so a truncating checkpoint cannot finish.
  const connect = () => {
    const opened = openBunSqlite({ path, create: false });
    if (!opened.ok) throw new Error("connection");
    return opened.value;
  };
  const other = connect();
  const writer = connect();
  try {
    other.run("BEGIN");
    other.all("SELECT count(*) FROM workspace_profile_preferences");
    writer.pragma("wal_autocheckpoint = 0");
    writer.run("INSERT INTO workspace_profile_preferences VALUES ('other-workspace', NULL, 1)");
    const read = await workspaceProfilePreference(graph);
    expect(read).toEqual({ ok: true, value: { profile: "work", revision: 1 } });
  } finally {
    other.run("ROLLBACK");
    await other.close();
    await writer.close();
  }
});
