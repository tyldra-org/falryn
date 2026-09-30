import { afterEach, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIGURATION_FILE_NAME } from "../../config/index.ts";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { curatedDocument, curatedEntry } from "../../domain/extensions/curated-catalog-fixtures.ts";

afterEach(removeTemporaryRoots);
const COMMAND = [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname];

/** Each call is a separate process, so every read proves what was persisted. */
async function cli(root: string) {
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    NO_COLOR: "1",
    FALRYN_CONFIG_DIR: join(root, "config"),
    FALRYN_STATE_DIR: join(root, "state"),
    FALRYN_CACHE_DIR: join(root, "cache"),
    FALRYN_LOG_DIR: join(root, "logs"),
    FALRYN_TEMP_DIR: join(root, "temporary"),
    FALRYN_ARTIFACT_DIR: join(root, "artifacts"),
    FALRYN_EXPORT_DIR: join(root, "exports"),
  };
  let count = 0;
  return async (request: unknown, format = "json") => {
    const file = join(root, "request-" + ++count + ".json");
    await writeFile(file, JSON.stringify(request));
    const child = Bun.spawnSync(
      [...COMMAND, "extension", "listing", "--input", file, "--format", format],
      { cwd: root, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const stdout = new TextDecoder().decode(child.stdout);
    const text = stdout + new TextDecoder().decode(child.stderr);
    if (format !== "json" || stdout.trim() === "")
      return { exitCode: child.exitCode, text, payload: null };
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") as {
      payload: Record<string, unknown> & { status: string };
    };
    return { exitCode: child.exitCode, text, payload: result.payload };
  };
}
async function catalogFile(root: string, name: string, value: unknown) {
  const file = join(root, name);
  await writeFile(file, JSON.stringify(value));
  return file;
}

test("catalogs import from local files, persist per source and never overwrite each other", async () => {
  const root = await temporaryRoot("falryn-listing-");
  const run = await cli(root);
  // Two catalogs use the same display names; one also lists the other's exact package.
  const shared = curatedEntry("tools/review");
  const first = await catalogFile(
    root,
    "a.json",
    curatedDocument(
      [
        shared,
        curatedEntry("tools/format"),
        { ...curatedEntry("tools/bad"), links: { homepage: "http://insecure.test/" } },
      ],
      { source: "alpha" },
    ),
  );
  const second = await catalogFile(
    root,
    "b.json",
    curatedDocument([{ ...shared, listingId: "mirror/review" }], { source: "beta" }),
  );
  const imported = await run({ operation: "import", file: first });
  expect(imported.payload).toMatchObject({
    status: "imported",
    sourceId: "alpha",
    sequence: 1,
    accepted: 2,
    rejected: ["tools/bad"],
    diagnostics: [{ code: "link-invalid", path: "/entries/2/links/homepage" }],
  });
  expect((await run({ operation: "import", file: second })).payload).toMatchObject({
    status: "imported",
    sourceId: "beta",
  });
  const listed = await run({ operation: "list" });
  expect(listed.payload).toMatchObject({ status: "listed", total: 3, nextOffset: null });
  const entries = listed.payload?.entries as {
    sourceId: string;
    listing: { listingId: string; title: string };
    alsoListedBy: string[];
    versions: { compatible: boolean }[];
  }[];
  expect(entries.map((e) => [e.sourceId, e.listing.listingId, e.alsoListedBy])).toEqual([
    ["alpha", "tools/format", []],
    ["alpha", "tools/review", ["beta"]],
    ["beta", "mirror/review", ["alpha"]],
  ]);
  expect(entries.every((e) => e.versions.every((v) => v.compatible))).toBe(true);
  // Filters and pages are stable; editorial rank plays no part.
  expect(
    (await run({ operation: "list", query: { sourceId: "alpha", limit: 1 } })).payload,
  ).toMatchObject({
    total: 2,
    nextOffset: 1,
    entries: [{ listing: { listingId: "tools/format" } }],
  });
  // Re-importing the same file changes nothing; an edited body under the same sequence
  // and an older sequence are refused without touching the stored record.
  expect((await run({ operation: "import", file: first })).payload).toMatchObject({
    status: "unchanged",
  });
  const edited = await catalogFile(
    root,
    "a-edited.json",
    curatedDocument([curatedEntry("tools/format")], { source: "alpha" }),
  );
  const conflict = await run({ operation: "import", file: edited });
  expect(conflict.payload).toMatchObject({
    status: "rejected",
    code: "catalog-sequence-conflict",
    storedSequence: 1,
  });
  expect(conflict.exitCode).not.toBe(0);
  // Sequence 2 breaks tools/review: its accepted form stays, marked as kept.
  const broken = await catalogFile(
    root,
    "a-2.json",
    curatedDocument([{ ...shared, title: "Safe\u202Etxt.exe" }, curatedEntry("tools/format")], {
      source: "alpha",
      sequence: 2,
    }),
  );
  expect((await run({ operation: "import", file: broken })).payload).toMatchObject({
    status: "imported",
    sequence: 2,
    rejected: ["tools/review"],
    retained: ["tools/review"],
  });
  expect(
    (await run({ operation: "list", query: { sourceId: "alpha" } })).payload?.entries,
  ).toMatchObject([
    { listing: { listingId: "tools/format" }, status: "current", fromSequence: 2 },
    {
      listing: { listingId: "tools/review", title: "Review helper" },
      status: "retained",
      fromSequence: 1,
    },
  ]);
  expect((await run({ operation: "import", file: first })).payload).toMatchObject({
    status: "rejected",
    code: "catalog-stale",
    storedSequence: 2,
  });
  // Human output labels claims as unverified and repeats that nothing was trusted.
  const human = await run({ operation: "list", query: { text: "review" } }, "human");
  expect(human.text).toContain("Catalog claims (unverified): review yes");
  expect(human.text).toContain("kept from sequence 1");
  // Nothing was fetched, installed or cached: metadata is the only state written.
  expect(await readdir(join(root, "state"))).not.toContain("packages");
}, 120_000);

