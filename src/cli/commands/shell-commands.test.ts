/**
 * `falryn commands` (#790): the generated shell command reference through the real
 * dispatcher, in every output format, without constructing any service.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { SHELL_REGISTRY } from "../../tui/commands/registry.ts";
import { dispatch } from "../dispatch.ts";
import { EXIT_CODES } from "../output/exit.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import type { ServiceProvider } from "../runtime/services.ts";

/** Fails the test if the command asks for any service. */
function poisoned(): ServiceProvider {
  return () => {
    throw new Error("falryn commands must not construct a service");
  };
}

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/**
 * Human and quiet output run against a provider that throws if asked for any
 * service. Machine output needs the clock and the over-bound artifact writer, as
 * every machine result does, so it runs against a temporary home.
 */
async function run(argv: readonly string[], machine = false) {
  const streams = createRecordingCliStreams();
  let code: number;
  if (machine) {
    const home = await mkdtemp(join(tmpdir(), "falryn-commands-"));
    homes.push(home);
    code = await dispatch({
      argv,
      streams,
      serviceOverrides: {
        home: localPath(home),
        platform: "darwin",
        environment: createStaticEnvironment({ FALRYN_STATE_DIR: home, FALRYN_CONFIG_DIR: home }),
      },
    });
  } else {
    code = await dispatch({ argv, streams, services: poisoned });
  }
  return {
    code,
    stdout: streams.resultWrites().join(""),
    stderr: streams.diagnosticWrites().join(""),
  };
}

describe("falryn commands", () => {
  test("prints the registry generation and every command for a person", async () => {
    const human = await run(["commands"]);
    expect(human.code).toBe(EXIT_CODES.COMPLETED);
    expect(human.stdout).toContain(
      `Falryn shell commands (registry ${SHELL_REGISTRY.generation}, ${SHELL_REGISTRY.entries.length} entries)`,
    );
    expect(human.stdout).toContain("Select execution mode (mode.select)");
    expect(human.stdout).toContain(
      "/mode [ask|plan|debug|agent]; also /ask, /plan, /debug, /agent",
    );
    expect(human.stdout).toContain("key ctrl+p");
    expect(human.stdout).toContain("Not available yet: durable goals are not built yet (#797)");
  });

  test("carries the same reference as JSON with its schema version", async () => {
    const json = await run(["commands", "--format", "json"], true);
    expect(json.code).toBe(EXIT_CODES.COMPLETED);
    const envelope = JSON.parse(json.stdout) as {
      command: string;
      outcome: { kind: string };
      payload: {
        schemaVersion: number;
        generation: string;
        commands: { id: string; usage: string[]; binding: string | null; status: unknown }[];
      };
    };
    expect(envelope.command).toBe("commands");
    expect(envelope.outcome.kind).toBe("completed");
    expect(envelope.payload.schemaVersion).toBe(1);
    expect(envelope.payload.generation).toBe(SHELL_REGISTRY.generation);
    expect(envelope.payload.commands.map((command) => command.id)).toEqual(
      SHELL_REGISTRY.entries.map((entry) => entry.id),
    );
    expect(envelope.payload.commands.find((command) => command.id === "app.help")).toMatchObject({
      usage: ["/help"],
      binding: "?",
    });
    expect(
      envelope.payload.commands.find((command) => command.id === "tools.inspect")?.status,
    ).toEqual({
      kind: "planned",
      owner: "#192",
      reason: "the capability inspector is not reachable from the shell yet",
    });
  });

  test("quiet prints one canonical usage per line and marks planned commands", async () => {
    const quiet = await run(["commands", "--format", "quiet"]);
    expect(quiet.code).toBe(EXIT_CODES.COMPLETED);
    const lines = quiet.stdout.trimEnd().split("\n");
    expect(lines).toContain("/help");
    expect(lines).toContain("/mode [ask|plan|debug|agent]");
    expect(lines).toContain("/tools\tplanned #192");
    expect(lines.every((line) => line.startsWith("/"))).toBe(true);
  });

  test("refuses arguments as invalid usage", async () => {
    const extra = await run(["commands", "extra"]);
    expect(extra.code).toBe(EXIT_CODES.INVALID_USAGE);
    expect(extra.stdout).toBe("");
  });
});
