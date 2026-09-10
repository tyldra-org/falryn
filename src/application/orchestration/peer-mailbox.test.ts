import { afterEach, expect, test } from "bun:test";
import { openProductStore, removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { createMailboxRepository } from "../../data/orchestration/mailbox-store.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  configurationGeneration,
  createSystemClock,
  invocationId,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { messageKey, type PeerMessage } from "../../domain/orchestration/peer-mailbox.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import { createToolHookRegistry } from "../../domain/tools/index.ts";
import { createPeerCrypto } from "../../integrations/process/peer-crypto.ts";
import { createPeerIpc } from "../../integrations/process/peer-ipc.ts";
import { createTurnEventJournal } from "../runtime/turn-event-journal.ts";
import { composePeerTool } from "../tools/peer-tool.ts";
import { createProductToolGateway } from "../tools/product-tool-gateway.ts";
import { executePeerAction } from "./peer-actions.ts";
import { openPeerMailbox, type PeerMailbox } from "./peer-mailbox.ts";
import { createProductResources } from "./product-resources.ts";

afterEach(removeTemporaryRoots);
test("real IPC and SQLite send/reply wake once and reject a forged endpoint", async () => {
  const root = await temporaryRoot("falryn-peers-");
  const opened = await openProductStore(root);
  if (!opened.ok) throw new Error(opened.error.code);
  const store = opened.value;
  const clock = createSystemClock();
  const resources = createProductResources(clock, { maxConcurrent: 2 });
  const repository = createMailboxRepository(store);
  const transport = createPeerIpc({ directory: `${root}/ipc` });
  let dropReply = false;
  let exchanges = 0;
  const lossyTransport = {
    ...transport,
    async request(...args: Parameters<typeof transport.request>) {
      exchanges += 1;
      const response = await transport.request(...args);
      return dropReply && exchanges % 2 === 0
        ? { ok: false as const, error: { code: "unavailable" as const } }
        : response;
    },
  };
  const scope = {
    workspace: canonicalDigest("w"),
    project: canonicalDigest("p"),
    user: canonicalDigest("u"),
    environment: canonicalDigest("e"),
    trust: canonicalDigest("t"),
  };
  const peers: PeerMailbox[] = [];
  const controllers = [resources.openTask("1"), resources.openTask("1")] as const;
  try {
    for (const [index, task] of controllers.entries()) {
      const peer = await openPeerMailbox({
        repository,
        transport: index === 0 ? lossyTransport : transport,
        clock,
        resources: task,
        crypto: createPeerCrypto(),
        identity: { agentId: `a-${index}`, sessionId: `s-${index}`, generation: 1 },
        scope,
        label: "same name",
        authorizeArtifacts: async (message) => message.artifacts.length === 0,
        redact: (text) => text,
      });
      if (!peer.ok) throw new Error(peer.error.code);
      peers.push(peer.value);
    }
    const alice = peers[0];
    const bob = peers[1];
    if (!alice || !bob) throw new Error("missing peer");
    const noSignal = new AbortController().signal;
    for (const input of [
      { operation: "allow", peer: bob.identity },
      { operation: "revoke" },
      { operation: "endpoint", as: bob.identity },
      { operation: "answer-question", answer: "approve" },
    ]) {
      expect((await executePeerAction(alice, input, "model", noSignal)).ok).toBe(false);
    }
    expect(alice.discover().ok && alice.discover()).toEqual({
      ok: true,
      value: {
        items: [],
        cursor: { version: 1, endpoint: alice.identity, after: 0 },
        complete: true,
      },
    });
    expect(bob.policy(alice.identity, { mode: "allow", muted: false, perMinute: 64 }).ok).toBe(
      true,
    );
    expect(alice.policy(bob.identity, { mode: "allow", muted: false, perMinute: 64 }).ok).toBe(
      true,
    );
    const now = Number(clock.now());
    const message: PeerMessage = {
      version: 1,
      id: "ask",
      sender: alice.identity,
      recipient: bob.identity,
      scope,
      laneSequence: 1,
      createdAt: now,
      expiresAt: now + 20_000,
      kind: "request",
      correlation: null,
      text: "a private question",
      artifacts: [],
      sensitivity: "internal",
      retention: "normal",
      provenance: { source: "peer-evidence", effectAuthority: false, causalMessage: null, hops: 0 },
    };
    const notices: string[] = [];
    bob.subscribe((notice) => notices.push(notice.key));
    const accepted = await alice.send(message, noSignal);
    expect(accepted.ok && accepted.value.delivery).toBe("accepted-for-persistence");
    expect(await alice.send(message, noSignal)).toEqual(accepted);
    expect(notices).toEqual([messageKey(message)]);
    const wait = alice.wait(messageKey(message), now + 10_000, noSignal);
    const reply = {
      ...message,
      id: "reply",
      sender: bob.identity,
      recipient: alice.identity,
      kind: "reply" as const,
      correlation: message.id,
      text: "explicit reply",
    };
    const replied = await bob.send(reply, noSignal);
    expect(replied.ok).toBe(true);
    const settled = await wait;
    expect(settled.ok && settled.value).toMatchObject({
      handling: "replied",
      wait: "settled",
      reply: messageKey(reply),
    });
    const idle = await alice.availability(
      bob.identity,
      "idle",
      Number(clock.now()) + 2_000,
      noSignal,
    );
    expect(idle.ok && idle.value).toMatchObject({
      wait: "settled",
      reason: "idle",
      observation: { state: "idle", identity: bob.identity },
    });
    const route = bob.endpoint();
    const modelPeer = (peer: PeerMailbox, task: (typeof controllers)[number]) => {
      const generation = configurationGeneration.from(1);
      const bundle = composePeerTool(generation, peer);
      const hooks = createToolHookRegistry(generation, []);
      if (!hooks.ok) throw new Error(hooks.error.code);
      const correlation = {
        sessionId: sessionId.from(peer.identity.sessionId),
        workspaceId: workspaceId.from("w"),
        traceId: traceId.from("trace"),
        configurationGeneration: generation,
      };
      const journal = createTurnEventJournal({
        eventStore: createInMemoryEventStore(),
        clock,
        streamId: streamId.from(`peer-${peer.identity.agentId}`),
        correlation,
      });
      const gateway = createProductToolGateway({
        clock,
        journal,
        resources,
        taskResources: task,
        registry: bundle.registry,
        runner: bundle.runner,
        correlation,
        turnId: turnId.from("peer-turn"),
        disclosedToolNames: new Set(["peer"]),
        hooks: hooks.value,
        confirmation: {
          resolve: async (request) => ({
            kind: "confirmed",
            confirmationId: request.confirmationId,
          }),
        },
        effectLedger: new Map(),
      });
      const capabilityId = bundle.registry.entries[0]?.manifest.capabilityId;
      if (!capabilityId) throw new Error("missing peer capability");
      return (message: PeerMessage) =>
        gateway.execute({
          invocationId: invocationId.from(message.id),
          toolCallId: message.id,
          toolName: "peer",
          capabilityId,
          version: 1,
          effect: "mutation",
          input: { operation: "send", messageJson: JSON.stringify(message) },
          signal: noSignal,
        });
    };
    const aliceModel = modelPeer(alice, controllers[0]);
    const bobModel = modelPeer(bob, controllers[1]);
    const reciprocal = await Promise.all([
      aliceModel({ ...message, id: "one-way-a", laneSequence: 2, kind: "message" }),
      bobModel({
        ...message,
        id: "one-way-b",
        laneSequence: 2,
        kind: "message",
        sender: bob.identity,
        recipient: alice.identity,
      }),
    ]);
    for (const result of reciprocal)
      expect(result).toMatchObject({
        status: "completed",
        output: {
          value: {
            ok: true,
            value: {
              delivery: "accepted-for-persistence",
              handling: "unacknowledged",
              wait: "open",
            },
          },
        },
      });
    exchanges = 0;
    dropReply = true;
    const lost = { ...message, id: "lost-receipt", laneSequence: 3, kind: "message" as const };
    expect(await alice.send(lost, noSignal)).toMatchObject({
      ok: true,
      value: { delivery: "accepted-for-persistence" },
    });
    dropReply = false;
    expect(await alice.send(lost, noSignal)).toMatchObject({
      ok: true,
      value: { delivery: "accepted-for-persistence" },
    });
    if (!route.ok) throw new Error(route.error.code);
    const forged = await transport.request(
      route.value.address,
      { version: 1, sender: alice.identity, processGeneration: "forged", sealed: "{}" },
      noSignal,
    );
    expect(forged.ok && forged.value).toEqual({ ok: false, error: { code: "denied" } });
    expect(bob.state("terminal").ok).toBe(true);
    await bob.close();
    const terminal = await alice.availability(
      bob.identity,
      "terminal",
      alice.deadlineAfter(1000),
      noSignal,
      "terminal-after-close",
    );
    expect(terminal).toMatchObject({
      ok: true,
      value: { wait: "settled", reason: "terminal", observation: { identity: bob.identity } },
    });
  } finally {
    for (const peer of peers) await peer.close();
    for (const task of controllers) task.close();
    await store.close();
  }
}, 15_000);