test("refused documents and requests leave no catalog behind", async () => {
  const root = await temporaryRoot("falryn-listing-refused-");
  const run = await cli(root);
  for (const [document, code] of [
    [
      { ...curatedDocument([curatedEntry("tools/a")]), generation: 2 },
      "catalog-generation-unsupported",
    ],
    [
      { ...curatedDocument([curatedEntry("tools/a")]), requires: ["payments"] },
      "catalog-required-field-unknown",
    ],
  ] as const) {
    const file = await catalogFile(root, code + ".json", document);
    expect((await run({ operation: "import", file })).payload).toMatchObject({
      status: "rejected",
      code,
    });
  }
  const large = join(root, "large.json");
  await writeFile(large, " ".repeat(1_048_577));
  expect((await run({ operation: "import", file: large })).payload).toMatchObject({
    code: "catalog-too-large",
  });
  expect((await run({ operation: "import", file: join(root, "missing.json") })).payload).toEqual({
    status: "failed",
    code: "catalog-file-unreadable",
  });
  expect((await run({ operation: "list" })).payload).toMatchObject({
    status: "listed",
    sources: [],
    total: 0,
  });
  const invalid = await run({ operation: "fetch", url: "https://catalog.example.test/" });
  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.text).not.toContain("catalog.example.test");
}, 120_000);

test("an unreachable marketplace changes nothing; inspect shows one version before any install", async () => {
  const root = await temporaryRoot("falryn-listing-market-");
  const run = await cli(root);
  // A loopback marketplace is refused as a private destination before any connection.
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(
    join(root, "config", CONFIGURATION_FILE_NAME),
    JSON.stringify({
      schemaVersion: 1,
      tools: {
        marketplaces: {
          sources: [
            {
              id: "local",
              url: "https://127.0.0.1:9/catalog.json",
              credentialEnvironment: "MARKET_TOKEN",
            },
          ],
        },
      },
    }),
  );
  const refreshed = await run({ operation: "refresh" });
  expect(refreshed.exitCode).not.toBe(0);
  expect(refreshed.payload).toMatchObject({
    status: "refreshed",
    results: [{ sourceId: "local", fetchedAt: null, receipt: { status: "failed" } }],
  });
  expect((await run({ operation: "list" })).payload).toMatchObject({ total: 0 });
  expect((await run({ operation: "refresh", sourceId: "absent" })).payload).toEqual({
    status: "failed",
    code: "marketplace-unknown",
  });

  const file = await catalogFile(
    root,
    "catalog.json",
    curatedDocument([curatedEntry("tools/review", { versions: ["1.0.0", "1.1.0"] })]),
  );
  await run({ operation: "import", file });
  const inspected = await run({
    operation: "inspect",
    query: { sourceId: "example", listingId: "tools/review", packageVersion: "1.0.0" },
  });
  expect(inspected.exitCode).toBe(0);
  expect(inspected.payload).toMatchObject({
    status: "inspected",
    source: { origin: { kind: "file" }, freshness: { state: "local" } },
    version: { identity: { packageVersion: "1.0.0" } },
    executableProfile: "unknown-until-local-inspection",
    install: {
      status: "available",
      download: "https://registry.example.test/tools-review/1.0.0/package.tgz",
      credential: "none",
    },
  });
  const human = await run(
    { operation: "inspect", query: { sourceId: "example", listingId: "tools/review" } },
    "human",
  );
  expect(human.text).toContain("Version: 1.1.0");
  expect(human.text).toContain("imported from a file; no freshness claim");
  expect(human.text).toContain("Catalog claims (unverified)");
  expect(human.text).toContain(
    "Executable profile: unknown until the package is inspected locally.",
  );
  expect(human.text).toContain(
    "Install: available from https://registry.example.test/tools-review/1.1.0/package.tgz;",
  );
  const missing = await run({
    operation: "inspect",
    query: { sourceId: "example", listingId: "tools/absent" },
  });
  expect(missing.exitCode).not.toBe(0);
  expect(missing.payload).toEqual({ status: "not-found", code: "listing-not-found" });
  expect(await readdir(join(root, "state"))).not.toContain("packages");
}, 120_000);
