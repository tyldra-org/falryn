/** Versioned peer evidence. Neither envelopes nor receipts carry execution authority. */
import { z } from "zod";
import { artifactId, contentDigest } from "../artifacts/index.ts";
import { canonicalDigest } from "../extensions/canonical.ts";
import type { Result } from "../foundation/result.ts";

export const MAILBOX_LIMITS = {
  textBytes: 16_384,
  envelopeBytes: 32_768,
  pending: 64,
  queuedBytes: 1_048_576,
  page: 100,
  peers: 256,
  waiters: 64,
  attachments: 8,
  attachmentBytes: 1_048_576,
  fanOut: 16,
  sendsPerMinute: 64,
  revisions: 16,
  retainedBytes: 16_777_216,
  lineageBytes: 81_920,
  registryBytes: 67_108_864,
  admissionMs: 30_000,
  leaseMs: 30_000,
  expiryMs: 86_400_000,
  attempts: 3,
} as const;
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._:-]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const peerIdentitySchema = z.strictObject({
  sessionId: id,
  agentId: id,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type PeerIdentity = z.infer<typeof peerIdentitySchema>;
export const peerScopeSchema = z.strictObject({
  workspace: digest,
  project: digest,
  user: digest,
  environment: digest,
  trust: digest,
});
export type PeerScope = z.infer<typeof peerScopeSchema>;
export const peerEndpointSchema = z.strictObject({
  version: z.literal(1),
  identity: peerIdentitySchema,
  scope: peerScopeSchema,
  label: z
    .string()
    .max(80)
    .regex(/^[^\p{Cc}]*$/u),
  state: z.enum(["idle", "busy", "offline", "terminal", "retired"]),
  processGeneration: id,
  leaseUntil: timestamp,
});
export type PeerEndpoint = z.infer<typeof peerEndpointSchema>;
export const peerArtifactSchema = z.strictObject({
  artifactId: z.string().refine((value) => artifactId.parse(value).ok),
  digest: z.string().refine((value) => contentDigest.parse(value).ok),
  bytes: z.number().int().nonnegative().max(MAILBOX_LIMITS.attachmentBytes),
});
export const peerMessageSchema = z
  .strictObject({
    version: z.literal(1),
    id,
    sender: peerIdentitySchema,
    recipient: peerIdentitySchema,
    scope: peerScopeSchema,
    laneSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdAt: timestamp,
    expiresAt: timestamp.optional(),
    kind: z.enum(["message", "request", "reply"]),
    correlation: id.nullable(),
    text: z
      .string()
      .refine((text) => text.isWellFormed() && Buffer.byteLength(text) <= MAILBOX_LIMITS.textBytes),
    artifacts: z.array(peerArtifactSchema).max(MAILBOX_LIMITS.attachments),
    sensitivity: z.enum(["public", "internal"]),
    retention: z.enum(["normal", "policy-hold"]),
    provenance: z.strictObject({
      causalMessage: id.nullable(),
      hops: z.number().int().min(0).max(8),
      source: z.literal("peer-evidence"),
      effectAuthority: z.literal(false),
    }),
  })
  .transform((message) => ({
    ...message,
    expiresAt: message.expiresAt ?? message.createdAt + MAILBOX_LIMITS.expiryMs,
  }))
  .refine(
    (message) =>
      Number.isSafeInteger(message.expiresAt) &&
      message.expiresAt > message.createdAt &&
      message.expiresAt - message.createdAt <= MAILBOX_LIMITS.expiryMs &&
      (message.kind === "reply" ? message.correlation !== null : message.correlation === null) &&
      message.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) <=
        MAILBOX_LIMITS.attachmentBytes,
  );
export type PeerMessage = z.infer<typeof peerMessageSchema>;
export const mailboxReceiptSchema = z.strictObject({
  version: z.literal(1),
  key: digest,
  messageId: id,
  sender: peerIdentitySchema,
  recipient: peerIdentitySchema,
  scope: peerScopeSchema,
  createdAt: timestamp,
  digest,
  correlation: id.nullable(),
  expiresAt: timestamp,
  revision: z.number().int().min(1).max(MAILBOX_LIMITS.revisions),
  delivery: z.enum([
    "proposed",
    "accepted-for-persistence",
    "queued",
    "delivered-to-endpoint",
    "expired",
    "unavailable",
    "failed",
  ]),
  handling: z.enum(["unacknowledged", "processing-acknowledged", "replied", "refused"]),
  wait: z.enum(["open", "settled", "timed-out", "cancelled-locally"]),
  policy: z.enum(["allowed", "held", "refused", "revoked"]),
  reason: z.enum([
    "none",
    "offline",
    "held",
    "refused",
    "revoked",
    "expired",
    "transport-unavailable",
    "conflict",
    "cleaned",
  ]),
  reply: digest.nullable(),
  tombstoned: z.boolean(),
  effectAuthority: z.literal(false),
});
export type MailboxReceipt = z.infer<typeof mailboxReceiptSchema>;
export const deliveryAckSchema = z.strictObject({
  version: z.literal(1),
  key: digest,
  recipient: peerIdentitySchema,
  processGeneration: id,
  kind: z.enum(["delivered", "processing", "refused"]),
});
export type DeliveryAck = z.infer<typeof deliveryAckSchema>;
export const mailboxCursorSchema = z.strictObject({
  version: z.literal(1),
  endpoint: peerIdentitySchema,
  after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type MailboxCursor = z.infer<typeof mailboxCursorSchema>;
export const peerSubscriptionSchema = z.strictObject({
  version: z.literal(1),
  id,
  sender: peerIdentitySchema,
  recipient: peerIdentitySchema,
  predicate: z.enum(["idle", "terminal"]),
  deadline: timestamp,
  wait: z.enum(["open", "settled", "timed-out", "cancelled-locally"]),
  reason: z.enum(["idle", "terminal", "expired", "cancelled-locally", "revoked"]).nullable(),
  observation: peerEndpointSchema.nullable(),
});
export type PeerSubscription = z.infer<typeof peerSubscriptionSchema>;
export type PeerSubscriptionInput = Pick<
  PeerSubscription,
  "id" | "sender" | "recipient" | "predicate" | "deadline"
>;
export type MailboxPage<T> = { items: T[]; cursor: MailboxCursor; complete: boolean };
export type PeerFailure = {
  code:
    | "invalid"
    | "denied"
    | "stale"
    | "conflict"
    | "full"
    | "rate-limited"
    | "unavailable"
    | "uncertain"
    | "corrupt"
    | "not-found"
    | "expired"
    | "cancelled"
    | "held";
};
export type PeerResult<T> = Result<T, PeerFailure>;
export const peerKey = (identity: PeerIdentity) => canonicalDigest(identity);
export const messageKey = (message: Pick<PeerMessage, "id" | "sender" | "recipient">) =>
  canonicalDigest([message.sender, message.recipient, message.id]);
export const samePeer = (a: PeerIdentity, b: PeerIdentity) => peerKey(a) === peerKey(b);
export const samePeerScope = (a: PeerScope, b: PeerScope) =>
  canonicalDigest(a) === canonicalDigest(b);

/** Host-only registration material. Never appears in a public endpoint projection. */
export type PeerRegistration = {
  endpoint: PeerEndpoint;
  publicKey: string;
  address: string;
  fence: string;
};
export type PeerLease = { identity: PeerIdentity; processGeneration: string; fence: string };
export type PeerPolicy = { mode: "allow" | "hold" | "refuse"; muted: boolean; perMinute: number };
export type MailboxRecord = { receipt: MailboxReceipt; message: PeerMessage | null };
export type PeerObservation = {
  sequence: number;
  receipt: MailboxReceipt;
  fact: "transition" | "conflict";
};
export type PeerNotice = { key: string; reason: "arrival" | "settlement"; receipt: MailboxReceipt };

/** All writers recheck the exact owner fence, generation, scope, policy and deadline in SQLite. */
export type MailboxRepository = {
  cursor(lease: PeerLease, now: number, subject?: PeerIdentity): PeerResult<MailboxCursor>;
  notifications(lease: PeerLease, now: number): PeerResult<PeerNotice[]>;
  subscribe(
    lease: PeerLease,
    input: PeerSubscriptionInput,
    now: number,
  ): PeerResult<PeerSubscription>;
  subscription(
    lease: PeerLease,
    sender: PeerIdentity,
    id: string,
    now: number,
  ): PeerResult<PeerSubscription>;
  cancelSubscription(lease: PeerLease, id: string, now: number): PeerResult<PeerSubscription>;
  ownsArtifact(sender: PeerIdentity, artifactId: string): PeerResult<boolean>;
  authorize(lease: PeerLease, sender: PeerIdentity, now: number): PeerResult<void>;
  register(registration: PeerRegistration, now: number): PeerResult<PeerLease>;
  endpoint(identity: PeerIdentity): PeerResult<Omit<PeerRegistration, "fence">>;
  renew(
    lease: PeerLease,
    state: PeerEndpoint["state"],
    now: number,
    label?: string,
  ): PeerResult<PeerEndpoint>;
  policy(lease: PeerLease, sender: PeerIdentity, policy: PeerPolicy, now: number): PeerResult<void>;
  discover(
    lease: PeerLease,
    after: number,
    limit: number,
    now: number,
  ): PeerResult<MailboxPage<PeerEndpoint>>;
  propose(lease: PeerLease, message: PeerMessage, now: number): PeerResult<MailboxReceipt>;
  deliveryAttempt(
    lease: PeerLease,
    key: string,
    phase: "started" | "unavailable",
    now: number,
  ): PeerResult<MailboxReceipt>;
  admit(lease: PeerLease, message: PeerMessage, now: number): PeerResult<MailboxReceipt>;
  acknowledge(lease: PeerLease, ack: DeliveryAck, now: number): PeerResult<MailboxReceipt>;
  inspect(
    lease: PeerLease,
    key: string,
    now: number,
    reviewHeld?: boolean,
    subject?: PeerIdentity,
  ): PeerResult<MailboxRecord>;
  history(
    lease: PeerLease,
    after: number,
    limit: number,
    now: number,
    subject?: PeerIdentity,
  ): PeerResult<MailboxPage<PeerObservation>>;
  localWait(
    lease: PeerLease,
    key: string,
    state: "timed-out" | "cancelled-locally",
    now: number,
  ): PeerResult<MailboxReceipt>;
  release(lease: PeerLease, key: string, now: number): PeerResult<MailboxReceipt>;
  cleanup(lease: PeerLease, key: string, now: number): PeerResult<MailboxReceipt>;
};
