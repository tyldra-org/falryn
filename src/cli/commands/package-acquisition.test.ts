import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePackage } from "../../application/extensions/prepare-package.ts";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { curatedIdentityDigest } from "../../domain/extensions/curated-catalog.ts";
import { curatedDocument, curatedEntry } from "../../domain/extensions/curated-catalog-fixtures.ts";
import type { PackageIdentityV1 } from "../../domain/extensions/identity.ts";
import { packageRequestSchema } from "../../domain/extensions/lifecycle.ts";
import { readPackageArchive } from "../../domain/extensions/package-archive.ts";
import {
  type ArchiveEntry,
  archiveBytes,
  packageArchiveEntries,
} from "../../domain/extensions/package-archive-fixtures.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { hookTestCertificate } from "../../integrations/extensions/hook-http-fixtures.ts";
import type { GlobalOptions } from "../options.ts";
import { createServiceProvider } from "../runtime/services.ts";
import { FALRYN_VERSION } from "../version.ts";
import { runExtensionListing } from "./extension-listing.ts";
import { runPackage } from "./package.ts";

const tls = hookTestCertificate("registry.test");
const suite = tls === null ? describe.skip : describe;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const GLOBALS: GlobalOptions = {
  color: "never",
  format: "json",
  nonInteractive: true,
  profile: null,
  quiet: false,
  timeoutMs: null,
  verbose: false,
  workspace: null,
  addDirs: [],
  help: false,
  version: false,
};
const HOST = { falryn: FALRYN_VERSION, bun: Bun.version, os: process.platform, arch: process.arch };

/** A local TLS registry serving archives by path; replies can be replaced per path. */
function registry() {
  if (tls === null) throw new Error("no certificate");
  const archives = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const instance = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const bytes = archives.get(path);
      return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
    },
  });
  cleanup.push(() => instance.stop(true));
  return { base: `https://registry.test:${instance.port}/`, archives, requests };
}

/** The identity a real archive produces when acquired with this source coordinate. */
async function identityOf(
  archive: Uint8Array,
  sourceCoordinate: PackageIdentityV1["sourceCoordinate"],
) {
  const files = readPackageArchive(archive);
  if (!files.ok) throw new Error(files.error);
  const prepared = await preparePackage(
    {
      read: async () => ({
        sourceId: "fixture",
        sourceCoordinate,
        files: files.value,
        diagnostics: [],
        omittedDiagnostics: 0,
      }),
    },
    HOST,
  );
  if (!prepared.ok) throw new Error(prepared.code);
  return prepared.package.identity;
}

