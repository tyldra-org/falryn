/** Shared user/model actions. Peer controls never derive authority from message contents. */
import { z } from "zod";
import { err, ok } from "../../domain/foundation/result.ts";
import {
  MAILBOX_LIMITS,
  type PeerResult,
  peerIdentitySchema,
  samePeer,
} from "../../domain/orchestration/peer-mailbox.ts";
import type { PeerMailbox } from "./peer-mailbox.ts";

export const peerActionSchema = z.strictObject({
  operation: z.enum([
    "endpoint",
    "discover",
    "send",
    "inspect",
    "history",
    "cursor",
    "reply",
    "refuse",
    "acknowledge",
    "wait",
    "subscribe",
    "inspect-subscription",
    "cancel-subscription",
    "cancel-wait",
    "cleanup",
    "export",
    "replay",
    "allow",
    "hold",
    "deny",
    "release",
    "revoke",
    "rename",
  ]),
  peer: peerIdentitySchema.optional(),
  as: peerIdentitySchema.optional(),
  key: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .optional(),
  messageJson: z.string().max(MAILBOX_LIMITS.envelopeBytes).optional(),
  after: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(MAILBOX_LIMITS.page).optional(),
  waitMs: z.number().int().min(1).max(29_000).optional(),
  predicate: z.enum(["idle", "terminal"]).optional(),
  subscriptionId: z.string().min(1).max(160).optional(),
  deadline: z.number().int().nonnegative().optional(),
  muted: z.boolean().optional(),
  perMinute: z.number().int().min(1).max(MAILBOX_LIMITS.sendsPerMinute).optional(),
  label: z.string().max(80).optional(),
});
const controls = new Set(["allow", "hold", "deny", "release", "revoke", "rename"]);
export async function executePeerAction(
  peer: PeerMailbox | null,
  raw: unknown,
  actor: "user" | "model",
  signal: AbortSignal,
): Promise<PeerResult<unknown>> {
  const parsed = peerActionSchema.safeParse(raw);
  if (!parsed.success) return err({ code: "invalid" as const });
  if (!peer) return err({ code: "unavailable" as const });
  if (!(await peer.authorize())) return err({ code: "denied" as const });
  const action = parsed.data;
  if (signal.aborted) return err({ code: "cancelled" as const });
  if (actor === "model" && (action.as || controls.has(action.operation)))
    return err({ code: "denied" as const });
  if (action.as && !samePeer(action.as, peer.identity)) {
    const subject = action.as;
    // The authenticated owning session can review retained child mail without reviving a child.
    return peer.localAction(action.operation, action, signal, async () => {
      switch (action.operation) {
        case "inspect":
          return action.key ? peer.inspect(action.key, true, subject) : err({ code: "invalid" });
        case "history":
        case "export":
        case "replay":
          return peer.history(action.after, action.limit, subject);
        case "cursor":
          return peer.cursor(subject);
        default:
          return err({ code: "unavailable" });
      }
    });
  }
  return ["send", "reply", "wait", "subscribe"].includes(action.operation)
    ? performPeerAction(peer, action, signal, actor)
    : peer.localAction(action.operation, action, signal, () =>
        performPeerAction(peer, action, signal, actor),
      );
}

async function performPeerAction(
  peer: PeerMailbox,
  action: z.infer<typeof peerActionSchema>,
  signal: AbortSignal,
  actor: "user" | "model",
): Promise<PeerResult<unknown>> {
  switch (action.operation) {
    case "endpoint": {
      const result = peer.endpoint();
      return result.ok ? ok(result.value.endpoint) : result;
    }
    case "discover":
      return peer.discover(action.after, action.limit);
    case "cursor":
      return peer.cursor();
    case "history":
    case "export":
    case "replay":
      return peer.history(action.after, action.limit);
    case "send":
    case "reply": {
      if (
        action.messageJson === undefined ||
        Buffer.byteLength(action.messageJson) > MAILBOX_LIMITS.envelopeBytes
      )
        return err({ code: "invalid" as const });
      try {
        const message: unknown = JSON.parse(action.messageJson);
        if (
          action.operation === "reply" &&
          (typeof message !== "object" ||
            message === null ||
            !("kind" in message) ||
            message.kind !== "reply")
        )
          return err({ code: "invalid" });
        return await peer.send(message, signal);
      } catch {
        return err({ code: "invalid" as const });
      }
    }
    case "allow":
    case "hold":
    case "deny":
      return action.peer
        ? peer.policy(action.peer, {
            mode: action.operation === "deny" ? "refuse" : action.operation,
            muted: action.muted ?? false,
            perMinute: action.perMinute ?? MAILBOX_LIMITS.sendsPerMinute,
          })
        : err({ code: "invalid" as const });
    case "revoke":
      return peer.state("retired");
    case "rename":
      return action.label === undefined
        ? err({ code: "invalid" as const })
        : (() => {
            const current = peer.endpoint();
            return current.ok ? peer.state(current.value.endpoint.state, action.label) : current;
          })();
    case "subscribe":
      return action.peer && action.predicate && (action.waitMs || action.deadline)
        ? peer.availability(
            action.peer,
            action.predicate,
            action.deadline ?? peer.deadlineAfter(action.waitMs ?? 29_000),
            signal,
            action.subscriptionId,
          )
        : err({ code: "invalid" as const });
    case "inspect-subscription":
      return action.subscriptionId
        ? peer.subscription(action.subscriptionId)
        : err({ code: "invalid" as const });
    case "cancel-subscription":
      return action.subscriptionId
        ? peer.cancelSubscription(action.subscriptionId)
        : err({ code: "invalid" as const });
    default:
      if (!action.key) return err({ code: "invalid" as const });
      switch (action.operation) {
        case "inspect":
          return peer.inspect(action.key, actor === "user");
        case "refuse":
          return peer.acknowledge(action.key, "refused");
        case "acknowledge":
          return peer.acknowledge(action.key, "processing");
        case "release":
          return peer.release(action.key);
        case "wait":
          return peer.wait(
            action.key,
            action.deadline ?? peer.deadlineAfter(action.waitMs ?? 29_000),
            signal,
          );
        case "cancel-wait":
          return peer.cancelWait(action.key);
        case "cleanup":
          return peer.cleanup(action.key);
      }
  }
}
