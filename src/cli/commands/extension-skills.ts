/** `falryn extension skills`: the source-bound skill usage diagnostic (#1191). */
import { adoptForeignError } from "../../application/diagnostics/index.ts";
import {
  querySkillUsage,
  type SkillUsageQuery,
  type SkillUsageReport,
  skillUsageQuerySchema,
} from "../../application/extensions/skill-usage.ts";
import { createRecordRepositories, createSqliteEventStore } from "../../data/index.ts";
import {
  recoveryForEffect,
  workspaceId as workspaceIdCodec,
} from "../../domain/foundation/index.ts";
import { MAX_SESSION_CATALOG } from "../../domain/sessions/index.ts";
import { primaryWorkspaceRoot } from "../../domain/workspace/index.ts";
import type { CommandResultOf } from "../output/result.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { resultFor } from "./shared.ts";
import { openSessionStore } from "./storage.ts";

export const extensionSkillsArgumentsSchema = skillUsageQuerySchema;
export type ExtensionSkillsArguments = SkillUsageQuery;
export type ExtensionSkillsPayload = SkillUsageReport;

export async function runExtensionSkills(
  services: ServiceProvider,
  query: ExtensionSkillsArguments,
  signal = new AbortController().signal,
): Promise<CommandResultOf<"extension.skills", ExtensionSkillsPayload>> {
  const payload = await inspect(services, query, signal);
  const errors =
    payload.status === "failed"
      ? [
          adoptForeignError(
            {
              code: payload.code,
              category: "configuration",
              message:
                payload.code === "cursor-invalid"
                  ? "The continuation belongs to a different query. Repeat the query without it."
                  : "Skill usage could not be read for this workspace. Check the session and retry.",
            },
            { operation: "extension skills" },
          ),
        ]
      : [];
  return resultFor(
    "extension.skills",
    payload,
    errors.map((error) => ({ ...error, effect: "none", recovery: recoveryForEffect("none") })),
    signal.aborted ? { kind: "cancelled", effect: "none" } : undefined,
    { intent: "none", observed: "none" },
  );
}

async function inspect(
  services: ServiceProvider,
  query: ExtensionSkillsArguments,
  signal: AbortSignal,
): Promise<ExtensionSkillsPayload> {
  const workspace = await services().ensureWorkspaceSet(signal);
  if (!workspace.ok) return { status: "failed", code: "sessions-unavailable" };
  const workspaceId = String(primaryWorkspaceRoot(workspace.value.set).rootId);
  const opened = await openSessionStore(services, signal);
  if (!opened.ok) return { status: "failed", code: "sessions-unavailable" };
  // No local state yet: nothing was ever admitted, which the report says rather than zero.
  if (opened.kind === "absent")
    return querySkillUsage(
      {
        workspaceId,
        events: { readFrom: async () => ({ ok: true, value: [] }) },
        sessions: () => ({ sessions: [], truncated: false }),
      },
      query,
      signal,
    );
  try {
    const records = createRecordRepositories(opened.store).sessions;
    const events = createSqliteEventStore(opened.store);
    return await querySkillUsage(
      {
        workspaceId,
        events,
        sessions() {
          const listed = records.listByParent(
            workspaceIdCodec.from(workspaceId),
            MAX_SESSION_CATALOG + 1,
          );
          if (!listed.ok) return null;
          const owned = listed.value
            .filter((record) => String(record.workspaceId) === workspaceId)
            .map((record) => ({
              sessionId: String(record.sessionId),
              streamId: String(record.streamId),
            }));
          // Child, workflow and scheduled admissions live in streams no session record
          // lists (#1192); each is read as its own session so its scope stays its own.
          const admissions = events.admissionStreams(workspaceId, MAX_SESSION_CATALOG + 1);
          if (!admissions.ok) return null;
          const listedStreams = new Set(owned.map((session) => session.streamId));
          const all = [
            ...owned,
            ...admissions.value
              .filter((stream) => !listedStreams.has(String(stream.streamId)))
              .map((stream) => ({
                sessionId: stream.sessionId,
                streamId: String(stream.streamId),
              })),
          ];
          return {
            sessions: all.slice(0, MAX_SESSION_CATALOG),
            truncated:
              all.length > MAX_SESSION_CATALOG || admissions.value.length > MAX_SESSION_CATALOG,
          };
        },
      },
      query,
      signal,
    );
  } finally {
    // A read-only query changed nothing, so a failed close cannot alter its result.
    await opened.store.close();
  }
}
