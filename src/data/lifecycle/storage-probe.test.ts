import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPath } from "../../domain/workspace/index.ts";
import { openBunSqlite } from "../../integrations/storage/bun-sqlite.ts";
import { PRODUCT_SCHEMA_VERSION } from "../sqlite/sqlite-migrations.ts";
import { MIGRATION_TABLE } from "../sqlite/sqlite-store.ts";
import { probeStorage } from "./storage-probe.ts";

test("database inspection waits for a transient exclusive lock without changing the database", async () => {
  const root = await mkdtemp(join(tmpdir(), "falryn-probe-lock-"));
  const path = join(root, "state.sqlite");
  const opened = openBunSqlite({ path: localPath(path), create: true });
  if (!opened.ok) throw new Error("fixture database unavailable");
  const db = opened.value;
  db.run(`CREATE TABLE ${MIGRATION_TABLE} (version INTEGER)`);
  db.run(`INSERT INTO ${MIGRATION_TABLE} VALUES (${PRODUCT_SCHEMA_VERSION})`);
  await db.close();
  const before = await readFile(path);
  const holder = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    const { openBunSqlite } = await import(process.argv[2]);
    const opened = openBunSqlite({ path: process.argv[1], create: false });
    if (!opened.ok) throw new Error("fixture lock unavailable");
    const db = opened.value;
    db.run("BEGIN EXCLUSIVE");
    process.stdout.write("locked\\n");
    setTimeout(async () => { db.run("ROLLBACK"); await db.close(); }, 250);
  `,
      path,
      new URL("../../integrations/storage/bun-sqlite.ts", import.meta.url).href,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = holder.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    reader.releaseLock();
    expect(
      await probeStorage({ open: openBunSqlite, databasePath: localPath(path) }),
    ).toMatchObject({
      kind: "present",
      schemaVersion: PRODUCT_SCHEMA_VERSION,
      current: true,
    });
    expect(await holder.exited).toBe(0);
    expect(await readFile(path)).toEqual(before);
  } finally {
    holder.kill();
    await holder.exited;
    await rm(root, { recursive: true, force: true });
  }
});
