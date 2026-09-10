import { afterEach, expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  messageKey,
  type PeerIdentity,
  type PeerMessage,
} from "../../domain/orchestration/peer-mailbox.ts";
import { type SqliteStorePort, SqliteWorkError } from "../../domain/storage/index.ts";
import { openProductStore, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createMailboxRepository } from "./mailbox-store.ts";

afterEach(removeTemporaryRoots);
for (const stage of [
  "propose",
  "admit",
  "delivered",
  "processing",
  "reply",
  "cancel",
  "subscribe",
  "retire",
  "expiry",
  "cleanup",
  "notification",
  "cursor",
] as const) {
  test(`a disk failure at each ${stage} transaction write preserves the last committed state`, async () => {
    const { store, repository, a, b } = await fixture();
    try {
      const message = request();
      const key = messageKey(message);
      if (stage !== "propose" && stage !== "admit")
        expect(repository.admit(b, message, now).ok).toBe(true);
      if (stage === "subscribe") expect(repository.renew(b, "busy", now).ok).toBe(true);
      const snapshot = () =>
        [
          "peer_messages",
          "peer_mailbox_events",
          "peer_subscriptions",
          "peer_notifications",
          "peer_endpoints",
          "peer_delivery_attempts",
          "peer_cursors",
        ].map((table) => store.read(`SELECT * FROM ${table}`));
      const before = snapshot();
      let verifiedRollback = false;
      let completed = false;
      for (let boundary = 1; boundary <= 20; boundary += 1) {
        let writes = 0;
        const faulty: SqliteStorePort = {
          ...store,
          write(work, signal) {
            return store.write(
              (sql) =>
                work({
                  ...sql,
                  run(statement, bindings) {
                    const result = sql.run(statement, bindings);
                    if (++writes === boundary)
                      throw new SqliteWorkError({
                        kind: "sqlite",
                        code: "disk-full",
                        operation: "transaction",
                        driverCode: "SQLITE_FULL",
                        detail: null,
                      });
                    return result;
                  },
                }),
              signal,
            );
          },
        };
        const repo = createMailboxRepository(faulty);
        const action = () => {
          switch (stage) {
            case "propose":
              return repo.propose(a, message, now);
            case "admit":
              return repo.admit(b, message, now);
            case "delivered":
            case "processing":
              return repo.acknowledge(
                b,
                { version: 1, key, recipient, processGeneration: b.processGeneration, kind: stage },
                now,
              );
            case "reply":
              return repo.admit(
                a,
                request({
                  id: "reply",
                  sender: recipient,
                  recipient: sender,
                  kind: "reply",
                  correlation: message.id,
                }),
                now,
              );
            case "cancel":
              return repo.localWait(a, key, "cancelled-locally", now);
            case "subscribe":
              return repo.subscribe(
                b,
                { id: "fault-watch", sender, recipient, predicate: "idle", deadline: now + 1000 },
                now,
              );
            case "retire":
              return repo.renew(b, "retired", now);
            case "expiry":
              return repo.inspect(a, key, now + 21_000);
            case "cleanup":
              return repo.cleanup(a, key, now + 21_000);
            case "notification":
              return repo.notifications(b, now);
            case "cursor":
              return repo.history(b, 0, 100, now);
          }
        };
        const result = action();
        if (result.ok) {
          completed = true;
          break;
        }
        expect(result.error.code).toBe("unavailable");
        expect(snapshot()).toEqual(before);
        verifiedRollback = true;
      }
      expect(verifiedRollback).toBe(true);
      expect(completed).toBe(true);
    } finally {
      await store.close();
    }
  });
}
const scope = {
  workspace: canonicalDigest("w"),
  project: canonicalDigest("p"),
  user: canonicalDigest("u"),
  environment: canonicalDigest("e"),
  trust: canonicalDigest("t"),
};
const identity = (name: string): PeerIdentity => ({
  sessionId: name,
  agentId: name,
  generation: 1,
});
const sender = identity("sender");
const recipient = identity("recipient");
const now = 1_000_000;
test("queue bounds, paging, notification deduplication and requester retirement preserve exact facts", async () => {
  const { store, repository, a, b } = await fixture();
  try {
    for (let i = 1; i <= 64; i += 1) {
      const message = request({ id: `bounded-${i}`, laneSequence: i });
      expect(repository.admit(b, message, now).ok).toBe(true);
      expect(
        repository.acknowledge(
          b,
          {
            version: 1,
            key: messageKey(message),
            recipient,
            processGeneration: b.processGeneration,
            kind: "processing",
          },
          now,
        ).ok,
      ).toBe(true);
    }
    expect(repository.admit(b, request({ id: "overflow", laneSequence: 65 }), now)).toEqual({
      ok: false,
      error: { code: "full" },
    });
    const page = repository.history(a, 0, 100, now);
    expect(page.ok && page.value.complete).toBe(false);
    if (!page.ok) throw new Error(page.error.code);
    expect(repository.cursor(a, now)).toEqual({ ok: true, value: page.value.cursor });
    const remainder = repository.history(a, page.value.cursor.after, 100, now);
    expect(remainder.ok && remainder.value.items).toHaveLength(28);
    expect(remainder.ok && remainder.value.complete).toBe(true);
    const notices = repository.notifications(b, now);
    expect(notices.ok && notices.value).toHaveLength(64);
    expect(createMailboxRepository(store).notifications(b, now)).toMatchObject({
      ok: true,
      value: [],
    });
    expect(
      repository.policy(b, sender, { mode: "allow", muted: false, perMinute: 1 }, now).ok,
    ).toBe(true);
    // Retiring the requester abandons its waits; it cannot fabricate a recipient refusal.
    expect(repository.renew(a, "retired", now).ok).toBe(true);
    const retained = repository.inspect(b, messageKey(request({ id: "bounded-1" })), now);
    expect(retained.ok && retained.value.receipt).toMatchObject({
      handling: "processing-acknowledged",
      wait: "cancelled-locally",
      policy: "revoked",
    });
  } finally {
    await store.close();
  }
});
test("recipient rate policy and live waiter capacity apply explicit backpressure", async () => {
  const { store, repository, a, b } = await fixture();
  try {
    expect(repository.policy(b, sender, { mode: "allow", muted: true, perMinute: 1 }, now).ok).toBe(
      true,
    );
    expect(repository.admit(b, request(), now).ok).toBe(true);
    expect(repository.admit(b, request({ id: "rate-overflow", laneSequence: 2 }), now)).toEqual({
      ok: false,
      error: { code: "rate-limited" },
    });
    expect(repository.notifications(b, now)).toEqual({ ok: true, value: [] });
    expect(repository.renew(b, "busy", now).ok).toBe(true);
    for (let i = 0; i < 64; i += 1)
      expect(
        repository.subscribe(
          b,
          { id: `watch-${i}`, sender, recipient, predicate: "idle", deadline: now + 1000 },
          now,
        ).ok,
      ).toBe(true);
    expect(
      repository.subscribe(
        b,
        { id: "watch-overflow", sender, recipient, predicate: "idle", deadline: now + 1000 },
        now,
      ),
    ).toEqual({ ok: false, error: { code: "full" } });
    expect(repository.cancelSubscription(a, "watch-0", now).ok).toBe(true);
    expect(
      repository.subscribe(
        b,
        { id: "watch-overflow", sender, recipient, predicate: "idle", deadline: now + 1000 },
        now,
      ).ok,
    ).toBe(true);
  } finally {
    await store.close();
  }
});
test("an offline proposal has three durable delivery attempts and never becomes accepted", async () => {
  const { store, repository, a, b } = await fixture();
  try {
    expect(repository.renew(b, "offline", now).ok).toBe(true);
    const message = request();
    expect(repository.propose(a, message, now).ok).toBe(true);
    const key = messageKey(message);
    for (let i = 1; i <= 3; i += 1) {
      expect(repository.deliveryAttempt(a, key, "started", now).ok).toBe(true);
      const failed = repository.deliveryAttempt(a, key, "unavailable", now);
      expect(failed.ok && failed.value.delivery).toBe(i === 3 ? "failed" : "unavailable");
    }
    expect(repository.deliveryAttempt(a, key, "started", now)).toMatchObject({
      ok: true,
      value: { delivery: "failed" },
    });
    expect(store.read("SELECT count(*) AS total FROM peer_delivery_attempts")).toMatchObject({
      ok: true,
      value: [{ total: 3 }],
    });
    expect(store.read("SELECT accepted FROM peer_messages")).toMatchObject({
      ok: true,
      value: [{ accepted: 0 }],
    });
  } finally {
    await store.close();
  }
});
test("availability registration atomically tests state and preserves one durable outcome", async () => {
  const { store, repository, a, b, register } = await fixture();
  const watch = {
    id: "watch-1",
    sender,
    recipient,
    predicate: "idle" as const,
    deadline: now + 10_000,
  };
  try {
    const alreadyIdle = repository.subscribe(b, watch, now);
    expect(alreadyIdle.ok && alreadyIdle.value).toMatchObject({ wait: "settled", reason: "idle" });
    expect(repository.renew(b, "busy", now).ok).toBe(true);
    expect(repository.subscribe(b, watch, now)).toEqual(alreadyIdle);
    expect(repository.subscribe(b, { ...watch, predicate: "terminal" }, now)).toEqual({
      ok: false,
      error: { code: "conflict" },
    });
    expect(repository.subscribe(b, { ...watch, id: "later" }, now).ok).toBe(true);
    expect(repository.renew(b, "offline", now).ok).toBe(true);
    const resumed = register(recipient, "resumed-process");
    const recovered = createMailboxRepository(store).subscription(a, sender, "later", now);
    expect(recovered.ok && recovered.value).toMatchObject({ wait: "settled", reason: "idle" });
    expect(repository.renew(resumed, "busy", now).ok).toBe(true);
    expect(repository.subscribe(resumed, { ...watch, id: "cancel" }, now).ok).toBe(true);
    const cancelled = repository.cancelSubscription(a, "cancel", now);
    expect(cancelled.ok && cancelled.value.wait).toBe("cancelled-locally");
    expect(repository.renew(resumed, "idle", now).ok).toBe(true);
    expect(repository.subscription(a, sender, "cancel", now)).toEqual(cancelled);
    expect(repository.renew(resumed, "busy", now).ok).toBe(true);
    expect(repository.subscribe(resumed, { ...watch, id: "expire" }, now).ok).toBe(true);
    const expired = repository.subscription(a, sender, "expire", watch.deadline);
    expect(expired.ok && expired.value).toMatchObject({ wait: "timed-out", reason: "expired" });
    expect(repository.subscribe(resumed, { ...watch, id: "revoke" }, now).ok).toBe(true);
    expect(
      repository.policy(resumed, sender, { mode: "refuse", muted: false, perMinute: 64 }, now).ok,
    ).toBe(true);
    const revoked = repository.subscription(a, sender, "revoke", now);
    expect(revoked.ok && revoked.value).toMatchObject({ wait: "settled", reason: "revoked" });
  } finally {
    await store.close();
  }
});
function request(overrides: Partial<PeerMessage> = {}): PeerMessage {
  return {
    version: 1,
    id: "request-1",
    sender,
    recipient,
    scope,
    laneSequence: 1,
    createdAt: now,
    expiresAt: now + 20_000,
    kind: "request",
    correlation: null,
    text: "Please inspect the result",
    artifacts: [],
    sensitivity: "internal",
    retention: "normal",
    provenance: { causalMessage: null, hops: 0, source: "peer-evidence", effectAuthority: false },
    ...overrides,
  };
}
async function fixture() {
  const root = await temporaryRoot("falryn-peer-store-");
  const opened = await openProductStore(root);
  if (!opened.ok) throw new Error(opened.error.code);
  const store = opened.value;
  const repository = createMailboxRepository(store);
  const register = (who: PeerIdentity, processGeneration = `${who.agentId}-process`) => {
    const lease = repository.register(
      {
        endpoint: {
          version: 1,
          identity: who,
          scope,
          label: "same name",
          state: "idle",
          processGeneration,
          leaseUntil: now + 30_000,
        },
        publicKey: "public-verifier",
        address: "host-private-address",
        fence: `${processGeneration}-${"x".repeat(40)}`,
      },
      now,
    );
    if (!lease.ok) throw new Error(lease.error.code);
    return lease.value;
  };
  const a = register(sender);
  const b = register(recipient);
  expect(repository.policy(b, sender, { mode: "allow", muted: false, perMinute: 64 }, now).ok).toBe(
    true,
  );
  expect(
    repository.policy(a, recipient, { mode: "allow", muted: false, perMinute: 64 }, now).ok,
  ).toBe(true);
  return { store, repository, a, b, register };
}
test("recipient commit owns acceptance, duplicate content is idempotent and conflicting content is audited", async () => {
  const { store, repository, a, b } = await fixture();
  try {
    const message = request();
    const proposed = repository.propose(a, message, now);
    expect(proposed.ok && proposed.value.delivery).toBe("proposed");
    expect(repository.admit(a, message, now)).toEqual({ ok: false, error: { code: "denied" } });
    const admitted = repository.admit(b, message, now);
    expect(admitted.ok && admitted.value.delivery).toBe("accepted-for-persistence");
    expect(repository.admit(b, message, now)).toEqual(admitted);
    expect(repository.admit(b, { ...message, text: "different" }, now)).toEqual({
      ok: false,
      error: { code: "conflict" },
    });
    const events = repository.history(a, 0, 100, now);
    expect(events.ok && events.value.items.map((item) => item.fact)).toEqual([
      "transition",
      "transition",
      "conflict",
    ]);
    expect(JSON.stringify(events)).not.toContain(message.text);
    expect(JSON.stringify(events)).not.toContain("host-private-address");
    expect(JSON.stringify(events)).not.toContain(a.fence);
  } finally {
    await store.close();
  }
});
test("local cancellation preserves an exact later reply and terminal handling seals once", async () => {
  const { store, repository, a, b } = await fixture();
  try {
    const message = request();
    expect(repository.admit(b, message, now).ok).toBe(true);
    expect(repository.localWait(a, messageKey(message), "cancelled-locally", now).ok).toBe(true);
    const reply = request({
      id: "reply-1",
      kind: "reply",
      sender: recipient,
      recipient: sender,
      correlation: message.id,
      text: "Done",
    });
    expect(repository.propose(b, reply, now).ok).toBe(true);
    expect(repository.admit(a, reply, now).ok).toBe(true);
    const result = repository.inspect(a, messageKey(message), now);
    expect(result.ok && result.value.receipt.handling).toBe("replied");
    expect(result.ok && result.value.receipt.wait).toBe("cancelled-locally");
    expect(result.ok && result.value.receipt.reply).toBe(messageKey(reply));
    expect(repository.admit(a, reply, now).ok).toBe(true);
    expect(repository.admit(a, { ...reply, id: "reply-2", laneSequence: 2 }, now)).toEqual({
      ok: false,
      error: { code: "conflict" },
    });
  } finally {
    await store.close();
  }
});
test("fresh process authentication fences the old writer without forwarding the addressed generation", async () => {
  const { store, repository, a, b, register } = await fixture();
  try {
    expect(repository.admit(b, request(), now).ok).toBe(true);
    expect(repository.renew(b, "offline", now).ok).toBe(true);
    const resumed = register(recipient, "new-process");
    expect(repository.inspect(b, messageKey(request()), now)).toEqual({
      ok: false,
      error: { code: "denied" },
    });
    expect(repository.inspect(resumed, messageKey(request()), now).ok).toBe(true);
    expect(repository.renew(resumed, "retired", now).ok).toBe(true);
    const retained = repository.inspect(a, messageKey(request()), now);
    expect(retained.ok && retained.value.receipt.handling).toBe("refused");
    expect(repository.admit(resumed, request(), now).ok).toBe(false);
  } finally {
    await store.close();
  }
});
test("hold hides model-visible content until explicit policy release; expiry precedes payload cleanup", async () => {
  const { store, repository, a, b } = await fixture();
  try {
    expect(
      repository.policy(b, sender, { mode: "hold", muted: false, perMinute: 64 }, now).ok,
    ).toBe(true);
    const message = request();
    expect(repository.admit(b, message, now).ok).toBe(true);
    const held = repository.inspect(b, messageKey(message), now);
    expect(held.ok && held.value.message).toBeNull();
    expect(repository.release(b, messageKey(message), now).ok).toBe(false);
    expect(
      repository.policy(b, sender, { mode: "allow", muted: false, perMinute: 64 }, now).ok,
    ).toBe(true);
    expect(repository.release(b, messageKey(message), now).ok).toBe(true);
    expect(repository.cleanup(a, messageKey(message), now).ok).toBe(false);
    const cleaned = repository.cleanup(a, messageKey(message), now + 21_000);
    expect(cleaned.ok && cleaned.value.delivery).toBe("expired");
    expect(cleaned.ok && cleaned.value.tombstoned).toBe(true);
    const payload = repository.inspect(a, messageKey(message), now + 21_000);
    expect(payload.ok && payload.value.message).toBeNull();
    expect(repository.admit(b, message, now + 21_000)).toEqual(cleaned);
  } finally {
    await store.close();
  }
});
