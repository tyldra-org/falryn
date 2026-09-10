/** Recipient admission, receipts and metadata-only replay share one fenced SQLite writer. */
import { createHash, timingSafeEqual } from "node:crypto";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import {
  MAILBOX_LIMITS,
  type MailboxReceipt,
  type MailboxRecord,
  type MailboxRepository,
  mailboxReceiptSchema,
  messageKey,
  type PeerEndpoint,
  type PeerIdentity,
  type PeerLease,
  type PeerMessage,
  type PeerResult,
  type PeerSubscription,
  type PeerSubscriptionInput,
  peerEndpointSchema,
  peerKey,
  peerMessageSchema,
  peerSubscriptionSchema,
  samePeer,
  samePeerScope,
} from "../../domain/orchestration/peer-mailbox.ts";
import type { SqliteStatements, SqliteStorePort } from "../../domain/storage/index.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const authorized = (proof: string, expected: unknown) =>
  typeof expected === "string" &&
  /^[a-f0-9]{64}$/u.test(expected) &&
  proof.length >= 32 &&
  proof.length <= 128 &&
  timingSafeEqual(Buffer.from(hash(proof), "hex"), Buffer.from(expected, "hex"));

export function createMailboxRepository(store: SqliteStorePort): MailboxRepository {
  const subscriptionKey = (sender: PeerIdentity, id: string) => canonicalDigest([sender, id]);
  function putSubscription(sql: SqliteStatements, record: PeerSubscription) {
    const checked = peerSubscriptionSchema.parse(record);
    sql.run(
      "INSERT INTO peer_subscriptions(id,sender,recipient,deadline,state,record) VALUES($id,$sender,$recipient,$deadline,$state,$record) ON CONFLICT(id) DO UPDATE SET state=excluded.state,record=excluded.record",
      {
        id: subscriptionKey(record.sender, record.id),
        sender: peerKey(record.sender),
        recipient: peerKey(record.recipient),
        deadline: record.deadline,
        state: record.wait,
        record: JSON.stringify(checked),
      },
    );
  }
  function settleSubscriptions(sql: SqliteStatements, now: number) {
    for (const row of sql.all(
      "SELECT record FROM peer_subscriptions WHERE state='open' LIMIT $limit",
      { limit: MAILBOX_LIMITS.waiters },
    )) {
      const current = peerSubscriptionSchema.parse(JSON.parse(String(row.record)));
      const recipient = endpoint(sql, current.recipient);
      const sender = endpoint(sql, current.sender);
      if (
        !recipient.ok ||
        !sender.ok ||
        !recipient.value.current ||
        !sender.value.current ||
        recipient.value.endpoint.state === "retired" ||
        sender.value.endpoint.state === "retired" ||
        !allowed(sql, current.sender, current.recipient) ||
        allowed(sql, current.sender, current.recipient)?.mode === "refuse"
      ) {
        putSubscription(sql, { ...current, wait: "settled", reason: "revoked" });
      } else if (current.deadline <= now) {
        putSubscription(sql, { ...current, wait: "timed-out", reason: "expired" });
      } else if (
        recipient.value.endpoint.state === "terminal" ||
        (recipient.value.endpoint.state === current.predicate &&
          recipient.value.endpoint.leaseUntil > now)
      ) {
        putSubscription(sql, {
          ...current,
          wait: "settled",
          reason: recipient.value.endpoint.state === "terminal" ? "terminal" : current.predicate,
          observation: recipient.value.endpoint,
        });
      }
    }
  }
  function getSubscription(
    sql: SqliteStatements,
    sender: PeerIdentity,
    id: string,
  ): PeerResult<PeerSubscription> {
    const row = sql.all("SELECT record FROM peer_subscriptions WHERE id=$id", {
      id: subscriptionKey(sender, id),
    })[0];
    if (!row) return err({ code: "not-found" });
    const record = peerSubscriptionSchema.safeParse(JSON.parse(String(row.record)));
    return record.success && samePeer(sender, record.data.sender) && record.data.id === id
      ? ok(record.data)
      : err({ code: "corrupt" });
  }
  function write<T>(work: (sql: SqliteStatements) => PeerResult<T>): PeerResult<T> {
    const result = store.write(work);
    return result.ok
      ? result.value.value
      : err({ code: result.error.effect === "uncertain" ? "uncertain" : "unavailable" });
  }
  function endpoint(sql: SqliteStatements, identity: PeerIdentity) {
    const row = sql.all("SELECT * FROM peer_endpoints WHERE id=$id", { id: peerKey(identity) })[0];
    if (!row) return err({ code: "not-found" as const });
    const parsed = peerEndpointSchema.safeParse(JSON.parse(String(row.record)));
    if (
      !parsed.success ||
      peerKey(parsed.data.identity) !== row.id ||
      parsed.data.state !== row.state ||
      parsed.data.processGeneration !== row.process_generation ||
      parsed.data.leaseUntil !== row.lease_until
    )
      return err({ code: "corrupt" as const });
    return ok({
      endpoint: parsed.data,
      publicKey: String(row.public_key),
      address: String(row.address),
      fenceHash: row.fence_hash,
      current: !sql.all(
        "SELECT 1 FROM peer_endpoints WHERE session=$session AND agent=$agent AND generation>$generation LIMIT 1",
        { session: identity.sessionId, agent: identity.agentId, generation: identity.generation },
      )[0],
    });
  }
  function owner(
    sql: SqliteStatements,
    lease: PeerLease,
    now: number,
    offline = false,
  ): PeerResult<PeerEndpoint> {
    const found = endpoint(sql, lease.identity);
    if (!found.ok) return found;
    if (!authorized(lease.fence, found.value.fenceHash)) return err({ code: "denied" });
    const current = found.value.endpoint;
    const replaced = sql.all(
      "SELECT 1 FROM peer_endpoints WHERE session=$session AND agent=$agent AND generation>$generation LIMIT 1",
      {
        session: lease.identity.sessionId,
        agent: lease.identity.agentId,
        generation: lease.identity.generation,
      },
    )[0];
    if (
      current.processGeneration !== lease.processGeneration ||
      replaced !== undefined ||
      current.state === "retired" ||
      (!offline && (current.leaseUntil <= now || current.state === "offline"))
    )
      return err({ code: "stale" });
    return ok(current);
  }
  function load(sql: SqliteStatements, key: string): PeerResult<MailboxRecord> {
    const row = sql.all("SELECT * FROM peer_messages WHERE id=$id", { id: key })[0];
    if (!row) return err({ code: "not-found" });
    const receipt = mailboxReceiptSchema.safeParse(JSON.parse(String(row.receipt)));
    if (!receipt.success || receipt.data.key !== key || receipt.data.digest !== row.digest)
      return err({ code: "corrupt" });
    let message: PeerMessage | null = null;
    if (row.payload !== null) {
      const parsed = peerMessageSchema.safeParse(JSON.parse(String(row.payload)));
      if (
        !parsed.success ||
        messageKey(parsed.data) !== key ||
        canonicalDigest(parsed.data) !== row.digest
      )
        return err({ code: "corrupt" });
      message = parsed.data;
    }
    return ok({ receipt: receipt.data, message });
  }
  function save(
    sql: SqliteStatements,
    receipt: MailboxReceipt,
    fact: "transition" | "conflict" = "transition",
  ): MailboxReceipt {
    const checked = mailboxReceiptSchema.parse(receipt);
    const json = JSON.stringify(checked);
    sql.run("UPDATE peer_messages SET receipt=$receipt WHERE id=$id", {
      id: checked.key,
      receipt: json,
    });
    sql.run(
      "INSERT INTO peer_mailbox_events(id,revision,fact,receipt) VALUES($id,$revision,$fact,$receipt)",
      {
        id: checked.key,
        revision: checked.revision,
        fact,
        receipt: json,
      },
    );
    if (fact === "transition") {
      if (
        ["accepted-for-persistence", "queued", "delivered-to-endpoint"].includes(
          checked.delivery,
        ) &&
        checked.policy === "allowed"
      )
        sql.run(
          "INSERT OR IGNORE INTO peer_notifications(id,endpoint,kind) VALUES($id,$endpoint,'arrival')",
          { id: checked.key, endpoint: peerKey(checked.recipient) },
        );
      if (
        checked.handling === "replied" ||
        checked.handling === "refused" ||
        checked.delivery === "expired"
      )
        sql.run(
          "INSERT OR IGNORE INTO peer_notifications(id,endpoint,kind) VALUES($id,$endpoint,'settlement')",
          { id: checked.key, endpoint: peerKey(checked.sender) },
        );
    }
    return checked;
  }
  function change(
    sql: SqliteStatements,
    receipt: MailboxReceipt,
    patch: Partial<MailboxReceipt>,
    fact: "transition" | "conflict" = "transition",
  ): PeerResult<MailboxReceipt> {
    const terminal = patch.handling === "refused" || patch.handling === "replied";
    const ceiling = patch.tombstoned
      ? MAILBOX_LIMITS.revisions
      : terminal
        ? MAILBOX_LIMITS.revisions - 2
        : MAILBOX_LIMITS.revisions - 3;
    if (receipt.revision >= ceiling) return err({ code: "full" });
    return ok(save(sql, { ...receipt, ...patch, revision: receipt.revision + 1 }, fact));
  }
  function conflict(sql: SqliteStatements, receipt: MailboxReceipt): PeerResult<never> {
    // Bound hostile retries while reserving room for settlement, expiry and cleanup.
    if (receipt.revision < MAILBOX_LIMITS.revisions - 5) change(sql, receipt, {}, "conflict");
    return err({ code: "conflict" });
  }
  function expire(sql: SqliteStatements, record: MailboxRecord, now: number): MailboxRecord {
    if (
      now < record.receipt.expiresAt ||
      record.receipt.tombstoned ||
      record.receipt.delivery === "expired"
    )
      return record;
    const receipt = save(sql, {
      ...record.receipt,
      revision: record.receipt.revision + 1,
      delivery: "expired",
      reason: "expired",
      wait: record.receipt.wait === "open" ? "settled" : record.receipt.wait,
    });
    // Policy holds retain evidence. All other payloads are reclaimed only after the expiry fact commits.
    return { ...record, receipt };
  }
  function access(
    sql: SqliteStatements,
    lease: PeerLease,
    key: string,
    now: number,
    subject: PeerIdentity = lease.identity,
  ): PeerResult<MailboxRecord> {
    const current = reader(sql, lease, subject, now);
    if (!current.ok) return current;
    const record = load(sql, key);
    if (!record.ok) return record;
    if (
      !samePeer(record.value.receipt.sender, subject) &&
      !samePeer(record.value.receipt.recipient, subject)
    )
      return err({ code: "denied" });
    return ok(expire(sql, record.value, now));
  }
  function reader(sql: SqliteStatements, lease: PeerLease, subject: PeerIdentity, now: number) {
    const current = owner(sql, lease, now);
    if (!current.ok || samePeer(lease.identity, subject)) return current;
    if (lease.identity.agentId !== "main" || subject.sessionId !== lease.identity.sessionId)
      return err({ code: "denied" as const });
    const target = endpoint(sql, subject);
    if (!target.ok) return target;
    return samePeerScope(target.value.endpoint.scope, current.value.scope)
      ? ok(target.value.endpoint)
      : err({ code: "denied" as const });
  }
  function allowed(sql: SqliteStatements, sender: PeerIdentity, recipient: PeerIdentity) {
    return sql.all(
      "SELECT mode,muted,per_minute FROM peer_policies WHERE sender=$sender AND recipient=$recipient",
      {
        sender: peerKey(sender),
        recipient: peerKey(recipient),
      },
    )[0];
  }
  function persist(
    sql: SqliteStatements,
    lease: PeerLease,
    raw: PeerMessage,
    now: number,
    receiving: boolean,
  ): PeerResult<MailboxReceipt> {
    const parsed = peerMessageSchema.safeParse(raw);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(raw)) > MAILBOX_LIMITS.envelopeBytes)
      return err({ code: "invalid" });
    const message = parsed.data;
    const current = owner(sql, lease, now);
    if (!current.ok) return current;
    if (!samePeer(lease.identity, receiving ? message.recipient : message.sender))
      return err({ code: "denied" });
    const sender = endpoint(sql, message.sender);
    const recipient = endpoint(sql, message.recipient);
    if (!sender.ok || !recipient.ok) return err({ code: "unavailable" });
    if (!sender.value.current || !recipient.value.current) return err({ code: "stale" });
    if (
      !samePeerScope(sender.value.endpoint.scope, message.scope) ||
      !samePeerScope(recipient.value.endpoint.scope, message.scope)
    )
      return err({ code: "denied" });
    if (
      [sender.value.endpoint, recipient.value.endpoint].some(
        (item) => item.state === "retired" || item.state === "terminal",
      )
    )
      return err({ code: "stale" });
    const key = messageKey(message);
    const existing = load(sql, key);
    if (existing.ok) {
      if (existing.value.receipt.digest !== canonicalDigest(message)) {
        return conflict(sql, existing.value.receipt);
      }
      if (!receiving || !["proposed", "unavailable"].includes(existing.value.receipt.delivery))
        return ok(expire(sql, existing.value, now).receipt);
    } else if (existing.error.code !== "not-found") return existing;
    if (message.expiresAt <= now) return err({ code: "expired" });
    if (message.createdAt > now + 5_000) return err({ code: "invalid" });
    // Recheck the selected handles in the admission transaction, after asynchronous integrity verification.
    for (const artifact of message.artifacts) {
      if (
        !sql.all(
          "SELECT 1 FROM artifacts WHERE artifact_id=$id AND digest=$digest AND byte_length=$bytes AND availability='available' AND NOT EXISTS(SELECT 1 FROM artifact_gc_claims WHERE digest=$digest) LIMIT 1",
          { id: artifact.artifactId, digest: artifact.digest, bytes: artifact.bytes },
        )[0]
      )
        return err({ code: "denied" });
    }
    const policy = allowed(sql, message.sender, message.recipient);
    if (!policy || policy.mode === "refuse") return err({ code: "denied" });
    if (
      receiving &&
      (sender.value.endpoint.leaseUntil <= now || sender.value.endpoint.state === "offline")
    )
      return err({ code: "stale" });
    const parameters = {
      recipient: peerKey(message.recipient),
      sender: peerKey(message.sender),
      now,
    };
    const counts = sql.all(
      "SELECT count(*) AS items,coalesce(sum(bytes),0) AS bytes FROM peer_messages WHERE recipient=$recipient AND expires_at>$now AND json_extract(receipt,'$.tombstoned')=0 AND json_extract(receipt,'$.handling') NOT IN ('replied','refused')",
      parameters,
    )[0];
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (
      !existing.ok &&
      (Number(counts?.items) >= MAILBOX_LIMITS.pending ||
        Number(counts?.bytes) + bytes > MAILBOX_LIMITS.queuedBytes)
    )
      return err({ code: "full" });
    if (!existing.ok) {
      const history = sql.all(
        "SELECT coalesce(sum($lineage+coalesce(length(CAST(payload AS BLOB)),0)),0) AS total FROM peer_messages WHERE recipient=$recipient OR sender=$sender",
        { ...parameters, lineage: MAILBOX_LIMITS.lineageBytes },
      )[0];
      // Reserve the complete bounded receipt lineage before accepting new payloads.
      // Expired payload cleanup frees bytes; retained digest tombstones prevent replay resurrection.
      if (
        Number(history?.total) + bytes + MAILBOX_LIMITS.lineageBytes >
        MAILBOX_LIMITS.retainedBytes
      )
        return err({ code: "full" });
      const rate = sql.all(
        "SELECT count(*) AS total,count(DISTINCT recipient) AS peers FROM peer_messages WHERE sender=$sender AND created_at>$since",
        { sender: parameters.sender, since: now - 60_000 },
      )[0];
      if (Number(rate?.total) >= Math.min(MAILBOX_LIMITS.sendsPerMinute, Number(policy.per_minute)))
        return err({ code: "rate-limited" });
      if (
        Number(rate?.peers) >= MAILBOX_LIMITS.fanOut &&
        !sql.all(
          "SELECT 1 FROM peer_messages WHERE sender=$sender AND recipient=$recipient AND created_at>$since LIMIT 1",
          { ...parameters, since: now - 60_000 },
        )[0]
      )
        return err({ code: "full" });
      const lane = sql.all(
        "SELECT max(lane_sequence) AS latest FROM peer_messages WHERE sender=$sender AND recipient=$recipient",
        parameters,
      )[0];
      if (message.laneSequence <= Number(lane?.latest ?? 0)) return err({ code: "stale" });
    }
    let original: MailboxRecord | null = null;
    if (message.kind === "reply") {
      const prior = sql.all(
        "SELECT id FROM peer_messages WHERE sender=$recipient AND recipient=$sender AND message_id=$correlation",
        { ...parameters, correlation: message.correlation },
      )[0];
      const request = prior ? load(sql, String(prior.id)) : null;
      if (
        !request?.ok ||
        request.value.message?.kind !== "request" ||
        request.value.receipt.policy !== "allowed" ||
        request.value.receipt.expiresAt < message.expiresAt ||
        request.value.receipt.handling === "replied" ||
        request.value.receipt.handling === "refused"
      )
        return request?.ok ? conflict(sql, request.value.receipt) : err({ code: "conflict" });
      original = request.value;
    }
    const receipt: MailboxReceipt = existing.ok
      ? {
          ...existing.value.receipt,
          revision: existing.value.receipt.revision + 1,
          delivery: "accepted-for-persistence",
          policy: policy.mode === "hold" ? "held" : "allowed",
          reason: policy.mode === "hold" ? "held" : "none",
        }
      : {
          version: 1,
          key,
          messageId: message.id,
          sender: message.sender,
          recipient: message.recipient,
          scope: message.scope,
          createdAt: message.createdAt,
          digest: canonicalDigest(message),
          correlation: message.correlation,
          expiresAt: message.expiresAt,
          revision: 1,
          delivery: receiving ? "accepted-for-persistence" : "proposed",
          handling: "unacknowledged",
          wait: "open",
          policy: policy.mode === "hold" ? "held" : "allowed",
          reason: policy.mode === "hold" ? "held" : "none",
          reply: null,
          tombstoned: false,
          effectAuthority: false,
        };
    if (!existing.ok)
      sql.run(
        "INSERT INTO peer_messages(id,sender,recipient,message_id,lane_sequence,digest,created_at,expires_at,accepted,bytes,payload,receipt) VALUES($id,$sender,$recipient,$messageId,$lane,$digest,$created,$expiry,$accepted,$bytes,$payload,$receipt)",
        {
          id: key,
          sender: parameters.sender,
          recipient: parameters.recipient,
          messageId: message.id,
          lane: message.laneSequence,
          digest: receipt.digest,
          created: now,
          expiry: message.expiresAt,
          accepted: Number(receiving),
          bytes,
          payload: JSON.stringify(message),
          receipt: JSON.stringify(receipt),
        },
      );
    else sql.run("UPDATE peer_messages SET accepted=1 WHERE id=$id", { id: key });
    save(sql, receipt);
    if (receiving)
      sql.run(
        "UPDATE peer_delivery_attempts SET outcome='accepted',finished_at=$now WHERE id=$id AND outcome='started'",
        { id: key, now },
      );
    if (receiving && original) {
      const settled = change(sql, original.receipt, {
        handling: "replied",
        reply: key,
        wait: original.receipt.wait === "open" ? "settled" : original.receipt.wait,
      });
      if (!settled.ok) throw new Error("peer reply settlement failed");
    }
    return ok(receipt);
  }
  return {
    cursor(lease, now, subject = lease.identity) {
      return write((sql) => {
        const current = reader(sql, lease, subject, now);
        if (!current.ok) return current;
        const row = sql.all("SELECT after FROM peer_cursors WHERE endpoint=$endpoint", {
          endpoint: peerKey(subject),
        })[0];
        return ok({ version: 1, endpoint: subject, after: Number(row?.after ?? 0) });
      });
    },
    notifications(lease, now) {
      return write((sql) => {
        const current = owner(sql, lease, now);
        if (!current.ok) return current;
        const notices = [];
        for (const row of sql.all(
          "SELECT n.id,n.kind FROM peer_notifications n JOIN peer_messages m ON m.id=n.id LEFT JOIN peer_policies p ON p.sender=m.sender AND p.recipient=m.recipient WHERE n.endpoint=$endpoint AND n.consumed=0 AND coalesce(p.muted,1)=0 ORDER BY m.sequence LIMIT $limit",
          { endpoint: peerKey(lease.identity), limit: MAILBOX_LIMITS.pending },
        )) {
          const loaded = load(sql, String(row.id));
          if (!loaded.ok) return loaded;
          if (row.kind === "arrival" && loaded.value.receipt.policy !== "allowed") continue;
          sql.run(
            "UPDATE peer_notifications SET consumed=1 WHERE id=$id AND endpoint=$endpoint AND kind=$kind",
            { id: String(row.id), endpoint: peerKey(lease.identity), kind: String(row.kind) },
          );
          notices.push({
            key: String(row.id),
            reason: row.kind === "arrival" ? ("arrival" as const) : ("settlement" as const),
            receipt: loaded.value.receipt,
          });
        }
        return ok(notices);
      });
    },
    deliveryAttempt(lease, key, phase, now) {
      return write((sql) => {
        const loaded = access(sql, lease, key, now);
        if (!loaded.ok) return loaded;
        const receipt = loaded.value.receipt;
        if (!samePeer(receipt.sender, lease.identity)) return err({ code: "denied" });
        if (!["proposed", "unavailable"].includes(receipt.delivery)) return ok(receipt);
        const previous = sql.all(
          "SELECT * FROM peer_delivery_attempts WHERE id=$id ORDER BY attempt DESC LIMIT 1",
          { id: key },
        )[0];
        const attempt = Number(previous?.attempt ?? 0);
        if (phase === "started") {
          if (
            previous?.outcome === "started" &&
            Number(previous.started_at) + MAILBOX_LIMITS.admissionMs > now
          )
            return err({ code: "conflict" });
          if (attempt >= MAILBOX_LIMITS.attempts)
            return change(sql, receipt, {
              delivery: "failed",
              reason: "transport-unavailable",
              wait: receipt.wait === "open" ? "settled" : receipt.wait,
            });
          if (previous?.outcome === "started")
            sql.run(
              "UPDATE peer_delivery_attempts SET outcome='unavailable',finished_at=$now WHERE id=$id AND attempt=$attempt",
              { id: key, attempt, now },
            );
          sql.run(
            "INSERT INTO peer_delivery_attempts(id,attempt,started_at,outcome) VALUES($id,$attempt,$now,'started')",
            { id: key, attempt: attempt + 1, now },
          );
          return ok(receipt);
        }
        if (previous?.outcome !== "started") return ok(receipt);
        sql.run(
          "UPDATE peer_delivery_attempts SET outcome='unavailable',finished_at=$now WHERE id=$id AND attempt=$attempt",
          { id: key, attempt, now },
        );
        return change(sql, receipt, {
          delivery: attempt >= MAILBOX_LIMITS.attempts ? "failed" : "unavailable",
          reason: "transport-unavailable",
          ...(attempt >= MAILBOX_LIMITS.attempts && receipt.wait === "open"
            ? { wait: "settled" as const }
            : {}),
        });
      });
    },
    subscribe(lease, input, now) {
      const parsed = peerSubscriptionSchema.safeParse({
        version: 1,
        ...input,
        wait: "open",
        reason: null,
        observation: null,
      });
      if (!parsed.success) return err({ code: "invalid" });
      return write((sql) => {
        const caller = owner(sql, lease, now);
        if (!caller.ok) return caller;
        const recipient = endpoint(sql, input.recipient);
        if (!recipient.ok || !recipient.value.current) return err({ code: "stale" });
        if (
          !samePeer(input.recipient, lease.identity) &&
          !(samePeer(input.sender, lease.identity) && recipient.value.endpoint.state === "terminal")
        )
          return err({ code: "denied" });
        const sender = endpoint(sql, input.sender);
        if (
          !sender.ok ||
          !sender.value.current ||
          !samePeerScope(sender.value.endpoint.scope, recipient.value.endpoint.scope) ||
          !samePeerScope(caller.value.scope, recipient.value.endpoint.scope) ||
          sender.value.endpoint.leaseUntil <= now
        )
          return err({ code: "denied" });
        const policy = allowed(sql, input.sender, input.recipient);
        if (!policy || policy.mode === "refuse") return err({ code: "denied" });
        const previous = getSubscription(sql, input.sender, input.id);
        if (previous.ok) {
          const prior: PeerSubscriptionInput = {
            id: previous.value.id,
            sender: previous.value.sender,
            recipient: previous.value.recipient,
            predicate: previous.value.predicate,
            deadline: previous.value.deadline,
          };
          if (canonicalDigest(prior) !== canonicalDigest(input)) return err({ code: "conflict" });
        } else {
          if (previous.error.code !== "not-found") return previous;
          if (input.deadline <= now || input.deadline > now + MAILBOX_LIMITS.admissionMs)
            return err({ code: "expired" });
          settleSubscriptions(sql, now);
          if (
            Number(
              sql.all(
                "SELECT coalesce(sum(length(CAST(record AS BLOB))),0) AS bytes FROM peer_subscriptions",
              )[0]?.bytes,
            ) +
              4_096 >
            MAILBOX_LIMITS.retainedBytes
          )
            return err({ code: "full" });
          if (
            Number(
              sql.all("SELECT count(*) AS count FROM peer_subscriptions WHERE state='open'")[0]
                ?.count,
            ) >= MAILBOX_LIMITS.waiters
          )
            return err({ code: "full" });
          putSubscription(sql, parsed.data);
        }
        settleSubscriptions(sql, now);
        return getSubscription(sql, input.sender, input.id);
      });
    },
    subscription(lease, sender, id, now) {
      return write((sql) => {
        const current = owner(sql, lease, now);
        if (!current.ok) return current;
        const prior = getSubscription(sql, sender, id);
        if (!prior.ok) return prior;
        if (
          !samePeer(lease.identity, prior.value.sender) &&
          !samePeer(lease.identity, prior.value.recipient)
        )
          return err({ code: "denied" });
        settleSubscriptions(sql, now);
        return getSubscription(sql, sender, id);
      });
    },
    cancelSubscription(lease, id, now) {
      return write((sql) => {
        const current = owner(sql, lease, now);
        if (!current.ok) return current;
        const prior = getSubscription(sql, lease.identity, id);
        if (!prior.ok) return prior;
        settleSubscriptions(sql, now);
        const record = getSubscription(sql, lease.identity, id);
        if (!record.ok) return record;
        if (record.value.wait !== "open") return record;
        const cancelled: PeerSubscription = {
          ...record.value,
          wait: "cancelled-locally",
          reason: "cancelled-locally",
        };
        putSubscription(sql, cancelled);
        return ok(cancelled);
      });
    },
    ownsArtifact(sender, artifactId) {
      return write((sql) =>
        ok(
          sql.all(
            "SELECT 1 FROM artifacts a JOIN invocations i USING(invocation_id) JOIN turns t USING(turn_id) WHERE a.artifact_id=$artifact AND t.session_id=$session AND ($main=1 OR EXISTS(SELECT 1 FROM agent_children c WHERE c.task_id=$agent AND c.generation=$generation AND json_extract(c.record,'$.rootSessionId')=$root)) LIMIT 1",
            {
              artifact: artifactId,
              session:
                sender.agentId === "main"
                  ? sender.sessionId
                  : `${sender.agentId}-${sender.generation}`,
              main: Number(sender.agentId === "main"),
              agent: sender.agentId,
              generation: sender.generation,
              root: sender.sessionId,
            },
          ).length === 1,
        ),
      );
    },
    authorize(lease, sender, now) {
      return write((sql) => {
        const recipient = owner(sql, lease, now);
        if (!recipient.ok) return recipient;
        const remote = endpoint(sql, sender);
        if (!remote.ok) return remote;
        if (
          !remote.value.current ||
          remote.value.endpoint.state === "retired" ||
          remote.value.endpoint.state === "terminal" ||
          remote.value.endpoint.leaseUntil <= now ||
          !samePeerScope(remote.value.endpoint.scope, recipient.value.scope)
        )
          return err({ code: "stale" });
        const policy = allowed(sql, sender, lease.identity);
        return policy && policy.mode !== "refuse" ? ok(undefined) : err({ code: "denied" });
      });
    },
    register(registration, now) {
      const parsed = peerEndpointSchema.safeParse(registration.endpoint);
      if (
        !parsed.success ||
        registration.publicKey.length > 256 ||
        registration.address.length > 256 ||
        registration.fence.length < 32
      )
        return err({ code: "invalid" });
      return write((sql) => {
        const value = parsed.data;
        const id = peerKey(value.identity);
        const prior = endpoint(sql, value.identity);
        if (
          prior.ok &&
          (prior.value.endpoint.state === "retired" ||
            prior.value.endpoint.state === "terminal" ||
            (prior.value.endpoint.state !== "offline" && prior.value.endpoint.leaseUntil > now))
        )
          return err({ code: "stale" });
        if (!prior.ok && prior.error.code !== "not-found") return prior;
        const newer = sql.all(
          "SELECT 1 FROM peer_endpoints WHERE session=$session AND agent=$agent AND generation>$generation LIMIT 1",
          {
            session: value.identity.sessionId,
            agent: value.identity.agentId,
            generation: value.identity.generation,
          },
        )[0];
        if (newer) return err({ code: "stale" });
        if (
          !prior.ok &&
          Number(
            sql.all(
              "SELECT count(*) AS total FROM peer_endpoints WHERE lease_until>$now AND state IN ('idle','busy')",
              { now },
            )[0]?.total,
          ) >= MAILBOX_LIMITS.peers
        )
          return err({ code: "full" });
        if (
          !prior.ok &&
          Number(
            sql.all(
              "SELECT coalesce(sum(length(CAST(record AS BLOB))+length(public_key)+length(address)+length(fence_hash)),0) AS total FROM peer_endpoints",
            )[0]?.total,
          ) +
            8_192 >
            MAILBOX_LIMITS.registryBytes
        )
          return err({ code: "full" });
        if (prior.ok && !samePeerScope(prior.value.endpoint.scope, value.scope))
          return err({ code: "denied" });
        const current = { ...value, leaseUntil: now + MAILBOX_LIMITS.leaseMs };
        sql.run(
          "INSERT INTO peer_endpoints(id,session,agent,generation,process_generation,fence_hash,public_key,address,lease_until,state,record) VALUES($id,$session,$agent,$generation,$process,$fence,$publicKey,$address,$lease,$state,$record) ON CONFLICT(id) DO UPDATE SET process_generation=excluded.process_generation,fence_hash=excluded.fence_hash,public_key=excluded.public_key,address=excluded.address,lease_until=excluded.lease_until,state=excluded.state,record=excluded.record",
          {
            id,
            session: value.identity.sessionId,
            agent: value.identity.agentId,
            generation: value.identity.generation,
            process: value.processGeneration,
            fence: hash(registration.fence),
            publicKey: registration.publicKey,
            address: registration.address,
            lease: current.leaseUntil,
            state: current.state,
            record: JSON.stringify(current),
          },
        );
        settleSubscriptions(sql, now);
        return ok({
          identity: value.identity,
          processGeneration: value.processGeneration,
          fence: registration.fence,
        });
      });
    },
    endpoint(identity) {
      return write((sql) => {
        const result = endpoint(sql, identity);
        return result.ok
          ? ok({
              endpoint: result.value.endpoint,
              publicKey: result.value.publicKey,
              address: result.value.address,
            })
          : result;
      });
    },
    renew(lease, state, now, label) {
      return write((sql) => {
        const prior = owner(sql, lease, now);
        if (!prior.ok) return prior;
        if (prior.value.state === "terminal" && state !== "terminal") return err({ code: "stale" });
        const updated = peerEndpointSchema.safeParse({
          ...prior.value,
          state,
          label: label ?? prior.value.label,
          leaseUntil: now + MAILBOX_LIMITS.leaseMs,
        });
        if (!updated.success) return err({ code: "invalid" });
        sql.run(
          "UPDATE peer_endpoints SET state=$state,lease_until=$lease,record=$record WHERE id=$id",
          {
            id: peerKey(lease.identity),
            state,
            lease: updated.data.leaseUntil,
            record: JSON.stringify(updated.data),
          },
        );
        if (state === "retired" || state === "terminal" || state === "offline") {
          for (const row of sql.all(
            "SELECT id FROM peer_messages WHERE recipient=$id OR sender=$id",
            { id: peerKey(lease.identity) },
          )) {
            const loaded = load(sql, String(row.id));
            if (!loaded.ok) throw new Error("corrupt peer retirement");
            const receipt = loaded.value.receipt;
            const inbound = samePeer(receipt.recipient, lease.identity);
            if (state === "offline") {
              if (inbound && receipt.delivery === "accepted-for-persistence")
                save(sql, {
                  ...receipt,
                  revision: receipt.revision + 1,
                  delivery: "queued",
                  reason: "offline",
                });
              continue;
            }
            if (state === "terminal" && !inbound) continue;
            if (
              !receipt.tombstoned &&
              receipt.handling !== "replied" &&
              receipt.handling !== "refused"
            )
              save(sql, {
                ...receipt,
                revision: receipt.revision + 1,
                policy: state === "retired" ? "revoked" : "refused",
                handling: inbound ? "refused" : receipt.handling,
                reason: state === "retired" ? "revoked" : "refused",
                wait:
                  receipt.wait === "open"
                    ? inbound
                      ? "settled"
                      : "cancelled-locally"
                    : receipt.wait,
              });
          }
        }
        settleSubscriptions(sql, now);
        return ok(updated.data);
      });
    },
    policy(lease, sender, policy, now) {
      if (
        !["allow", "hold", "refuse"].includes(policy.mode) ||
        !Number.isInteger(policy.perMinute) ||
        policy.perMinute < 1 ||
        policy.perMinute > MAILBOX_LIMITS.sendsPerMinute
      )
        return err({ code: "invalid" });
      return write((sql) => {
        const recipient = owner(sql, lease, now);
        const remote = endpoint(sql, sender);
        if (!recipient.ok) return recipient;
        if (!remote.ok) return remote;
        if (!samePeerScope(recipient.value.scope, remote.value.endpoint.scope))
          return err({ code: "denied" });
        sql.run(
          "INSERT INTO peer_policies(recipient,sender,mode,muted,per_minute) VALUES($recipient,$sender,$mode,$muted,$rate) ON CONFLICT(recipient,sender) DO UPDATE SET mode=excluded.mode,muted=excluded.muted,per_minute=excluded.per_minute",
          {
            recipient: peerKey(lease.identity),
            sender: peerKey(sender),
            mode: policy.mode,
            muted: Number(policy.muted),
            rate: policy.perMinute,
          },
        );
        if (policy.mode !== "allow") {
          for (const row of sql.all(
            "SELECT id FROM peer_messages WHERE sender=$sender AND recipient=$recipient",
            { sender: peerKey(sender), recipient: peerKey(lease.identity) },
          )) {
            const loaded = load(sql, String(row.id));
            if (!loaded.ok) throw new Error("invalid peer policy evidence");
            const receipt = loaded.value.receipt;
            if (
              receipt.tombstoned ||
              receipt.handling === "replied" ||
              receipt.handling === "refused"
            )
              continue;
            const mode = policy.mode === "hold" ? "held" : "refused";
            if (receipt.policy === mode) continue;
            const changed = change(sql, receipt, {
              policy: mode,
              reason: mode,
              ...(mode === "refused"
                ? {
                    handling: "refused" as const,
                    wait: receipt.wait === "open" ? ("settled" as const) : receipt.wait,
                  }
                : {}),
            });
            if (!changed.ok) throw new Error("peer policy revision capacity");
          }
        }
        settleSubscriptions(sql, now);
        return ok(undefined);
      });
    },
    discover(lease, after, limit, now) {
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAILBOX_LIMITS.page
      )
        return err({ code: "invalid" });
      return write((sql) => {
        const current = owner(sql, lease, now);
        if (!current.ok) return current;
        const rows = sql.all(
          "SELECT e.sequence,e.record FROM peer_endpoints e JOIN peer_policies p ON p.recipient=e.id WHERE p.sender=$sender AND p.mode!='refuse' AND e.sequence>$after AND NOT EXISTS (SELECT 1 FROM peer_endpoints newer WHERE newer.session=e.session AND newer.agent=e.agent AND newer.generation>e.generation) ORDER BY e.sequence LIMIT $limit",
          { sender: peerKey(lease.identity), after, limit: limit + 1 },
        );
        const items = rows.slice(0, limit).map((row) => {
          const peer = peerEndpointSchema.parse(JSON.parse(String(row.record)));
          return peer.leaseUntil <= now && (peer.state === "idle" || peer.state === "busy")
            ? { ...peer, state: "offline" as const }
            : peer;
        });
        return ok({
          items: items.filter(
            (item) => samePeerScope(item.scope, current.value.scope) && item.state !== "retired",
          ),
          cursor: {
            version: 1,
            endpoint: lease.identity,
            after: Number(rows[Math.min(rows.length, limit) - 1]?.sequence ?? after),
          },
          complete: rows.length <= limit,
        });
      });
    },
    propose: (lease, message, now) => write((sql) => persist(sql, lease, message, now, false)),
    admit: (lease, message, now) => write((sql) => persist(sql, lease, message, now, true)),
    acknowledge(lease, ack, now) {
      return write((sql) => {
        const loaded = access(sql, lease, ack.key, now);
        if (!loaded.ok) return loaded;
        const receipt = loaded.value.receipt;
        if (
          !samePeer(lease.identity, receipt.recipient) ||
          !samePeer(ack.recipient, lease.identity) ||
          ack.processGeneration !== lease.processGeneration
        )
          return err({ code: "denied" });
        if (receipt.policy !== "allowed") return err({ code: "held" });
        if (receipt.delivery === "proposed") return err({ code: "unavailable" });
        if (receipt.delivery === "expired") return err({ code: "expired" });
        if (receipt.handling === "replied" || receipt.handling === "refused")
          return receipt.handling === "refused" && ack.kind === "refused"
            ? ok(receipt)
            : conflict(sql, receipt);
        if (ack.kind === "delivered")
          return receipt.delivery === "delivered-to-endpoint"
            ? ok(receipt)
            : change(sql, receipt, { delivery: "delivered-to-endpoint" });
        if (ack.kind === "processing")
          return receipt.handling === "processing-acknowledged"
            ? ok(receipt)
            : change(sql, receipt, {
                delivery: "delivered-to-endpoint",
                handling: "processing-acknowledged",
              });
        return change(sql, receipt, {
          handling: "refused",
          reason: "refused",
          wait: receipt.wait === "open" ? "settled" : receipt.wait,
        });
      });
    },
    inspect(lease, key, now, reviewHeld = false, subject = lease.identity) {
      return write((sql) => {
        const result = access(sql, lease, key, now, subject);
        return result.ok
          ? ok({
              ...result.value,
              message:
                result.value.receipt.policy === "held" &&
                !reviewHeld &&
                samePeer(lease.identity, result.value.receipt.recipient)
                  ? null
                  : result.value.message,
            })
          : result;
      });
    },
    history(lease, after, limit, now, subject = lease.identity) {
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAILBOX_LIMITS.page
      )
        return err({ code: "invalid" });
      return write((sql) => {
        const current = reader(sql, lease, subject, now);
        if (!current.ok) return current;
        const rows = sql.all(
          "SELECT e.sequence,e.receipt,e.fact FROM peer_mailbox_events e JOIN peer_messages m ON m.id=e.id WHERE (m.sender=$id OR m.recipient=$id) AND e.sequence>$after ORDER BY e.sequence LIMIT $limit",
          { id: peerKey(subject), after, limit: limit + 1 },
        );
        const items = rows.slice(0, limit).map((row) => ({
          sequence: Number(row.sequence),
          receipt: mailboxReceiptSchema.parse(JSON.parse(String(row.receipt))),
          fact: row.fact === "conflict" ? ("conflict" as const) : ("transition" as const),
        }));
        sql.run(
          "INSERT INTO peer_cursors(endpoint,after) VALUES($endpoint,$after) ON CONFLICT(endpoint) DO UPDATE SET after=max(after,excluded.after)",
          { endpoint: peerKey(subject), after: items.at(-1)?.sequence ?? after },
        );
        return ok({
          items,
          cursor: { version: 1, endpoint: subject, after: items.at(-1)?.sequence ?? after },
          complete: rows.length <= limit,
        });
      });
    },
    localWait(lease, key, state, now) {
      return write((sql) => {
        const loaded = access(sql, lease, key, now);
        if (!loaded.ok) return loaded;
        if (!samePeer(loaded.value.receipt.sender, lease.identity)) return err({ code: "denied" });
        return loaded.value.receipt.wait !== "open"
          ? ok(loaded.value.receipt)
          : change(sql, loaded.value.receipt, { wait: state });
      });
    },
    release(lease, key, now) {
      return write((sql) => {
        const loaded = access(sql, lease, key, now);
        if (!loaded.ok) return loaded;
        const receipt = loaded.value.receipt;
        if (!samePeer(receipt.recipient, lease.identity)) return err({ code: "denied" });
        if (allowed(sql, receipt.sender, receipt.recipient)?.mode !== "allow")
          return err({ code: "denied" });
        return receipt.policy === "held"
          ? change(sql, receipt, { policy: "allowed", reason: "none" })
          : ok(receipt);
      });
    },
    cleanup(lease, key, now) {
      return write((sql) => {
        const loaded = access(sql, lease, key, now);
        if (!loaded.ok) return loaded;
        const { receipt, message } = loaded.value;
        if (receipt.tombstoned) return ok(receipt);
        if (
          receipt.expiresAt > now ||
          message?.retention === "policy-hold" ||
          receipt.policy === "held"
        )
          return err({ code: "held" });
        const result = change(sql, receipt, { tombstoned: true, reason: "cleaned" });
        if (!result.ok) return result;
        sql.run("UPDATE peer_messages SET payload=NULL,bytes=0 WHERE id=$id", { id: key });
        return result;
      });
    },
  };
}
