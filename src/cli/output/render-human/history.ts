/** Human projections for export, replay, sessions, and retained artifacts. */

import { extensionCatalogLines } from "../../../application/extensions/catalog-report.ts";
import type { CatalogHistory } from "../../../domain/extensions/catalog-history.ts";
import type {
  ImportCommandPayload,
  ReplayCommandPayload,
} from "../../commands/import-replay-commands.ts";
import type {
  ArtifactGetPayload,
  ArtifactListPayload,
  ArtifactShowPayload,
  ExportCommandPayload,
  SessionListPayload,
  SessionShowPayload,
} from "../../commands.ts";
import type {
  SessionForkPayload,
  SessionReplayPayload,
  SessionResumePayload,
} from "../../runtime/session-navigation.ts";
import type { RenderedPayload } from "./payload.ts";
import { paint, type Session } from "./session.ts";
import { safe } from "./text.ts";

function historicalCatalogLines(history: CatalogHistory | undefined): readonly string[] {
  if (history === undefined) return [];
  return [
    `  Extensions   historical; ${history.total} descriptors; ${history.omitted} omitted; no native execution`,
    `  Catalog      ${history.catalog}; generation ${history.generation}`,
    ...history.entries.map(
      (entry) =>
        `    ${safe(entry.contribution.nativeKind)} ${safe(entry.contribution.localId)}; ${entry.wasEnabled ? "was enabled" : "was disabled"}; ${safe(entry.reason)}; owner ${safe(entry.contribution.owner.digest)}`,
    ),
  ];
}

export function renderExport(
  session: Session,
  payload: ExportCommandPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No export inventory is available."], diagnostics: [] };
  }

  const lines = [
    paint(session, "plain", payload.mode === "preview" ? "Export preview" : "Export written"),
    `  Selection     ${safe(payload.selection.kind)}  ${payload.selection.sessions} sessions` +
      (payload.selection.includesSensitive ? "  includes-sensitive" : ""),
    `  Sessions      ${payload.sessionIds.map(safe).join(", ") || "(none)"}`,
    `  Counts        sessions=${payload.counts.sessions} turns=${payload.counts.turns} events=${payload.counts.events} artifacts=${payload.counts.artifacts}`,
    `  Artifact bytes ${payload.artifactBytes}`,
  ];
  if (payload.omissions.length > 0) {
    lines.push("  Omissions");
    for (const omission of payload.omissions) {
      lines.push(`    ${safe(omission.artifactId)}  ${safe(omission.reason)}`);
    }
  }
  if (payload.redactions.length > 0) {
    lines.push("  Redactions");
    for (const redaction of payload.redactions) {
      lines.push(`    ${safe(redaction.path)}  ${safe(redaction.kind)}`);
    }
  }
  if (payload.bundle !== null) {
    lines.push(`  Bundle        ${safe(payload.bundle.name)}`);
    lines.push(`  Path          ${safe(payload.bundle.path)}`);
    lines.push(`  Bytes         ${payload.bundle.byteLength}`);
    if (payload.bundle.cancelledAfterFinalize) {
      lines.push("  Note          cancelled after the package was published");
    }
  }

  const diagnostics =
    payload.mode === "preview"
      ? ["Preview only. Re-run with --write --name <name> to create this package."]
      : [];
  return { lines, diagnostics };
}

export function renderImport(
  session: Session,
  payload: ImportCommandPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No import result is available."], diagnostics: [] };
  }
  return {
    lines: [
      paint(session, "plain", "Import completed"),
      `  Package      ${safe(payload.name)}`,
      `  Sessions     ${payload.sessionIds.map(safe).join(", ") || "(none)"}`,
      `  Events       ${payload.events}`,
      `  Artifacts    ${payload.artifacts}`,
    ],
    diagnostics: [],
  };
}

export function renderReplay(
  session: Session,
  payload: ReplayCommandPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No replay rebuild is available."], diagnostics: [] };
  }
  return {
    lines: [
      paint(session, "plain", "Replay rebuild (effect-free)"),
      `  Identity     ${safe(payload.sessionId)}`,
      `  Stream       ${safe(payload.streamId)}`,
      `  Turns        ${payload.turnCount}`,
      `  Artifacts    ${payload.artifactCount}`,
      ...(payload.packageData ?? []).map(
        (bundle) =>
          `  Package data ${safe(bundle.packageId)}: ${bundle.records.length} inert records, ${bundle.omitted} omitted; import ${safe(bundle.importId)}`,
      ),
      ...(payload.truncated ? ["  Note         truncated; widen the read bound to see more"] : []),
    ],
    diagnostics: [
      "Rebuilds from stored facts only. For cursor control over recorded events, use `falryn session replay`.",
    ],
  };
}

export function renderSessionList(
  session: Session,
  payload: SessionListPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No session catalog is available."], diagnostics: [] };
  }
  if (payload.sessions.length === 0) {
    return { lines: ["No sessions."], diagnostics: [] };
  }
  const lines = [
    paint(session, "plain", `Sessions (${payload.filter})`),
    ...payload.sessions.map((entry) => {
      const title = entry.title === null ? "(untitled)" : safe(entry.title);
      const pin = entry.pinned ? "  pinned" : "";
      const closed = entry.closedAt === null ? "open" : "closed";
      return `  ${safe(entry.sessionId)}  ${closed}${pin}  ${title}`;
    }),
  ];
  return { lines, diagnostics: [] };
}

