import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { openProductStore, removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { messageKey, type PeerMessage } from "../../domain/orchestration/peer-mailbox.ts";

afterEach(removeTemporaryRoots);
function worker(root: string, name: string, offset = 0) {
  const process = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      fileURLToPath(
        new URL("../../integrations/process/peer-mailbox-fixtures.ts", import.meta.url),
      ),
      root,
      name,
      String(offset),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = process.stdout.getReader();
  let buffered = "";
  async function read(): Promise<unknown> {
    while (!buffered.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`worker ended: ${await new Response(process.stderr).text()}`);
      buffered += new TextDecoder().decode(chunk.value);
      if (buffered.length > 65_536) throw new Error("worker output bound");
    }
    const at = buffered.indexOf("\n");
    const line = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    return JSON.parse(line);
  }
  return {
    process,
    read,
    async call(value: unknown) {
      process.stdin.write(`${JSON.stringify(value)}\n`);
      await process.stdin.flush();
      return read();
    },
    async close() {
      process.stdin.end();
      await process.exited;
    },
  };
}
test("two independent processes retain recipient-committed mail through sender and recipient restart", async () => {
  const root = await temporaryRoot("fp-");
  const database = await openProductStore(root);
  if (!database.ok) throw new Error(database.error.code);
  await database.value.close();
  let alice = worker(root, "alice");
  let bob = worker(root, "bob");
  const active = [alice, bob];
  try {
    expect(await alice.read()).toMatchObject({ ready: { sessionId: "alice" } });
    expect(await bob.read()).toMatchObject({ ready: { sessionId: "bob" } });
    const sender = { sessionId: "alice", agentId: "alice", generation: 1 };
    const recipient = { sessionId: "bob", agentId: "bob", generation: 1 };
    expect(await alice.call({ action: "allow", sender: recipient })).toMatchObject({ ok: true });
    expect(await bob.call({ action: "allow", sender })).toMatchObject({ ok: true });
    const now = Date.now();
    const scope = {
      workspace: canonicalDigest("w"),
      project: canonicalDigest("p"),
      user: canonicalDigest("u"),
      environment: canonicalDigest("e"),
      trust: canonicalDigest("t"),
    };
    const request: PeerMessage = {
      version: 1,
      id: "request",
      sender,
      recipient,
      scope,
      laneSequence: 1,
      createdAt: now,
      expiresAt: now + 60_000,
      kind: "request",
      correlation: null,
      text: "selected peer evidence",
      artifacts: [],
      sensitivity: "internal",
      retention: "normal",
      provenance: { source: "peer-evidence", effectAuthority: false, causalMessage: null, hops: 0 },
    };
    expect(await alice.call({ action: "send", message: request })).toMatchObject({
      ok: true,
      value: { delivery: "accepted-for-persistence" },
    });
    // Abrupt death leaves no close callback. Advance both process clocks beyond the persisted leases.
    bob.process.kill("SIGKILL");
    alice.process.kill("SIGKILL");
    await Promise.all([bob.process.exited, alice.process.exited]);
    alice = worker(root, "alice", 31_000);
    active.push(alice);
    expect(await alice.read()).toMatchObject({ ready: sender });
    bob = worker(root, "bob", 31_000);
    active.push(bob);
    await bob.read();
    expect(await bob.call({ action: "inspect", key: messageKey(request) })).toMatchObject({
      ok: true,
      value: { message: { text: request.text } },
    });
    const reply = {
      ...request,
      id: "reply",
      sender: recipient,
      recipient: sender,
      kind: "reply" as const,
      correlation: request.id,
      text: "the explicit answer",
    };
    expect(await bob.call({ action: "send", message: reply })).toMatchObject({ ok: true });
    await alice.close();
    const resumed = worker(root, "alice", 31_000);
    active.push(resumed);
    await resumed.read();
    expect(await resumed.call({ action: "inspect", key: messageKey(request) })).toMatchObject({
      ok: true,
      value: { receipt: { handling: "replied", reply: messageKey(reply) } },
    });
    expect(await bob.call({ action: "retire" })).toMatchObject({ ok: true });
    expect(
      await resumed.call({ action: "send", message: { ...request, id: "late", laneSequence: 2 } }),
    ).toMatchObject({ ok: false, error: { code: "stale" } });
  } finally {
    for (const child of active) if (child.process.exitCode === null) child.process.kill();
    await Promise.allSettled(active.map((child) => child.process.exited));
  }
}, 15_000);
