/** One endpoint owner composes durable mailbox actions with authenticated local IPC. */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { type ClockPort, instant } from "../../domain/foundation/index.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import {
  MAILBOX_LIMITS,
  type MailboxReceipt,
  type MailboxRepository,
  mailboxReceiptSchema,
  messageKey,
  type PeerEndpoint,
  type PeerIdentity,
  type PeerLease,
  type PeerMessage,
  type PeerNotice,
  type PeerPolicy,
  type PeerResult,
  type PeerScope,
  peerIdentitySchema,
  peerMessageSchema,
  samePeer,
} from "../../domain/orchestration/peer-mailbox.ts";
import type { PeerCrypto, PeerTransport } from "../../domain/orchestration/peer-transport.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import type { ProductTaskResources } from "./product-resources.ts";

const operationSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("deliver"), message: peerMessageSchema }),
  z.strictObject({
    action: z.literal("await"),
    key: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    deadline: z.number().int().nonnegative(),
  }),
  z.strictObject({
    action: z.literal("availability"),
    id: z.string().min(1).max(160),
    predicate: z.enum(["idle", "terminal"]),
    deadline: z.number().int().nonnegative(),
  }),
]);
const outerSchema = z.strictObject({
  version: z.literal(1),
  sender: peerIdentitySchema,
  processGeneration: z.string().min(1).max(160),
  sealed: z.string().max(525_000),
});
const requestSchema = z.strictObject({
  version: z.literal(1),
  recipient: peerIdentitySchema,
  processGeneration: z.string().min(1).max(160),
  requestId: z.string().uuid(),
  expiresAt: z.number().int().nonnegative(),
  capability: z.string().length(43).nullable(),
  operation: operationSchema,
});
type Operation = z.infer<typeof operationSchema>;

