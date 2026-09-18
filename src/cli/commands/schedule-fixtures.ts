import { expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
/** Shared real-process journey for source and the shipped binary. */
export async function scheduleCliJourney(binary: readonly string[], root: string) {
  const env = {
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
  async function invoke(
    command: { operation: string; [key: string]: unknown },
    expectedFailure?: string,
  ) {
    const input = join(root, "input.json");
    await writeFile(input, JSON.stringify(command));
    const child = Bun.spawn(
      [
        ...binary,
        "schedule",
        command.operation,
        "--input",
        input,
        "--format",
        "json",
        "--non-interactive",
      ],
      { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 15000 },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (expectedFailure) {
      const result = JSON.parse(stdout);
      expect(exit).not.toBe(0);
      expect(result.payload).toMatchObject({ ok: false, error: { code: expectedFailure } });
      return result.payload;
    }
    if (exit !== 0) throw new Error(`${exit}: ${stdout} ${stderr}`);
    const result = JSON.parse(stdout);
    expect(result.payload.ok).toBe(true);
    return result.payload.value;
  }
  const definition = {
    version: 1,
    timing: { trigger: { kind: "interval", everyMs: 60000 } },
    missed: { kind: "latest" },
    target: { kind: "action", capability: "builtin:workspace/stat_path@1", input: { path: "." } },
  };
  const created = await invoke({ operation: "create", id: "sample", definition });
  expect(created.state).toBe("disabled");
  const listed = await invoke({ operation: "list" });
  expect(listed.entries[0]).toMatchObject({ id: "sample", state: "disabled" });
  const preview = await invoke({ operation: "preview", definition });
  expect(preview).toMatchObject({ executionStarted: false, valid: process.platform !== "win32" });
  if (process.platform === "win32") {
    await invoke(
      { operation: "enable", id: "sample", expectedRevision: 1 },
      "schedule-host-unavailable",
    );
    expect((await invoke({ operation: "inspect", id: "sample" })).state).toBe("disabled");
    return;
  }
  const enabled = await invoke({ operation: "enable", id: "sample", expectedRevision: 1 });
  expect(enabled.state).toBe("enabled");
  const workflowDefinition = {
    ...definition,
    target: {
      kind: "workflow",
      arguments: {},
      definition: {
        version: 1,
        id: "user:scheduled-inspection",
        label: "Scheduled inspection",
        argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
        nodes: [
          {
            key: "stat",
            kind: "action",
            capability: "builtin:workspace/stat_path@1",
            effect: "observation",
            input: { path: { from: "literal", value: "." } },
            resultPath: ["kind"],
            resultSchema: { type: "string" },
          },
        ],
        outputs: { kind: { from: "node", node: "stat" } },
      },
    },
  };
  await invoke({ operation: "create", id: "workflow", definition: workflowDefinition });
  expect(await invoke({ operation: "preview", definition: workflowDefinition })).toMatchObject({
    valid: true,
  });
  await invoke({ operation: "enable", id: "workflow", expectedRevision: 1 });
  const host = Bun.spawn(
    [...binary, "schedule", "host", "--format", "json", "--timeout", "15000", "--non-interactive"],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  const competing = Bun.spawn(
    [...binary, "schedule", "host", "--format", "jsonl", "--timeout", "15000", "--non-interactive"],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  let history: Awaited<ReturnType<typeof invoke>>;
  let workflowHistory: Awaited<ReturnType<typeof invoke>>;
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      history = await invoke({ operation: "history", id: "sample" });
      workflowHistory = await invoke({ operation: "history", id: "workflow" });
      if (history.attempts[0]?.terminal && workflowHistory.attempts[0]?.terminal) break;
      if (Date.now() >= deadline) throw new Error("schedule-completion-deadline");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(history.attempts[0].terminal).toMatchObject({ status: "succeeded" });
    expect(workflowHistory.attempts[0].terminal).toMatchObject({ status: "succeeded" });
    expect(workflowHistory.attempts[0].workflow).not.toBeNull();
    for (const id of ["sample", "workflow"]) {
      const inspected = await invoke({ operation: "inspect", id });
      await invoke({ operation: "pause", id, expectedRevision: inspected.revision });
    }
  } finally {
    host.kill("SIGINT");
    competing.kill("SIGINT");
    await Promise.all([host.exited, competing.exited]);
  }
  expect(await invoke({ operation: "inspect", id: "sample" })).toMatchObject({
    state: "paused",
    lastAttempt: { terminal: { status: "succeeded" } },
  });
  // A run may settle during host shutdown, after wake subscriptions stop.
  // Restart delivers its durable outbox with both definitions paused, never rerunning work.
  const delivery = Bun.spawn(
    [...binary, "schedule", "host", "--format", "json", "--timeout", "3000", "--non-interactive"],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  await delivery.exited;
  expect((await invoke({ operation: "history", id: "workflow" })).attempts).toEqual(
    workflowHistory.attempts,
  );
  const session = `schedule-${history.attempts[0].id}`;
  function command(args: string[]) {
    const output = Bun.spawnSync([...binary, ...args, "--format", "json", "--non-interactive"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    });
    const text = new TextDecoder().decode(output.stdout);
    if (output.exitCode !== 0)
      throw new Error(`${text} ${new TextDecoder().decode(output.stderr)}`);
    return JSON.parse(text);
  }
  const exported = command([
    "export",
    "--session",
    session,
    "--write",
    "--name",
    "schedule-result",
  ]);
  expect(exported.payload.counts.events).toBeGreaterThan(0);
  const bytes = await readFile(exported.payload.bundle.path, "utf8");
  expect(bytes).toContain("schedule.settled");
  expect(bytes).toContain(history.attempts[0].id);
  const replayed = command(["replay", session]);
  expect(replayed.payload).toMatchObject({ effectFree: true, sessionId: session });
  expect((await invoke({ operation: "history", id: "sample" })).attempts).toEqual(history.attempts);
  expect(new Set(history.attempts.map((attempt: { slot: string }) => attempt.slot)).size).toBe(
    history.attempts.length,
  );
}
