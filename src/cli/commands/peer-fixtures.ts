import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { messageKey, type PeerMessage } from "../../domain/orchestration/peer-mailbox.ts";

/** Private product directories for one per-user state root, shared by every worktree. */
export function peerCliEnvironment(root: string) {
  return {
    PATH: process.env.PATH ?? "",
    // The per-user peer scope reads the account name, as a real terminal provides it.
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
    USERNAME: process.env.USERNAME ?? "",
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
}

/** One fresh command process per action; returns the terminal peer payload, success or refusal. */
export function peerCli(command: readonly string[], root: string) {
  const environment = peerCliEnvironment(root);
  let inputs = 0;
  return async function invoke(
    cwd: string,
    session: string,
    action: { operation: string; [key: string]: unknown },
    format = "json",
  ) {
    inputs += 1;
    const input = join(root, `peer-action-${inputs}.json`);
    await writeFile(input, JSON.stringify(action));
    // Asynchronous, so a live endpoint hosted by the calling process can answer the child.
    const child = Bun.spawn(
      [...command, "peer", action.operation, session, "--input", input, "--format", format],
      { cwd, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    if (format === "human") return stdout;
    expect(stderr).toBe("");
    const terminal = JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
    expect(terminal.command).toBe("peer");
    expect(child.exitCode === 0).toBe(terminal.payload.ok);
    return terminal.payload;
  };
}

/** Run the public command boundary in fresh processes against one private state root. */
export async function peerCliJourney(command: readonly string[], root: string) {
  const cli = peerCli(command, root);
  async function invoke(
    session: string,
    action: { operation: string; [key: string]: unknown },
    format = "json",
  ) {
    const payload = await cli(root, session, action, format);
    if (format === "human") return payload;
    expect(payload.ok).toBe(true);
    return payload.value;
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
