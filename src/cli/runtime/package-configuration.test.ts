import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootChild, sqliteDatabasePath } from "../../data/index.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { openBunSqlite } from "../../integrations/index.ts";
import { loadPackageConfiguration } from "./package-configuration.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { createServiceProvider } from "./services.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function services() {
  const home = await mkdtemp(join(tmpdir(), "falryn-package-configuration-"));
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

test("another process reading the database does not make package configuration unavailable", async () => {
  const graph = (await services())();
  await graph.ensureWorkspaceSet();
  // Create the product database, so the read opens an existing store.
  const created = await openProductArtifactSession(graph);
  if (!created) throw new Error("store");
  await created.close();
  const stateRoot = rootChild(graph.localData.layout, "state");
  const path = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
  if (path === null) throw new Error("path");
  const connect = () => {
    const opened = openBunSqlite({ path, create: false });
    if (!opened.ok) throw new Error("connection");
    return opened.value;
  };
  // Another process holds a read snapshot open, as a running schedule host does, and a third
  // writes: the log now holds frames that snapshot still needs, so a truncating checkpoint
  // cannot finish when the configuration read closes its connection.
  const other = connect();
  const writer = connect();
  try {
    other.run("BEGIN");
    other.all("SELECT count(*) FROM sqlite_master");
    writer.pragma("wal_autocheckpoint = 0");
    writer.run("CREATE TABLE IF NOT EXISTS held_by_another_process (value INTEGER)");
    writer.run("INSERT INTO held_by_another_process VALUES (1)");
    const started = Date.now();
    const loaded = await loadPackageConfiguration(graph, {
      configurationRoot: graph.configurationRoot,
      legacyConfigurationRoot: graph.legacyConfigurationRoot,
      workspaceRoot: graph.workspaceRoot,
      profile: null,
    });
    expect(loaded.declarations).toEqual([]);
    // A read does not wait the busy timeout for the other process's readers.
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    other.run("ROLLBACK");
    await other.close();
    await writer.close();
  }
}, 30_000);
