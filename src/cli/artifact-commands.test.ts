/**
 * The `falryn artifact` command surface against a real temporary local-data tree.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openProductStoreOrThrow, removeTemporaryRoots } from "../data/fixtures.ts";
import { createArtifactRepository, createArtifactStore } from "../data/index.ts";
import {
  artifactId,
  createManualClock,
  createStaticEnvironment,
  instant,
  localPath,
  runId,
} from "../domain/index.ts";
import { createHostBlobStore, createSha256Hasher } from "../integrations/index.ts";
import { parseInvocation } from "./command-tree.ts";
import { dispatch } from "./dispatch.ts";
import { EXIT_CODES } from "./exit.ts";
import type { GlobalOptions } from "./options.ts";
import { createServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

afterEach(removeTemporaryRoots);

const ARTIFACT = artifactId.from("cli-artifact-1");
const CONTENT = new TextEncoder().encode("artifact-bytes");
const BINARY = new Uint8Array([0, 1, 2, 0x1b, 0x4f]);

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

async function seededHome(options: {
  readonly bytes?: Uint8Array;
  readonly restricted?: boolean;
}): Promise<{
  readonly home: string;
  readonly environment: ReturnType<typeof createStaticEnvironment>;
  readonly output: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "falryn-artifact-cli-"));
  homes.push(home);
  const state = join(home, "state");
  const artifacts = join(home, "artifacts");
  const temp = join(home, "tmp");
  const config = join(home, "config");
  const output = join(home, "out.bin");
  await mkdir(state, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  await mkdir(temp, { recursive: true });
  await mkdir(config, { recursive: true });
  for (const directory of [home, state, artifacts, temp, config]) {
    await chmod(directory, 0o700);
  }

  const store = await openProductStoreOrThrow(localPath(state));
  store.write((statements) => {
    statements.run(
      `INSERT INTO runs (run_id, started_at, ended_at, schema_version)
       VALUES ($runId, '2026-07-31T12:00:00.000Z', NULL, 3)`,
      { runId: "run-artifact-cli" },
    );
  });
  const repository = createArtifactRepository(store, runId.from("run-artifact-cli"));
  const artifactStore = createArtifactStore({
    repository,
    blobs: createHostBlobStore({
      artifactsRoot: localPath(artifacts),
      temporaryRoot: localPath(temp),
    }),
    hasher: createSha256Hasher(),
    clock: createManualClock(instant(Date.parse("2026-07-31T12:00:00.000Z"))),
  });
  async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
    yield bytes;
  }
  const ingested = await artifactStore.ingest(
    {
      artifactId: ARTIFACT,
      mediaType: "text/plain",
      encoding: "identity",
      sensitivity: options.restricted === true ? "restricted" : "user-content",
      origin: "tool-output",
      invocationId: null,
      declaredByteLength: (options.bytes ?? CONTENT).byteLength,
      content: chunks(options.bytes ?? CONTENT),
    },
    undefined,
  );
  if (!ingested.ok) {
    throw new Error("expected the artifact to ingest");
  }
  await store.close();

  return {
    home,
    output,
    environment: createStaticEnvironment({
      FALRYN_STATE_DIR: state,
      FALRYN_ARTIFACT_DIR: artifacts,
      FALRYN_TEMP_DIR: temp,
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
    stdout: streams.resultWrites().join(""),
  };
}

describe("artifact command parsing", () => {
  test("routes list, show, and get invocations", async () => {
    const list = await parseInvocation(["artifact", "list"]);
    expect(list.kind).toBe("run");
    if (list.kind === "run") {
      expect(list.command).toBe("artifact.list");
    }

    const show = await parseInvocation(["artifact", "show", "cli-artifact-1"]);
    expect(show.kind).toBe("run");
    if (show.kind === "run") {
      expect(show.command).toBe("artifact.show");
    }

    const get = await parseInvocation([
      "artifact",
      "get",
      "cli-artifact-1",
      "--output",
      "/tmp/out",
    ]);
    expect(get.kind).toBe("run");
    if (get.kind === "run") {
      expect(get.command).toBe("artifact.get");
      expect(get.artifactArgs?.action).toBe("get");
    }
  });
});

describe("artifact command behavior", () => {
  test("lists stored artifacts with a bounded expansion route", async () => {
    const seeded = await seededHome({});
    const result = await run(["artifact", "list"], seeded);
    expect(result.code).toBe(EXIT_CODES.COMPLETED);
    expect(result.out).toContain("cli-artifact-1");
  });

  test("shows metadata for a stored artifact", async () => {
    const seeded = await seededHome({});
    const result = await run(["artifact", "show", "cli-artifact-1"], seeded);
    expect(result.code).toBe(EXIT_CODES.COMPLETED);
    expect(result.out).toContain("text/plain");
  });

  test("writes bytes to a destination without inlining them in the result", async () => {
    const seeded = await seededHome({ bytes: BINARY });
    const result = await run(
      ["artifact", "get", "cli-artifact-1", "--output", seeded.output],
      seeded,
    );
    expect(result.code).toBe(EXIT_CODES.COMPLETED);
    expect(result.out).not.toContain("artifact-bytes");
    expect(new Uint8Array(await readFile(seeded.output))).toEqual(BINARY);
  });

  test("streams bytes to stdout when it is not a terminal", async () => {
    const seeded = await seededHome({});
    const result = await run(["artifact", "get", "cli-artifact-1"], seeded);
    expect(result.code).toBe(EXIT_CODES.COMPLETED);
    expect(result.stdout).toBe("artifact-bytes");
  });

  test("reports a missing artifact as not found", async () => {
    const seeded = await seededHome({});
    const result = await run(["artifact", "show", "missing-artifact"], seeded);
    expect(result.code).not.toBe(EXIT_CODES.COMPLETED);
    expect(result.err.toLowerCase()).toContain("not found");
  });

  test("refuses restricted retrieval without an empty success", async () => {
    const seeded = await seededHome({ restricted: true });
    const result = await run(
      ["artifact", "get", "cli-artifact-1", "--output", seeded.output],
      seeded,
    );
    expect(result.code).not.toBe(EXIT_CODES.COMPLETED);
    expect(result.err.toLowerCase()).toContain("not found");
  });
});