export async function openPeerMailbox(options: {
  repository: MailboxRepository;
  transport: PeerTransport;
  crypto: PeerCrypto;
  clock: ClockPort;
  resources: ProductTaskResources;
  identity: PeerIdentity;
  scope: PeerScope;
  label: string;
  initialState?: "idle" | "busy";
  authorize?(): Promise<boolean>;
  authorizeArtifacts(message: PeerMessage, signal: AbortSignal): Promise<boolean>;
  redact(text: string): string;
}) {
  const { repository, transport, crypto, clock, resources } = options;
  const processGeneration = randomUUID();
  const previousRoute = repository.endpoint(options.identity);
  let lease: PeerLease | null = null;
  let closed = false;
  const lifecycle = new AbortController();
  const changes = new Set<() => void>();
  const listeners = new Set<(notice: PeerNotice) => void>();
  const outgoingWatches = new Map<string, AbortController>();
  const grants = new Map<
    string,
    { token: string; digest: string; sender: PeerIdentity; expiresAt: number }
  >();
  const now = () => Number(clock.now());
  const unavailable = (): PeerResult<never> => err({ code: "unavailable" });
  async function revalidate(): Promise<boolean> {
    if (closed || lifecycle.signal.aborted) return false;
    if (options.authorize && !(await options.authorize())) {
      if (lease) repository.renew(lease, "retired", now());
      lifecycle.abort();
      grants.clear();
      notify();
      void closeEndpoint();
      return false;
    }
    return true;
  }
  const notify = () => {
    for (const changed of [...changes]) changed();
    if (!lease || listeners.size === 0) return;
    const pending = repository.notifications(lease, now());
    if (pending.ok)
      for (const notice of pending.value) for (const listener of listeners) listener(notice);
  };
  async function admitted<T>(
    operation: string,
    input: unknown,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<PeerResult<T>>,
  ): Promise<PeerResult<T>> {
    if (closed || signal.aborted || !lease) return unavailable();
    if (!(await revalidate())) return err({ code: "denied" });
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(input));
    } catch {
      return err({ code: "invalid" });
    }
    if (bytes > MAILBOX_LIMITS.envelopeBytes + 4_096) return err({ code: "full" });
    try {
      const result = await resources.execute({
        operation: `peer-${operation}-${randomUUID()}`,
        attempt: "1",
        generation: resources.generation,
        inputBytes: bytes,
        amounts: { operations: 1, concurrency: 1, memoryBytes: 1_048_576 },
        signal: AbortSignal.any([signal, lifecycle.signal]),
        unit: {
          id: workUnitId(randomUUID()),
          effect: "mutation",
          priority: "interactive",
          conflictKeys: [conflictKey("peer", `${options.identity.agentId}:${operation}`)],
          dependencies: [],
          deadline: null,
          expectedOutputBytes: 262_144,
          retry: NO_RETRY,
          scopeId: null,
        },
        run: async (admittedSignal) => ({ value: await run(admittedSignal), terminated: true }),
      });
      return result.kind === "completed"
        ? result.value
        : err({ code: result.receipt.state === "cancelled" ? "cancelled" : "unavailable" });
    } catch {
      return unavailable();
    }
  }
  async function observe(
    operation: Exclude<Operation, { action: "deliver" }>,
    sender: PeerIdentity,
    signal: AbortSignal,
  ): Promise<PeerResult<unknown>> {
    if (
      !lease ||
      operation.deadline <= now() ||
      operation.deadline > Math.min(resources.expiresAt, now() + MAILBOX_LIMITS.admissionMs)
    )
      return err({ code: "expired" });
    if (changes.size >= MAILBOX_LIMITS.waiters) return err({ code: "full" });
    const currentLease = lease;
    return new Promise((resolve) => {
      const deadline = new AbortController();
      let settled = false;
      const finish = (value: PeerResult<unknown>) => {
        if (settled) return;
        settled = true;
        changes.delete(check);
        signal.removeEventListener("abort", abort);
        deadline.abort();
        resolve(value);
      };
      const abort = () => finish(err({ code: "cancelled" }));
      const check = () => {
        if (closed) {
          finish(unavailable());
          return;
        }
        const authority = repository.authorize(currentLease, sender, now());
        if (!authority.ok) {
          finish(authority);
          return;
        }
        if (operation.action === "availability") {
          const subscription = repository.subscription(currentLease, sender, operation.id, now());
          if (!subscription.ok) {
            finish(subscription);
            return;
          }
          if (subscription.value.wait !== "open") finish(subscription);
        } else {
          const record = repository.inspect(currentLease, operation.key, now());
          if (!record.ok) {
            finish(record);
            return;
          }
          if (!samePeer(record.value.receipt.sender, sender)) {
            finish(err({ code: "denied" }));
            return;
          }
          if (
            record.value.receipt.wait !== "open" ||
            record.value.receipt.handling === "replied" ||
            record.value.receipt.handling === "refused" ||
            record.value.receipt.delivery === "expired"
          )
            finish(ok(record.value.receipt));
        }
      };
      // Register before testing. Every local semantic write calls notify after commit.
      changes.add(check);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else check();
      void clock.waitUntil(instant(operation.deadline), deadline.signal).then((outcome) => {
        if (outcome !== "aborted") {
          if (operation.action === "availability")
            finish(repository.subscription(currentLease, sender, operation.id, now()));
          else finish(err({ code: "expired" }));
        }
      });
    });
  }
  const listening = await transport.listen(async (raw, signal) => {
    if (closed || !lease) return unavailable();
    if (!(await revalidate())) return err({ code: "denied" });
    const outer = outerSchema.safeParse(raw);
    if (!outer.success) return err({ code: "invalid" });
    const sender = repository.endpoint(outer.data.sender);
    if (!sender.ok || sender.value.endpoint.processGeneration !== outer.data.processGeneration)
      return err({ code: "denied" });
    const verified = crypto.decrypt(sender.value.publicKey, outer.data.sealed);
    if (!verified.ok) return verified;
    const parsed = requestSchema.safeParse(verified.value);
    if (!parsed.success) return err({ code: "invalid" });
    const request = parsed.data;
    const respond = (result: PeerResult<unknown>) => ({
      sealed: crypto.seal(sender.value.publicKey, { requestId: request.requestId, result }),
    });
    if (
      !samePeer(request.recipient, options.identity) ||
      request.processGeneration !== processGeneration ||
      request.expiresAt <= now() ||
      request.expiresAt > now() + MAILBOX_LIMITS.admissionMs
    )
      return respond(err({ code: "stale" }));
    const permission = repository.authorize(lease, outer.data.sender, now());
    if (!permission.ok) return respond(permission);
    for (const [id, grant] of grants) if (grant.expiresAt <= now()) grants.delete(id);
    const operationDigest = canonicalDigest(request.operation);
    let result: PeerResult<unknown>;
    if (request.capability === null) {
      if (grants.size >= MAILBOX_LIMITS.waiters) return respond(err({ code: "full" }));
      const token = randomBytes(32).toString("base64url");
      grants.set(request.requestId, {
        token,
        sender: outer.data.sender,
        digest: operationDigest,
        expiresAt: request.expiresAt,
      });
      result = ok({ capability: token });
    } else {
      const grant = grants.get(request.requestId);
      if (
        !grant ||
        !samePeer(grant.sender, outer.data.sender) ||
        grant.digest !== operationDigest ||
        !timingSafeEqual(Buffer.from(grant.token), Buffer.from(request.capability))
      )
        return respond(err({ code: "denied" }));
      grants.delete(request.requestId);
      const operation = request.operation;
      const currentLease = lease;
      result = await admitted<unknown>(
        operation.action,
        operation,
        signal,
        async (admittedSignal) => {
          if (request.expiresAt <= now()) return err({ code: "expired" });
          if (operation.action === "availability")
            return repository.subscribe(
              currentLease,
              {
                id: operation.id,
                sender: outer.data.sender,
                recipient: options.identity,
                predicate: operation.predicate,
                deadline: operation.deadline,
              },
              now(),
            );
          if (operation.action !== "deliver")
            return repository.authorize(currentLease, outer.data.sender, now());
          if (
            !samePeer(operation.message.sender, outer.data.sender) ||
            !samePeer(operation.message.recipient, options.identity)
          )
            return err({ code: "denied" });
          if (
            options.redact(operation.message.text) !== operation.message.text ||
            !(await options.authorizeArtifacts(operation.message, admittedSignal))
          )
            return err({ code: "denied" });
          const receipt = repository.admit(currentLease, operation.message, now());
          if (receipt.ok) notify();
          return receipt;
        },
      );
      if (result.ok && operation.action !== "deliver")
        result = await observe(
          operation,
          outer.data.sender,
          AbortSignal.any([signal, lifecycle.signal]),
        );
    }
    return respond(result);
  });
  if (!listening.ok) return listening;
  const registered = repository.register(
    {
      endpoint: {
        version: 1,
        identity: options.identity,
        scope: options.scope,
        label: options.label,
        state: options.initialState ?? "idle",
        processGeneration,
        leaseUntil: now() + MAILBOX_LIMITS.leaseMs,
      },
      publicKey: crypto.publicKey,
      address: listening.value.address,
      fence: randomBytes(32).toString("base64url"),
    },
    now(),
  );
  if (!registered.ok) {
    await listening.value.close();
    return registered;
  }
  lease = registered.value;
  const ownLease = registered.value;
  const listener = listening.value;
  let state: PeerEndpoint["state"] = options.initialState ?? "idle";
  const keepLease = (async () => {
    while (!lifecycle.signal.aborted) {
      const outcome = await clock.waitUntil(
        instant(now() + MAILBOX_LIMITS.leaseMs / 3),
        lifecycle.signal,
      );
      if (outcome === "aborted") return;
      if (resources.expiresAt <= now() || !repository.renew(ownLease, state, now()).ok) {
        lifecycle.abort();
        notify();
        void closeEndpoint();
        return;
      }
    }
  })();
  let closing: Promise<void> | null = null;
  const unsubscribe = resources.onClose(() => {
    lifecycle.abort();
    notify();
    void closeEndpoint();
  });
  function closeEndpoint(): Promise<void> {
    if (closing) return closing;
    if (state !== "terminal" && state !== "retired") repository.renew(ownLease, "offline", now());
    closed = true;
    lifecycle.abort();
    notify();
    closing = (async () => {
      await listener.close();
      await keepLease;
      unsubscribe?.();
      grants.clear();
      listeners.clear();
    })();
    return closing;
  }
  if (!unsubscribe || closed) {
    await closeEndpoint();
    return unavailable();
  }
  if (previousRoute.ok && previousRoute.value.address !== listener.address)
    await transport.retire(previousRoute.value.address);
  async function request(
    recipient: PeerIdentity,
    operation: Operation,
    signal: AbortSignal,
  ): Promise<PeerResult<unknown>> {
    const route = repository.endpoint(recipient);
    if (
      !route.ok ||
      route.value.endpoint.leaseUntil <= now() ||
      route.value.endpoint.state === "offline"
    )
      return unavailable();
    const requestId = randomUUID();
    const expiresAt = now() + MAILBOX_LIMITS.admissionMs;
    const exchange = async (capability: string | null): Promise<PeerResult<unknown>> => {
      const sealed = crypto.seal(route.value.publicKey, {
        version: 1,
        recipient,
        processGeneration: route.value.endpoint.processGeneration,
        requestId,
        expiresAt,
        capability,
        operation,
      });
      const response = await transport.request(
        route.value.address,
        { version: 1, sender: options.identity, processGeneration, sealed },
        signal,
      );
      if (!response.ok) return response;
      const wrapper = z.strictObject({ sealed: z.string().max(525_000) }).safeParse(response.value);
      if (!wrapper.success) return unavailable();
      const decoded = crypto.decrypt(route.value.publicKey, wrapper.data.sealed);
      if (!decoded.ok) return decoded;
      const envelope = z
        .strictObject({
          requestId: z.literal(requestId),
          result: z.discriminatedUnion("ok", [
            z.strictObject({ ok: z.literal(true), value: z.unknown() }),
            z.strictObject({
              ok: z.literal(false),
              error: z.strictObject({
                code: z.enum([
                  "invalid",
                  "denied",
                  "stale",
                  "conflict",
                  "full",
                  "rate-limited",
                  "unavailable",
                  "uncertain",
                  "corrupt",
                  "not-found",
                  "expired",
                  "cancelled",
                  "held",
                ]),
              }),
            }),
          ]),
        })
        .safeParse(decoded.value);
      return envelope.success ? envelope.data.result : err({ code: "invalid" });
    };
    const grant = await exchange(null);
    if (!grant.ok) return grant;
    const token = z.strictObject({ capability: z.string().length(43) }).safeParse(grant.value);
    return token.success ? exchange(token.data.capability) : err({ code: "denied" });
  }
  return ok({
    authorize: revalidate,
    localAction: (
      operation: string,
      input: unknown,
      signal: AbortSignal,
      run: () => Promise<PeerResult<unknown>>,
    ) => admitted(operation, input, signal, run),
    deadlineAfter: (duration: number) => Math.min(now() + duration, resources.expiresAt),
    identity: options.identity,
    endpoint: () => repository.endpoint(options.identity),
    subscribe(listener: (notice: PeerNotice) => void) {
      if (listeners.size >= MAILBOX_LIMITS.waiters) return null;
      listeners.add(listener);
      notify();
      return () => listeners.delete(listener);
    },
    /** Only the host's direct user controls receive this method. */
    policy(sender: PeerIdentity, policy: PeerPolicy) {
      const result = repository.policy(ownLease, sender, policy, now());
      if (result.ok) notify();
      return result;
    },
    state(next: PeerEndpoint["state"], label?: string) {
      const result = repository.renew(ownLease, next, now(), label);
      if (result.ok) {
        state = next;
        notify();
      }
      return result;
    },
    discover: (after = 0, limit: number = MAILBOX_LIMITS.page) =>
      repository.discover(ownLease, after, limit, now()),
    history: (after = 0, limit: number = MAILBOX_LIMITS.page, subject?: PeerIdentity) =>
      repository.history(ownLease, after, limit, now(), subject),
    inspect: (key: string, reviewHeld = false, subject?: PeerIdentity) =>
      repository.inspect(ownLease, key, now(), reviewHeld, subject),
    cursor: (subject?: PeerIdentity) => repository.cursor(ownLease, now(), subject),
    release: (key: string) => {
      const result = repository.release(ownLease, key, now());
      if (result.ok) notify();
      return result;
    },
    async send(raw: unknown, signal: AbortSignal): Promise<PeerResult<MailboxReceipt>> {
      const parsed = peerMessageSchema.safeParse(raw);
      if (!parsed.success || !samePeer(parsed.data.sender, options.identity))
        return err({ code: "invalid" });
      const message = parsed.data;
      if (
        message.kind === "reply" &&
        message.correlation !== null &&
        typeof raw === "object" &&
        raw !== null &&
        !("expiresAt" in raw)
      ) {
        const original = repository.inspect(
          ownLease,
          messageKey({
            id: message.correlation,
            sender: message.recipient,
            recipient: message.sender,
          }),
          now(),
        );
        if (!original.ok) return original;
        message.expiresAt = Math.min(message.expiresAt, original.value.receipt.expiresAt);
      }
      const proposed = await admitted("send", message, signal, async (admittedSignal) => {
        if (
          options.redact(message.text) !== message.text ||
          !(await options.authorizeArtifacts(message, admittedSignal))
        )
          return err({ code: "denied" });
        return repository.propose(ownLease, message, now());
      });
      if (!proposed.ok || !["proposed", "unavailable"].includes(proposed.value.delivery))
        return proposed;
      const attempt = repository.deliveryAttempt(ownLease, proposed.value.key, "started", now());
      if (!attempt.ok || attempt.value.delivery === "failed") return attempt;
      const result = await request(
        message.recipient,
        { action: "deliver", message },
        AbortSignal.any([signal, lifecycle.signal]),
      );
      if (!result.ok) {
        const reconciled = repository.deliveryAttempt(
          ownLease,
          proposed.value.key,
          "unavailable",
          now(),
        );
        if (
          reconciled.ok &&
          !["proposed", "unavailable", "failed"].includes(reconciled.value.delivery)
        )
          return reconciled;
        return result.error.code === "unavailable" || result.error.code === "uncertain"
          ? reconciled
          : result;
      }
      const receipt = mailboxReceiptSchema.safeParse(result.value);
      if (
        !receipt.success ||
        receipt.data.key !== proposed.value.key ||
        receipt.data.digest !== proposed.value.digest
      )
        return err({ code: "invalid" });
      notify();
      return ok(receipt.data);
    },
    acknowledge(key: string, kind: "delivered" | "processing" | "refused") {
      const result = repository.acknowledge(
        ownLease,
        { version: 1, key, recipient: options.identity, processGeneration, kind },
        now(),
      );
      if (result.ok) notify();
      return result;
    },
    async wait(key: string, deadline: number, signal: AbortSignal) {
      const record = repository.inspect(ownLease, key, now());
      if (!record.ok) return record;
      if (!samePeer(record.value.receipt.sender, options.identity))
        return err({ code: "denied" as const });
      if (record.value.receipt.wait !== "open") return ok(record.value.receipt);
      const admission = await admitted("wait", { key }, signal, async () => ok(null));
      if (!admission.ok) return admission;
      const result = await request(
        record.value.receipt.recipient,
        { action: "await", key, deadline },
        AbortSignal.any([signal, lifecycle.signal]),
      );
      if (signal.aborted || (!result.ok && result.error.code === "expired"))
        return repository.localWait(
          ownLease,
          key,
          signal.aborted ? "cancelled-locally" : "timed-out",
          now(),
        );
      const durable = repository.inspect(ownLease, key, now());
      if (durable.ok && durable.value.receipt.wait !== "open") return ok(durable.value.receipt);
      return result;
    },
    availability: async (
      recipient: PeerIdentity,
      predicate: "idle" | "terminal",
      deadline: number,
      signal: AbortSignal,
      id: string = randomUUID(),
    ) => {
      if (outgoingWatches.has(id)) return err({ code: "conflict" as const });
      if (outgoingWatches.size >= MAILBOX_LIMITS.waiters) return err({ code: "full" as const });
      const admission = await admitted("availability", { recipient, predicate }, signal, async () =>
        ok(null),
      );
      if (!admission.ok) return admission;
      const target = repository.endpoint(recipient);
      if (target.ok && target.value.endpoint.state === "terminal")
        return repository.subscribe(
          ownLease,
          { id, sender: options.identity, recipient, predicate, deadline },
          now(),
        );
      const watch = new AbortController();
      outgoingWatches.set(id, watch);
      try {
        const result = await request(
          recipient,
          { action: "availability", id, predicate, deadline },
          AbortSignal.any([signal, watch.signal, lifecycle.signal]),
        );
        if (signal.aborted || watch.signal.aborted)
          repository.cancelSubscription(ownLease, id, now());
        const durable = repository.subscription(ownLease, options.identity, id, now());
        return durable.ok ? durable : result;
      } finally {
        outgoingWatches.delete(id);
      }
    },
    subscription: (id: string) => repository.subscription(ownLease, options.identity, id, now()),
    cancelSubscription(id: string) {
      const result = repository.cancelSubscription(ownLease, id, now());
      outgoingWatches.get(id)?.abort();
      return result;
    },
    cancelWait: (key: string) => {
      const result = repository.localWait(ownLease, key, "cancelled-locally", now());
      notify();
      return result;
    },
    cleanup: (key: string) => repository.cleanup(ownLease, key, now()),
    close: closeEndpoint,
  });
}
export type PeerMailbox = Extract<
  Awaited<ReturnType<typeof openPeerMailbox>>,
  { ok: true }
>["value"];
export type PeerMailboxFactory = {
  open(
    identity: PeerIdentity,
    resources?: ProductTaskResources,
    initialState?: "idle" | "busy",
  ): Promise<PeerMailbox | null>;
};
