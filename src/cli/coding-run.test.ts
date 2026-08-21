/**
 * Headless `falryn run` (#708): prompt resolution, product hosting, fail-closed
 * without a provider, and the four output contracts through dispatch.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIGURATION_FILE_NAME } from "../config/index.ts";
import {
  configurationGeneration,
  createStaticEnvironment,
  localPath,
  streamId,
} from "../domain/index.ts";
import { createDeterministicProviderAdapter } from "../providers/index.ts";
import { resolveCodingPrompt, runCoding } from "./coding-run.ts";
import { parseInvocation } from "./command-tree.ts";
import { dispatch } from "./dispatch.ts";
import type { GlobalOptions } from "./options.ts";
import { CLI_EVENT_STREAM, createServiceProvider } from "./services.ts";
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
  readonly environment: ReturnType<typeof createStaticEnvironment>;
}> {
  const home = await mkdtemp(join(tmpdir(), "falryn-run-cli-"));
  homes.push(home);
  const state = join(home, "state");
  const config = join(home, "config");
  const primary = join(home, "primary");
  for (const directory of [home, state, config, primary]) {
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o700);
  }
  return {
    home,
    primary,
    environment: createStaticEnvironment({
      FALRYN_STATE_DIR: state,
      FALRYN_CONFIG_DIR: config,
    }),
  };
}

function globalsFor(seeded: Awaited<ReturnType<typeof seededHome>>): GlobalOptions {
  return {
    format: "human",
    color: "never",
    quiet: false,
    verbose: false,
    nonInteractive: true,
    workspace: seeded.primary,
    addDirs: [],
    profile: null,
    timeoutMs: null,
    help: false,
    version: false,
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

describe("resolveCodingPrompt", () => {
  test("prefers argv text over stdin", async () => {
    const streams = createRecordingCliStreams({ stdin: "from stdin" });
    const resolved = await resolveCodingPrompt(["ship", "it"], streams.input);
    expect(resolved).toEqual({ ok: true, prompt: "ship it", source: "argv" });
  });

  test("reads stdin when argv is empty", async () => {
    const streams = createRecordingCliStreams({ stdin: "  from pipe  " });
    const resolved = await resolveCodingPrompt([], streams.input);
    expect(resolved).toEqual({ ok: true, prompt: "from pipe", source: "stdin" });
  });

  test("fails closed when nothing supplies a prompt", async () => {
    const streams = createRecordingCliStreams({ stdin: null });
    const resolved = await resolveCodingPrompt([], streams.input);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      return;
    }
    expect(resolved.reason).toContain("never prompts");
  });
});

describe("runCoding", () => {
  test("hosts a turn then fails closed without a provider", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const streams = createRecordingCliStreams({ stdin: null });
    const result = await runCoding(
      services,
      { promptParts: ["add", "tests"] },
      {
        input: streams.input,
        globals: globalsFor(seeded),
        identities: {
          sessionId: "session-run-test",
          turnId: "turn-run-test",
          traceId: "trace-run-test",
        },
      },
    );
    expect(result.command).toBe("run");
    expect(result.outcome.kind).toBe("failed");
    expect(result.payload?.stage).toBe("provider-required");
    expect(result.payload?.prompt).toBe("add tests");
    expect(result.payload?.sessionId).toBe("session-run-test");
    expect(result.payload?.turnId).toBe("turn-run-test");
    expect(result.payload?.eventCount).toBeGreaterThanOrEqual(3);
    expect(result.errors[0]?.code).toBe("provider.adapter-required");
  });

  test("completes hosted when a provider adapter is supplied", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const streams = createRecordingCliStreams({ stdin: null });
    const result = await runCoding(
      services,
      { promptParts: ["hello"] },
      {
        input: streams.input,
        globals: globalsFor(seeded),
        providerAdapter: createDeterministicProviderAdapter(),
        identities: {
          sessionId: "session-run-hosted",
          turnId: "turn-run-hosted",
          traceId: "trace-run-hosted",
        },
      },
    );
    expect(result.outcome.kind).toBe("completed");
    expect(result.payload?.stage).toBe("hosted");
    expect(result.errors).toEqual([]);
  });

  test("attaches the OpenAI-compatible adapter when an env credential resolves (#710)", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-run-cred-"));
    homes.push(home);
    const state = join(home, "state");
    const config = join(home, "config");
    const primary = join(home, "primary");
    for (const directory of [home, state, config, primary]) {
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o700);
    }
    const seeded = {
      home,
      primary,
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: state,
        FALRYN_CONFIG_DIR: config,
        FALRYN_OPENAI_API_KEY: "sk-test-not-a-real-key",
      }),
    };
    const services = (globals: GlobalOptions) =>
      createServiceProvider(globals, {
        home: localPath(seeded.home),
        platform: "darwin",
        environment: seeded.environment,
        currentDirectory: localPath(seeded.primary),
      });
    const streams = createRecordingCliStreams({ stdin: null });
    const result = await runCoding(
      services(globalsFor(seeded)),
      { promptParts: ["with", "key"] },
      {
        input: streams.input,
        globals: globalsFor(seeded),
        identities: {
          sessionId: "session-run-cred",
          turnId: "turn-run-cred",
          traceId: "trace-run-cred",
        },
      },
    );
    expect(result.outcome.kind).toBe("completed");
    expect(result.payload?.stage).toBe("hosted");
    expect(result.errors).toEqual([]);
  });

  test("loads configuration through the loader before hosting (#728)", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)(globalsFor(seeded));
    const graph = services();
    const configFile = join(String(graph.configurationRoot), CONFIGURATION_FILE_NAME);
    await writeFile(
      configFile,
      JSON.stringify({ schemaVersion: 1, diagnostics: { level: "warn" } }),
      "utf8",
    );
    const streams = createRecordingCliStreams({ stdin: null });
    await runCoding(
      services,
      { promptParts: ["observe loader"] },
      {
        input: streams.input,
        globals: globalsFor(seeded),
        identities: {
          sessionId: "session-run-config",
          turnId: "turn-run-config",
          traceId: "trace-run-config",
        },
      },
    );
    expect(graph.loader.current()?.generation).toBe(configurationGeneration.from(0));
    expect(graph.loader.current()?.values["diagnostics.level"]).toBe("warn");
    const read = await graph.eventStore.readFrom(
      { streamId: streamId.from(CLI_EVENT_STREAM), afterSequence: null },
      20,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.value.some((event) => event.kind === "configuration.generation.changed")).toBe(
      true,
    );
  });
});

describe("falryn run through dispatch", () => {
  test("parses prompt fragments", async () => {
    const invocation = await parseInvocation(["run", "fix", "me"]);
    expect(invocation.kind).toBe("run");
    if (invocation.kind !== "run") {
      return;
    }
    expect(invocation.command).toBe("run");
    expect(invocation.runArgs).toEqual({ promptParts: ["fix", "me"] });
  });

  test("projects provider-required through json", async () => {
    const seeded = await seededHome();
    const streams = createRecordingCliStreams({ stdin: null });
    const code = await dispatch({
      argv: ["--format", "json", "--non-interactive", "--workspace", seeded.primary, "run", "hi"],
      streams,
      services: providerFor(seeded),
    });
    expect(code).not.toBe(0);
    const body = JSON.parse(streams.resultWrites().join("")) as {
      command: string;
      payload: { stage: string; prompt: string };
      outcome: { kind: string };
    };
    expect(body.command).toBe("run");
    expect(body.payload.stage).toBe("provider-required");
    expect(body.payload.prompt).toBe("hi");
    expect(body.outcome.kind).toBe("failed");
  });

  test("jsonl emits lifecycle events then a terminal result", async () => {
    const seeded = await seededHome();
    const streams = createRecordingCliStreams({ stdin: null });
    await dispatch({
      argv: ["--format", "jsonl", "--workspace", seeded.primary, "run", "jsonl"],
      streams,
      services: providerFor(seeded),
    });
    const lines = streams
      .resultWrites()
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { kind: string; terminal?: boolean });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((line) => line.kind === "event")).toBe(true);
    expect(lines.at(-1)?.kind).toBe("result");
    expect(lines.at(-1)?.terminal).toBe(true);
  });
});
