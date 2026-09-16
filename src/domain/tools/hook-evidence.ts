/** Allowlisted facts cross the journal boundary. Raw handler diagnostics never do. */
import { z } from "zod";
import { hookPointSchema } from "../extensions/hook-points.ts";
import { digestSchema } from "../extensions/identity.ts";
import { hookHealthSnapshotSchema } from "./hook-health.ts";
import { HOOK_SOURCE_ORDER } from "./tool-hook-order.ts";

const count = z.int().nonnegative();
const response = z.enum(["valid", "invalid", "missing", "refused", "stale", "unknown"]);
export const hookHandlerFactsSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("process"),
    transport: z.enum(["not-started", "settled", "failed", "cancelled", "timed-out", "uncertain"]),
    exitCode: z.int().nullable(),
    signal: z
      .enum([
        "SIGHUP",
        "SIGINT",
        "SIGQUIT",
        "SIGILL",
        "SIGABRT",
        "SIGFPE",
        "SIGKILL",
        "SIGSEGV",
        "SIGPIPE",
        "SIGALRM",
        "SIGTERM",
        "SIGUSR1",
        "SIGUSR2",
        "SIGBUS",
        "SIGTRAP",
        "SIGXCPU",
        "SIGXFSZ",
        "SIGSTOP",
        "SIGCONT",
        "SIGTSTP",
        "SIGTTIN",
        "SIGTTOU",
        "UNKNOWN",
      ])
      .nullable(),
    response,
    stdoutBytes: count,
    stderrBytes: count,
    omittedBytes: count,
    effects: z.enum(["none", "unknown"]),
  }),
  z.strictObject({
    kind: z.literal("remote"),
    transport: z.enum(["http", "mcp"]),
    status: z.enum([
      "not-started",
      "completed",
      "disconnected",
      "failed",
      "cancelled",
      "timed-out",
    ]),
    httpStatus: z.int().min(100).max(599).nullable(),
    schemaGeneration: count.nullable(),
    response,
    omittedBytes: count,
    effects: z.enum(["none", "observed", "unknown"]),
  }),
  z.strictObject({
    kind: z.literal("model"),
    status: z.enum(["not-started", "completed", "failed", "cancelled", "timed-out"]),
    response,
    requests: count,
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
    effects: z.enum(["none", "observed", "unknown"]),
  }),
]);
export type HookHandlerFacts = z.infer<typeof hookHandlerFactsSchema>;
export const hookSourceIdentitySchema = z.strictObject({
  owner: digestSchema,
  contribution: digestSchema,
});
export const hookFailureEvidenceSchema = z.strictObject({
  point: hookPointSchema,
  sourceIdentity: hookSourceIdentitySchema.nullable(),
  source: z.enum(HOOK_SOURCE_ORDER),
  handler: z.enum([
    "builtin",
    "external-command-v1",
    "http-v1",
    "mcp-tool-v1",
    "prompt-evaluator-v1",
    "agent-evaluator-v1",
  ]),
  health: hookHealthSnapshotSchema,
  handlerFacts: hookHandlerFactsSchema.nullable(),
  diagnosticPolicy: z.literal("facts-only"),
  remediation: z.enum([
    "none",
    "inspect-handler",
    "reactivate-validated-source",
    "inspect-cleanup",
    "restore-audit-store",
  ]),
});
export type HookFailureEvidence = z.infer<typeof hookFailureEvidenceSchema>;

const FAILURE_CODES = new Set([
  "cancelled",
  "revoked",
  "owner-cancelled",
  "timed-out",
  "threw",
  "invalid-hook-decision",
  "hook-execution-profile-unavailable",
  "hook-root-unavailable",
  "hook-entrypoint-missing",
  "hook-path-invalid",
  "hook-package-changed",
  "hook-authority-stale",
  "hook-process-unavailable",
  "hook-cleanup-uncertain",
  "hook-process-cancelled",
  "hook-process-timed-out",
  "hook-process-overflow",
  "hook-process-capture-exceeded",
  "hook-process-uncertain",
  "hook-process-exit",
  "hook-output-exhausted",
  "invalid-hook-response",
  "hook-activation-unavailable",
  "hook-admission-failed",
  "hook-admission-refused",
  "hook-admission-cancelled",
  "hook-resources-unavailable",
  "hook-quarantined",
  "hook-health-unavailable",
  "hook-observer-unavailable",
  "hook-plan-unavailable",
  "hook-audit-unavailable",
  "hook-envelope-mismatch",
  "hook-input-too-large",
  "invalid-hook-envelope",
  "invalid-handler-evidence",
  "hook-transport-failed",
  "hook-handler-refused",
]);
export function safeHookFailureCode(value: unknown): string {
  return typeof value === "string" && FAILURE_CODES.has(value) ? value : "hook-handler-failed";
}