async function product() {
  const home = await mkdtemp(join(tmpdir(), "falryn-acquire-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "config"), { recursive: true });
  const services = createServiceProvider(GLOBALS, {
    home: localPath(home),
    platform: "darwin",
    environment: createStaticEnvironment({
      FALRYN_STATE_DIR: join(home, "state"),
      FALRYN_CONFIG_DIR: join(home, "config"),
      FALRYN_CACHE_DIR: join(home, "cache"),
    }),
    currentDirectory: localPath(home),
    egress: {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      ...(tls === null ? {} : { ca: tls.cert }),
      reachable: ["127.0.0.1"],
    },
  });
  let sequence = 0;
  type Versions = { identity: PackageIdentityV1; withdrawn?: unknown }[];
  /** Publish one catalog; every call replaces the source's previous catalog. */
  const publish = async (versions: Versions, more: Record<string, Versions> = {}) => {
    const file = join(home, `catalog-${++sequence}.json`);
    const entry = (listingId: string, listed: Versions) => ({
      ...curatedEntry(listingId),
      versions: listed.map((item, index) => ({
        identity: item.identity,
        publishedAt: 1_000 + index,
        ...(item.withdrawn === undefined ? {} : { withdrawn: item.withdrawn }),
      })),
    });
    await writeFile(
      file,
      JSON.stringify(
        curatedDocument(
          [
            entry("tools/acquired", versions),
            ...Object.entries(more).map(([listingId, listed]) => entry(listingId, listed)),
          ],
          { sequence },
        ),
      ),
    );
    const imported = await runExtensionListing(services, { operation: "import", file }, GLOBALS);
    expect(imported.payload).toMatchObject({ status: "imported" });
  };
  let revision = 0;
  const run = async (
    action: "install" | "update" | "rollback",
    extra: Record<string, unknown>,
    confirm = true,
  ) => {
    const base = { packageId: "acquired", expectedRevision: revision, ...extra };
    // Confirmation binds the same operation, so preview and confirm share its ID.
    const operationId = randomUUID();
    const request = (value: Record<string, unknown>) =>
      packageRequestSchema.parse({ ...base, operationId, ...value });
    const preview = await runPackage(
      services,
      { action, request: request({}) },
      undefined,
      GLOBALS,
    );
    if (!confirm || preview.payload?.status !== "preview") return preview.payload;
    const done = await runPackage(
      services,
      { action, request: request({ confirmation: preview.payload.confirmation }) },
      undefined,
      GLOBALS,
    );
    if (done.payload?.status === "completed") revision = done.payload.revision;
    return done.payload;
  };
  return { publish, run };
}
const listing = (packageVersion = "1.0.0", listingId = "tools/acquired") => ({
  listing: { sourceId: "example", listingId, packageVersion },
});

test("the CLI accepts a listing install and refuses a private registry before any request", async () => {
  const home = await mkdtemp(join(tmpdir(), "falryn-acquire-cli-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const archive = archiveBytes(packageArchiveEntries("acquired", "1.0.0"));
  const identity = await identityOf(archive, {
    kind: "registry",
    registry: "https://127.0.0.1/",
    coordinate: "acquired",
    packageVersion: "1.0.0",
  });
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NO_COLOR: "1",
    FALRYN_CONFIG_DIR: join(home, "config"),
    FALRYN_STATE_DIR: join(home, "state"),
    FALRYN_CACHE_DIR: join(home, "cache"),
  };
  const cli = async (args: string[], request: unknown) => {
    const file = join(home, `${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(request));
    const child = Bun.spawnSync(
      [
        process.execPath,
        "run",
        new URL("../../main.ts", import.meta.url).pathname,
        ...args,
        "--input",
        file,
        "--format",
        "json",
      ],
      { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    // An invalid request is refused before any result is produced.
    const stdout = new TextDecoder().decode(child.stdout).trim().split("\n").at(-1) || "null";
    return {
      exitCode: child.exitCode,
      payload: (JSON.parse(stdout) as { payload: Record<string, unknown> } | null)?.payload ?? null,
    };
  };
  const catalog = join(home, "catalog.json");
  await writeFile(
    catalog,
    JSON.stringify(
      curatedDocument([
        { ...curatedEntry("tools/acquired"), versions: [{ identity, publishedAt: 1 }] },
      ]),
    ),
  );
  expect(
    (await cli(["extension", "listing"], { operation: "import", file: catalog })).payload,
  ).toMatchObject({
    status: "imported",
  });
  const installed = await cli(["package", "install"], {
    packageId: "acquired",
    operationId: randomUUID(),
    expectedRevision: 0,
    ...listing(),
  });
  expect(installed.exitCode).not.toBe(0);
  expect(installed.payload).toMatchObject({ status: "failed", code: "package-download-private" });
  const conflicting = await cli(["package", "install"], {
    packageId: "acquired",
    operationId: randomUUID(),
    expectedRevision: 0,
    sourcePath: home,
    ...listing(),
  });
  expect(conflicting.exitCode).not.toBe(0);
}, 60_000);

suite("marketplace package acquisition", () => {
  test("installs, updates and rolls back the exact listed registry versions", async () => {
    const served = registry();
    const coordinate = (version: string) => ({
      kind: "registry" as const,
      registry: served.base,
      coordinate: "acquired",
      packageVersion: version,
    });
    const first = archiveBytes(packageArchiveEntries("acquired", "1.0.0"));
    const second = archiveBytes(packageArchiveEntries("acquired", "1.1.0"));
    served.archives.set("/acquired/1.0.0/package.tgz", first);
    served.archives.set("/acquired/1.1.0/package.tgz", second);
    const v1 = await identityOf(first, coordinate("1.0.0"));
    const v2 = await identityOf(second, coordinate("1.1.0"));
    const f = await product();
    await f.publish([{ identity: v1 }, { identity: v2 }]);

    const preview = await f.run("install", listing(), false);
    expect(preview).toMatchObject({
      status: "preview",
      code: "confirmation-required",
      acquisition: {
        listing: listing().listing,
        download: `${served.base}acquired/1.0.0/package.tgz`,
        bytes: first.length,
        redirects: 0,
      },
    });
    const installed = await f.run("install", listing());
    expect(installed).toMatchObject({ status: "completed", revision: 1 });
    // The installed identity is exactly the listed one, registry source included.
    expect(installed?.currentDigest).toBe(curatedIdentityDigest(v1));
    const updated = await f.run("update", listing("1.1.0"));
    expect(updated).toMatchObject({
      status: "completed",
      revision: 2,
      currentDigest: curatedIdentityDigest(v2),
    });
    // Rollback reads the retained acquired bytes back with their recorded registry source.
    const requests = served.requests.length;
    const rolled = await f.run("rollback", { versionDigest: installed?.currentDigest });
    expect(rolled).toMatchObject({ status: "completed", currentDigest: installed?.currentDigest });
    expect(served.requests).toHaveLength(requests);
  });

  test("different bytes, a later withdrawal and unsupported sources install nothing", async () => {
    const served = registry();
    const coordinate = {
      kind: "registry" as const,
      registry: served.base,
      coordinate: "acquired",
      packageVersion: "1.0.0",
    };
    const genuine = archiveBytes(packageArchiveEntries("acquired", "1.0.0"));
    const identity = await identityOf(genuine, coordinate);
    const tampered: ArchiveEntry[] = [
      ...packageArchiveEntries("acquired", "1.0.0"),
      { path: "package/extra.md", text: "x" },
    ];
    served.archives.set("/acquired/1.0.0/package.tgz", archiveBytes(tampered));
    const f = await product();
    await f.publish([{ identity }]);
    expect(await f.run("install", listing(), false)).toMatchObject({
      status: "failed",
      code: "acquired-identity-mismatch",
    });
    served.archives.set("/acquired/1.0.0/package.tgz", genuine);
    await f.publish([{ identity, withdrawn: { reason: "security", at: 2_000 } }]);
    expect(await f.run("install", listing(), false)).toMatchObject({
      status: "failed",
      code: "version-withdrawn",
    });
    expect(await f.run("install", listing("9.9.9"), false)).toMatchObject({
      code: "version-not-found",
    });

    // An archive coordinate names its exact bytes; anything else is refused before reading.
    const origin = `${served.base}direct.tgz`;
    served.archives.set("/direct.tgz", genuine);
    const direct = await identityOf(genuine, {
      kind: "archive",
      origin,
      digest: bytesDigest(genuine),
    });
    const git = await identityOf(genuine, {
      kind: "git",
      repository: "https://example.test/acquired.git",
      commit: "a".repeat(40),
    });
    await f.publish([{ identity }], {
      "tools/direct": [{ identity: direct }],
      "tools/git": [{ identity: git }],
    });
    const directListing = listing("1.0.0", "tools/direct");
    expect(await f.run("install", listing("1.0.0", "tools/git"), false)).toMatchObject({
      code: "acquisition-source-unsupported",
    });
    served.archives.set("/direct.tgz", archiveBytes(tampered));
    expect(await f.run("install", directListing, false)).toMatchObject({
      code: "archive-digest-mismatch",
    });
    served.archives.set("/direct.tgz", genuine);
    expect(await f.run("install", directListing)).toMatchObject({
      status: "completed",
      revision: 1,
    });
    expect(await f.run("rollback", listing(), false)).toMatchObject({
      code: "unexpected-package-listing",
    });
  });
});
