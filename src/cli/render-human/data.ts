/** Human projections for local backup, retention, and garbage collection. */

import type {
  DataBackupPayload,
  DataDiagnosticsPayload,
  DataInspectPayload,
  DataRestorePayload,
} from "../data-backup-commands.ts";
import type { DataGcPayload, DataRetentionPayload } from "../data-retention-gc-commands.ts";
import type { RenderedPayload } from "./payload.ts";
import { paint, type Session } from "./session.ts";
import { safe } from "./text.ts";

export function renderDataBackup(
  session: Session,
  payload: DataBackupPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No backup result is available."], diagnostics: [] };
  }
  return {
    lines: [
      paint(session, "plain", "Backup written"),
      `  Name            ${safe(payload.name)}`,
      `  File            ${safe(payload.fileName)}`,
      `  Schema version  ${payload.schemaVersion}`,
    ],
    diagnostics: [],
  };
}

export function renderDataInspect(
  session: Session,
  payload: DataInspectPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No backup inspection is available."], diagnostics: [] };
  }
  return {
    lines: [
      paint(session, "plain", "Backup inspection"),
      `  Name            ${safe(payload.name)}`,
      `  File            ${safe(payload.fileName)}`,
      `  Schema version  ${payload.schemaVersion}`,
      `  Bytes           ${payload.byteLength}`,
    ],
    diagnostics: [
      "Inspecting a backup never upgrades it. For environment and root viability, use `falryn doctor`.",
    ],
  };
}

export function renderDataRestore(
  session: Session,
  payload: DataRestorePayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No restore result is available."], diagnostics: [] };
  }
  const lines = [
    paint(
      session,
      "plain",
      payload.confirmation === "applied" ? "Restore completed" : "Restore preview",
    ),
    `  Name            ${safe(payload.name)}`,
    `  File            ${safe(payload.fileName)}`,
    `  Schema version  ${payload.schemaVersion}`,
    `  Confirmation    ${payload.confirmation}`,
  ];
  const diagnostics =
    payload.confirmation === "not-requested"
      ? [
          `Preview only. Re-run with --confirm ${safe(payload.name)} to replace the live database.`,
          "Restore renames the live database to falryn.sqlite.previous when a previous file is not already there.",
          "For environment and root viability, use `falryn doctor`.",
        ]
      : ["Local database facts only. For environment and root viability, use `falryn doctor`."];
  return { lines, diagnostics };
}

export function renderDataDiagnostics(
  session: Session,
  payload: DataDiagnosticsPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No local diagnostics are available."], diagnostics: [] };
  }
  const lines = [
    paint(session, "plain", "Local data diagnostics"),
    `  Schema version  ${payload.schemaVersion}`,
    `  WAL present     ${payload.crashSignals.writeAheadLogPresent ? "yes" : "no"}`,
    `  SHM present     ${payload.crashSignals.sharedMemoryPresent ? "yes" : "no"}`,
  ];
  if (payload.sweep !== null) {
    lines.push(
      `  Sweep examined  ${payload.sweep.examined}`,
      `  Sweep deleted   ${payload.sweep.deleted}`,
      `  Sweep failed    ${payload.sweep.failed}`,
      `  Sweep complete  ${safe(payload.sweep.completeness)}`,
    );
  }
  return {
    lines,
    diagnostics: [
      "Facts about the open database on this machine. Not a support bundle and not sent anywhere.",
      "For roots, permissions, and storage viability without opening data, use `falryn doctor`.",
    ],
  };
}

export function renderDataRetention(
  session: Session,
  payload: DataRetentionPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No retention report is available."], diagnostics: [] };
  }
  const lines = [
    paint(session, "plain", "Local data retention"),
    `  Total bytes     ${payload.report.totalBytes}`,
    `  Total items     ${payload.report.totalItems}`,
    `  Total pressure  ${safe(payload.report.totalPressure)}`,
    "  Classes",
  ];
  for (const usage of payload.report.classes) {
    const pressure = payload.report.pressure.find(
      (entry) => entry.ownershipClass === usage.ownershipClass,
    );
    lines.push(
      `    ${safe(usage.ownershipClass)}  ${usage.byteCount} bytes  ${usage.itemCount} items  bytes=${safe(pressure?.bytes ?? "unmeasured")}  items=${safe(pressure?.items ?? "unmeasured")}  (${usage.completeness})`,
    );
  }
  if (payload.report.unregistered.length > 0) {
    lines.push(`  Unregistered    ${payload.report.unregistered.map(safe).join(", ")}`);
  }
  return {
    lines,
    diagnostics: [
      "Reporting only. Nothing here deletes bytes. Reachability garbage collection is `falryn data gc`.",
    ],
  };
}

export function renderDataGc(session: Session, payload: DataGcPayload | null): RenderedPayload {
  if (payload === null) {
    return { lines: ["No reachability garbage-collection plan is available."], diagnostics: [] };
  }
  const lines = [
    paint(session, "plain", "Reachability garbage collection"),
    `  Plan identity   ${safe(payload.plan.planId)}`,
    `  Examined        ${payload.plan.examinedSessions} sessions, ${payload.plan.examinedArtifacts} artifacts (${payload.plan.completeness})`,
    `  Candidates      ${payload.plan.candidateSessions} sessions, ${payload.plan.candidateArtifacts} artifacts, ${payload.plan.candidateBytes} bytes`,
    `  Confirmation    ${safe(payload.confirmation)}`,
  ];
  if (payload.confirmation === "applied") {
    lines.push(
      `  Deleted         ${payload.deletedSessions ?? 0} sessions, ${payload.deletedArtifacts ?? 0} artifacts, ${payload.deletedBytes ?? 0} bytes`,
      `  Failed          ${payload.failed ?? 0}`,
    );
  }
  if (payload.plan.candidates.length > 0) {
    lines.push("  Candidate list");
    for (const candidate of payload.plan.candidates.slice(0, 16)) {
      lines.push(
        `    ${safe(candidate.kind)}  ${safe(candidate.identity)}  ${candidate.byteCount} bytes`,
      );
    }
    if (payload.plan.candidates.length > 16) {
      lines.push(`    … ${payload.plan.candidates.length - 16} more`);
    }
  }
  if (payload.plan.omissions.length > 0) {
    lines.push("  Omissions");
    for (const omission of payload.plan.omissions.slice(0, 8)) {
      lines.push(
        `    ${safe(omission.kind)}  ${safe(omission.identity)}  ${safe(omission.reason)}`,
      );
    }
  }
  return {
    lines,
    diagnostics:
      payload.confirmation === "not-requested"
        ? [
            "Preview only. Re-run with `--confirm <plan-id>` to apply this exact plan.",
            "Pin retained sessions with `--pinned-session <id>` when they are not already open or export seeds.",
          ]
        : [],
  };
}
