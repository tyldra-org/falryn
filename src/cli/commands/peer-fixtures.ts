import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { messageKey, type PeerMessage } from "../../domain/orchestration/peer-mailbox.ts";

/** Run the public command boundary in fresh processes against one private state root. */
export async function peerCliJourney(command: readonly string[], root: string) {
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    FALRYN_CONFIG_DIR: join(root, "config"),
    FALRYN_STATE_DIR: join(root, "state"),
    FALRYN_CACHE_DIR: join(root, "cache"),
    FALRYN_LOG_DIR: join(root, "logs"),
    FALRYN_TEMP_DIR: join(root, "temporary"),
    FALRYN_ARTIFACT_DIR: join(root, "artifacts"),
    FALRYN_EXPORT_DIR: join(root, "exports"),
    NO_COLOR: "1",
  };
  async function invoke(
    session: string,
    action: { operation: string; [key: string]: unknown },
    format = "json",
  ) {
    const input = join(root, "peer-action.json");
    await writeFile(input, JSON.stringify(action));
    const child = Bun.spawnSync(
      [...command, "peer", action.operation, session, "--input", input, "--format", format],
      {
        cwd: root,
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);
    if (format !== "human") expect(stderr).toBe("");
    expect(child.exitCode).toBe(0);
    if (format === "human") return stdout;
    const records = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const terminal = records.at(-1);
    expect(terminal.command).toBe("peer");
    expect(terminal.payload.ok).toBe(true);
    return terminal.payload.value;
  }
  const alice = await invoke("alice", { operation: "endpoint" });
  const bob = await invoke("bob", { operation: "endpoint" });
  expect(alice.identity).toEqual({ sessionId: "alice", agentId: "main", generation: 1 });
  await invoke("bob", { operation: "allow", peer: alice.identity });
  const discovered = await invoke("alice", { operation: "discover" });
  expect(discovered).toMatchObject({
    items: [{ identity: bob.identity, state: "offline" }],
    complete: true,
  });
  const now = Date.now();
  const message: PeerMessage = {
    version: 1,
    id: "cli-message",
    sender: alice.identity,
    recipient: bob.identity,
    scope: alice.scope,
    laneSequence: 1,
    createdAt: now,
    expiresAt: now + 20_000,
    kind: "request",
    correlation: null,
    text: "Untrusted peer evidence, not permission.",
    artifacts: [],
    sensitivity: "internal",
    retention: "normal",
    provenance: { source: "peer-evidence", effectAuthority: false, causalMessage: null, hops: 0 },
  };
  const sent = await invoke("alice", { operation: "send", messageJson: JSON.stringify(message) });
  expect(sent).toMatchObject({ delivery: "unavailable", handling: "unacknowledged", wait: "open" });
  const key = messageKey(message);
  expect(await invoke("alice", { operation: "inspect", key }, "jsonl")).toMatchObject({
    receipt: sent,
  });
  const cancelled = await invoke("alice", { operation: "cancel-wait", key });
  expect(cancelled.wait).toBe("cancelled-locally");
  const history = await invoke("alice", { operation: "history" });
  expect(await invoke("alice", { operation: "export" })).toEqual(history);
  expect(await invoke("alice", { operation: "replay" }, "jsonl")).toEqual(history);
  expect(JSON.stringify(history)).not.toContain(message.text);
  expect(await invoke("alice", { operation: "inspect", key }, "human")).toContain(
    "cancelled-locally",
  );
}