export function renderSessionShow(
  session: Session,
  payload: SessionShowPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No session is available."], diagnostics: [] };
  }
  const entry = payload.session;
  const title = entry.title === null ? "(untitled)" : safe(entry.title);
  return {
    lines: [
      paint(session, "plain", "Session"),
      `  Identity     ${safe(entry.sessionId)}`,
      `  Workspace    ${safe(payload.workspaceId)}`,
      `  Title        ${title}`,
      `  Pinned       ${entry.pinned ? "yes" : "no"}`,
      `  Started      ${safe(entry.startedAt)}`,
      `  Closed       ${entry.closedAt === null ? "(open)" : safe(entry.closedAt)}`,
      ...historicalCatalogLines(payload.extensionCatalog),
      ...(payload.history === undefined
        ? []
        : !payload.history.ok
          ? ["  History unavailable"]
          : [
              ...payload.history.items.map(
                (item) =>
                  `  ${item.event?.sequence ?? "-"} ${safe(item.event?.kind ?? "withheld")} [${item.availability}]${item.text === null ? "" : ` ${safe(item.text)}`}`,
              ),
              ...(payload.history.next === null
                ? []
                : [
                    `  More: falryn session show ${safe(entry.sessionId)} --workspace-id ${safe(payload.workspaceId)} --after-sequence ${payload.history.next}`,
                  ]),
            ]),
    ],
    diagnostics: [],
  };
}

export function renderSessionResume(
  session: Session,
  payload: SessionResumePayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No session resume plan is available."], diagnostics: [] };
  }
  return {
    lines: [
      paint(session, "plain", "Session resume"),
      `  Identity     ${safe(payload.sessionId)}`,
      `  Workspace    ${safe(payload.workspaceId)}`,
      `  Stream       ${safe(payload.streamId)}`,
      `  After        ${payload.afterSequence === null ? "(start)" : String(payload.afterSequence)}`,
      `  Pending      ${payload.pending}`,
      ...historicalCatalogLines(payload.extensionCatalog),
      ...(payload.currentExtensions === undefined
        ? []
        : ["  Current Extensions", ...extensionCatalogLines(payload.currentExtensions).map(safe)]),
    ],
    diagnostics: [],
  };
}

export function renderSessionFork(
  session: Session,
  payload: SessionForkPayload | null,
  command: "session.fork" | "session.rewind",
): RenderedPayload {
  if (payload === null) {
    return {
      lines: [`No session ${command === "session.fork" ? "fork" : "rewind"} is available.`],
      diagnostics: [],
    };
  }
  return {
    lines: [
      paint(session, "plain", command === "session.fork" ? "Session fork" : "Session rewind"),
      `  Source       ${safe(payload.sourceSessionId)}`,
      `  New session  ${safe(payload.sessionId)}`,
      `  Stream       ${safe(payload.streamId)}`,
      `  Workspace    ${safe(payload.workspaceId)}`,
      ...(payload.atTurnId === null ? [] : [`  At turn      ${safe(payload.atTurnId)}`]),
      ...historicalCatalogLines(payload.extensionCatalog),
    ],
    diagnostics: [],
  };
}

export function renderSessionReplay(
  session: Session,
  payload: SessionReplayPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No session replay state is available."], diagnostics: [] };
  }
  return {
    lines: [
      paint(session, "plain", "Session replay (effect-free)"),
      `  Identity     ${safe(payload.sessionId)}`,
      `  Workspace    ${safe(payload.workspaceId)}`,
      `  Status       ${safe(payload.status)}`,
      `  At sequence  ${payload.atSequence === null ? "(none)" : String(payload.atSequence)}`,
      `  Applied      ${payload.applied}`,
      ...historicalCatalogLines(payload.extensionCatalog),
    ],
    diagnostics: [],
  };
}

export function renderArtifactList(
  session: Session,
  payload: ArtifactListPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No artifact catalog is available."], diagnostics: [] };
  }
  if (payload.artifacts.length === 0) {
    return { lines: ["No artifacts."], diagnostics: [] };
  }
  const lines = [
    paint(session, "plain", "Artifacts"),
    ...payload.artifacts.map(
      (entry) =>
        `  ${safe(entry.artifactId)}  ${safe(entry.availability)}  ${safe(entry.mediaType)}  ${entry.byteLength} bytes`,
    ),
  ];
  return { lines, diagnostics: [] };
}

export function renderArtifactShow(
  session: Session,
  payload: ArtifactShowPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No artifact is available."], diagnostics: [] };
  }
  const record = payload.lineage.record;
  return {
    lines: [
      paint(session, "plain", "Artifact"),
      `  Identity     ${safe(record.artifactId)}`,
      `  Media type   ${safe(record.mediaType)}`,
      `  Bytes        ${record.byteLength}`,
      `  Availability ${safe(record.availability)}`,
      `  Sensitivity  ${safe(record.sensitivity)}`,
      `  Parents      ${payload.lineage.parents.length}`,
      `  Children     ${payload.lineage.children.length}`,
    ],
    diagnostics: [],
  };
}

export function renderArtifactGet(
  session: Session,
  payload: ArtifactGetPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No artifact retrieval is available."], diagnostics: [] };
  }
  const destination =
    payload.destination === "stdout"
      ? "stdout"
      : payload.path === null
        ? "file"
        : safe(payload.path);
  return {
    lines: [
      paint(session, "plain", "Artifact retrieved"),
      `  Identity     ${safe(payload.artifactId)}`,
      `  Destination  ${destination}`,
      `  Bytes        ${payload.bytesWritten}`,
    ],
    diagnostics:
      payload.destination === "stdout"
        ? ["Artifact bytes were written to stdout; this summary is on stderr."]
        : [],
  };
}
