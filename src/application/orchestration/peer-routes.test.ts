/**
 * Exact directional routes between endpoints in different scopes, over real
 * IPC sockets and one shared SQLite registry.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { openProductStore, removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { createMailboxRepository } from "../../data/orchestration/mailbox-store.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { createSystemClock } from "../../domain/foundation/index.ts";
import type {
  MailboxReceipt,
  PeerIdentity,
  PeerMessage,
  PeerRoutePreview,
  PeerRouteView,
  PeerScope,
} from "../../domain/orchestration/peer-mailbox.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { createPeerCrypto } from "../../integrations/process/peer-crypto.ts";
import { createPeerIpc } from "../../integrations/process/peer-ipc.ts";
import { executePeerAction } from "./peer-actions.ts";
import { openPeerMailbox, type PeerMailbox } from "./peer-mailbox.ts";
import { createProductResources } from "./product-resources.ts";

afterEach(removeTemporaryRoots);
const noSignal = new AbortController().signal;
const scopeFor = (workspace: string, trust = "trusted"): PeerScope => ({
  workspace: canonicalDigest(workspace),
  // Same repository remote and project name everywhere: they must never grant access.
  project: canonicalDigest("same-remote"),
  user: canonicalDigest("user"),
  environment: canonicalDigest("darwin"),
  trust: canonicalDigest(trust),
});

async function registry() {
  const root = await temporaryRoot("falryn-peer-routes-");
  const opened = await openProductStore(root);
  if (!opened.ok) throw new Error(opened.error.code);
  const store: SqliteStorePort = opened.value;
  const clock = createSystemClock();
  const resources = createProductResources(clock, { maxConcurrent: 4 });
  const repository = createMailboxRepository(store);
  const transport = createPeerIpc({ directory: `${root}/ipc` });
  const opened_: PeerMailbox[] = [];
  const authorized = new Map<string, boolean>();
  async function open(sessionId: string, scope: PeerScope, label = "main") {
    const identity: PeerIdentity = { sessionId, agentId: "main", generation: 1 };
    const peer = await openPeerMailbox({
      repository,
      transport,
      clock,
      resources: resources.openTask("1"),
      crypto: createPeerCrypto(),
      identity,
      scope,
      // Every worktree shows the same display name; names never select a route.
      label,
      authorize: async () => authorized.get(sessionId) ?? true,
      authorizeArtifacts: async () => true,
      redact: (text) => text,
    });
    if (!peer.ok) throw new Error(peer.error.code);
    opened_.push(peer.value);
    return peer.value;
  }
  let sequence = 0;
  const message = (
    sender: PeerMailbox,
    recipient: PeerMailbox,
    scope: PeerScope,
    overrides: Partial<PeerMessage> = {},
  ): PeerMessage => {
    const now = Date.now();
    sequence += 1;
    return {
      version: 1,
      id: `route-message-${sequence}`,
      sender: sender.identity,
      recipient: recipient.identity,
      scope,
      laneSequence: sequence,
      createdAt: now,
      expiresAt: now + 60_000,
      kind: "message",
      correlation: null,
      text: "Peer evidence, not permission.",
      artifacts: [],
      sensitivity: "internal",
      retention: "normal",
      provenance: {
        source: "peer-evidence",
        effectAuthority: false,
        causalMessage: null,
        hops: 0,
      },
      ...overrides,
    };
  };
  const act = (
    peer: PeerMailbox,
    action: Record<string, unknown>,
    actor: "user" | "model" = "user",
  ) => executePeerAction(peer, action, actor, noSignal);
  return {
    store,
    repository,
    open,
    message,
    act,
    authorized,
    async close() {
      for (const peer of opened_) await peer.close();
      await store.close();
    },
  };
}
const discovered = async (r: Awaited<ReturnType<typeof registry>>, peer: PeerMailbox) => {
  const page = await r.act(peer, { operation: "discover" });
  if (!page.ok) throw new Error(page.error.code);
  return (page.value as { items: { identity: PeerIdentity }[] }).items.map(
    (item) => item.identity.sessionId,
  );
};
const refusal = (result: { ok: boolean; error?: { code: string; reason?: string | undefined } }) =>
  result.ok ? "ok" : `${result.error?.code}:${result.error?.reason ?? ""}`;

describe("cross-worktree peer routes", () => {
  test("isolation holds until one exact direction is granted, and only that direction opens", async () => {
    const r = await registry();
    try {
      const alice = await r.open("alice", scopeFor("/work/tree-a"));
      const bob = await r.open("bob", scopeFor("/work/tree-b"));
      const carol = await r.open("carol", scopeFor("/work/clone-c"));
      const toBob = (from: PeerMailbox, scope: PeerScope) => r.message(from, bob, scope);

      // Same remote, same display name, a same-scope style allow: none of it opens a route.
      expect(await discovered(r, alice)).toEqual([]);
      expect(refusal(await r.act(bob, { operation: "allow", peer: alice.identity }))).toBe(
        "denied:route-missing",
      );
      expect(refusal(await alice.send(toBob(alice, scopeFor("/work/tree-a")), noSignal))).toBe(
        "denied:route-missing",
      );

      const preview = await r.act(bob, { operation: "route-preview", peer: alice.identity });
      if (!preview.ok) throw new Error(preview.error.code);
      expect(preview.value as PeerRoutePreview).toMatchObject({
        direction: "alice/main#1 -> bob/main#1",
        expectedRevision: 0,
        current: null,
        rights: ["discover", "send"],
        reply: "requires-reverse-grant",
      });
      expect(
        refusal(
          await r.act(bob, { operation: "route-grant", peer: alice.identity, expectedRevision: 1 }),
        ),
      ).toBe("stale:route-stale");
      const granted = await r.act(bob, {
        operation: "route-grant",
        peer: alice.identity,
        expectedRevision: 0,
      });
      if (!granted.ok) throw new Error(granted.error.code);
      expect(granted.value as PeerRouteView).toMatchObject({
        status: "active",
        revision: 1,
        direction: "alice/main#1 -> bob/main#1",
        senderScope: scopeFor("/work/tree-a"),
        recipientScope: scopeFor("/work/tree-b"),
      });

      expect(await discovered(r, alice)).toEqual(["bob"]);
      const delivered = await alice.send(toBob(alice, scopeFor("/work/tree-a")), noSignal);
      if (!delivered.ok) throw new Error(refusal(delivered));
      expect(delivered.value).toMatchObject({
        delivery: "accepted-for-persistence",
        policy: "allowed",
      });

      // A grant never lets the sender claim the recipient's scope.
      expect(refusal(await alice.send(toBob(alice, scopeFor("/work/tree-b")), noSignal))).toBe(
        "denied:scope-mismatch",
      );
      // Reply needs the reverse direction; unrelated worktrees stay isolated.
      expect(
        refusal(await bob.send(r.message(bob, alice, scopeFor("/work/tree-b")), noSignal)),
      ).toBe("denied:route-missing");
      expect(await discovered(r, bob)).toEqual([]);
      expect(refusal(await carol.send(toBob(carol, scopeFor("/work/clone-c")), noSignal))).toBe(
        "denied:route-missing",
      );
      expect(await discovered(r, carol)).toEqual([]);

      // The recipient's own refusal still applies to a granted sender.
      expect(refusal(await r.act(bob, { operation: "deny", peer: alice.identity }))).toBe("ok");
      expect(await discovered(r, alice)).toEqual([]);
      expect(refusal(await alice.send(toBob(alice, scopeFor("/work/tree-a")), noSignal))).toBe(
        "denied:",
      );
    } finally {
      await r.close();
    }
  });

  test("a model can inspect its routes but never preview, grant or revoke one", async () => {
    const r = await registry();
    try {
      const alice = await r.open("alice", scopeFor("/work/tree-a"));
      const bob = await r.open("bob", scopeFor("/work/tree-b"));
      expect(
        refusal(
          await r.act(
            bob,
            { operation: "route-grant", peer: alice.identity, expectedRevision: 0 },
            "model",
          ),
        ),
      ).toBe("denied:");
      // Preview would reveal unlisted endpoints in other worktrees, so it is a user control.
      expect(
        refusal(await r.act(bob, { operation: "route-preview", peer: alice.identity }, "model")),
      ).toBe("denied:");
      const routes = await r.act(bob, { operation: "routes" }, "model");
      expect(routes.ok && (routes.value as { items: unknown[] }).items).toEqual([]);
      expect(
        refusal(await alice.send(r.message(alice, bob, scopeFor("/work/tree-a")), noSignal)),
      ).toBe("denied:route-missing");
    } finally {
      await r.close();
    }
  });

  test("cross-scope artifacts are refused before acceptance, and nothing is copied", async () => {
    const r = await registry();
    try {
      const alice = await r.open("alice", scopeFor("/work/tree-a"));
      const bob = await r.open("bob", scopeFor("/work/tree-b"));
      await r.act(bob, { operation: "route-grant", peer: alice.identity, expectedRevision: 0 });
      const withArtifact = r.message(alice, bob, scopeFor("/work/tree-a"), {
        artifacts: [
          {
            artifactId: `artifact-${"a".repeat(32)}`,
            digest: `sha256:${"b".repeat(64)}`,
            bytes: 10,
          },
        ],
      });
      const refused = await alice.send(withArtifact, noSignal);
      expect(refused.ok).toBeFalse();
      const stored = r.store.read("SELECT count(*) AS count FROM peer_messages");
      expect(stored.ok && stored.value[0]?.count).toBe(0);
    } finally {
      await r.close();
    }
  });

  test("revocation denies pending delivery, wakes waiters and keeps admitted receipts", async () => {
    const r = await registry();
    try {
      const alice = await r.open("alice", scopeFor("/work/tree-a"));
      const bob = await r.open("bob", scopeFor("/work/tree-b"));
      await r.act(bob, { operation: "route-grant", peer: alice.identity, expectedRevision: 0 });
      const admitted = await alice.send(r.message(alice, bob, scopeFor("/work/tree-a")), noSignal);
      if (!admitted.ok) throw new Error(refusal(admitted));
      await bob.close();
      const pending = await alice.send(r.message(alice, bob, scopeFor("/work/tree-a")), noSignal);
      if (!pending.ok) throw new Error(refusal(pending));
      expect(pending.value).toMatchObject({ delivery: "unavailable", wait: "open" });
      let woke = 0;
      alice.subscribe(() => {
        woke += 1;
      });
      const before = woke;
      // The sender may withdraw a route it holds; narrowing needs no counterpart consent.
      const revoked = await r.act(alice, {
        operation: "route-revoke",
        peer: bob.identity,
        expectedRevision: 1,
      });
      expect(revoked.ok && (revoked.value as PeerRouteView).status).toBe("revoked");
      expect(woke).toBeGreaterThan(before);
      const pendingAfter = await r.act(alice, { operation: "inspect", key: pending.value.key });
      expect(
        pendingAfter.ok && (pendingAfter.value as { receipt: MailboxReceipt }).receipt,
      ).toMatchObject({ policy: "revoked", reason: "revoked", wait: "settled" });
      const admittedAfter = await r.act(alice, { operation: "inspect", key: admitted.value.key });
      expect(
        admittedAfter.ok && (admittedAfter.value as { receipt: MailboxReceipt }).receipt,
      ).toMatchObject({ policy: "allowed", delivery: "queued", reason: "offline" });
      expect(
        refusal(await alice.send(r.message(alice, bob, scopeFor("/work/tree-a")), noSignal)),
      ).toBe("denied:route-revoked");
    } finally {
      await r.close();
    }
  });

  test("trust change retires the route; restart revalidates; a fork never inherits it", async () => {
    const r = await registry();
    try {
      let alice = await r.open("alice", scopeFor("/work/tree-a"));
      const bob = await r.open("bob", scopeFor("/work/tree-b"));
      await r.act(bob, { operation: "route-grant", peer: alice.identity, expectedRevision: 0 });

      // Restart: a new process generation re-registers the same identity and scope.
      await alice.close();
      alice = await r.open("alice", scopeFor("/work/tree-a"));
      const afterRestart = await alice.send(
        r.message(alice, bob, scopeFor("/work/tree-a")),
        noSignal,
      );
      expect(afterRestart.ok && afterRestart.value.delivery).toBe("accepted-for-persistence");

      // A forked session has its own identity and no grant.
      const fork = await r.open("alice-fork", scopeFor("/work/tree-a"));
      expect(
        refusal(await fork.send(r.message(fork, bob, scopeFor("/work/tree-a")), noSignal)),
      ).toBe("denied:route-missing");

      // A trust change fails the endpoint's revalidation and retires it.
      r.authorized.set("alice", false);
      expect(
        refusal(await alice.send(r.message(alice, bob, scopeFor("/work/tree-a")), noSignal)),
      ).toBe("denied:");
      const routes = await r.act(bob, { operation: "routes" });
      expect(routes.ok && (routes.value as { items: PeerRouteView[] }).items).toMatchObject([
        { status: "invalid", reason: "route-endpoint-retired", revision: 1 },
      ]);
    } finally {
      await r.close();
    }
  });

  test("expired grants stop routing and inspection reports the same facts", async () => {
    const r = await registry();
    try {
      const alice = await r.open("alice", scopeFor("/work/tree-a"));
      const bob = await r.open("bob", scopeFor("/work/tree-b"));
      const granted = await r.act(bob, {
        operation: "route-grant",
        peer: alice.identity,
        expectedRevision: 0,
        expiresInMs: 20,
        rights: ["send"],
      });
      expect(granted.ok && (granted.value as PeerRouteView).rights).toEqual(["send"]);
      // Send without discover: the route carries text but does not list the recipient.
      expect(await discovered(r, alice)).toEqual([]);
      await Bun.sleep(40);
      expect(
        refusal(await alice.send(r.message(alice, bob, scopeFor("/work/tree-a")), noSignal)),
      ).toBe("denied:route-expired");
      const fromSender = await r.act(alice, { operation: "routes" });
      const fromRecipient = await r.act(bob, { operation: "routes" });
      // Both ends see the same grant facts; only the viewing endpoint differs.
      const items = (result: typeof fromSender) =>
        result.ok && (result.value as { items: PeerRouteView[] }).items;
      expect(items(fromSender)).toEqual(items(fromRecipient));
      expect(fromSender.ok && (fromSender.value as { items: PeerRouteView[] }).items).toMatchObject(
        [{ status: "expired", reason: "route-expired", direction: "alice/main#1 -> bob/main#1" }],
      );
    } finally {
      await r.close();
    }
  });

  test("with routes both ways, each end names the direction it withdraws", async () => {
    const r = await registry();
    try {
      const alice = await r.open("alice", scopeFor("/work/tree-a"));
      const bob = await r.open("bob", scopeFor("/work/tree-b"));
      await r.act(bob, { operation: "route-grant", peer: alice.identity, expectedRevision: 0 });
      await r.act(alice, { operation: "route-grant", peer: bob.identity, expectedRevision: 0 });
      expect(
        refusal(
          await r.act(alice, {
            operation: "route-revoke",
            peer: bob.identity,
            expectedRevision: 1,
          }),
        ),
      ).toBe("invalid:route-ambiguous");
      const withdrawn = await r.act(alice, {
        operation: "route-revoke",
        peer: bob.identity,
        expectedRevision: 1,
        direction: "outgoing",
      });
      expect(withdrawn.ok && (withdrawn.value as PeerRouteView).direction).toBe(
        "alice/main#1 -> bob/main#1",
      );
      expect(
        refusal(await alice.send(r.message(alice, bob, scopeFor("/work/tree-a")), noSignal)),
      ).toBe("denied:route-revoked");
      const reply = await bob.send(r.message(bob, alice, scopeFor("/work/tree-b")), noSignal);
      expect(reply.ok && reply.value.policy).toBe("allowed");
    } finally {
      await r.close();
    }
  });

  test("an endpoint outside this registry cannot be previewed or granted", async () => {
    const r = await registry();
    try {
      const bob = await r.open("bob", scopeFor("/work/tree-b"));
      const elsewhere = { sessionId: "separate-store", agentId: "main", generation: 1 };
      expect(refusal(await r.act(bob, { operation: "route-preview", peer: elsewhere }))).toBe(
        "unsupported:not-in-registry",
      );
      expect(
        refusal(
          await r.act(bob, { operation: "route-grant", peer: elsewhere, expectedRevision: 0 }),
        ),
      ).toBe("unsupported:not-in-registry");
      const same = await r.open("dave", scopeFor("/work/tree-b"));
      expect(refusal(await r.act(bob, { operation: "route-preview", peer: same.identity }))).toBe(
        "invalid:same-scope",
      );
    } finally {
      await r.close();
    }
  });
});
