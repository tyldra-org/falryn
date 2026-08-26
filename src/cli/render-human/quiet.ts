/** Primary-result projection for quiet CLI output. */

import { assertNever } from "../../domain/index.ts";
import type { DataRemovalPayload, ExportCommandPayload, RunCommandResult } from "../commands.ts";
import type {
  DataBackupPayload,
  DataDiagnosticsPayload,
  DataInspectPayload,
  DataRestorePayload,
} from "../data-backup-commands.ts";
import type { DataGcPayload, DataRetentionPayload } from "../data-retention-gc-commands.ts";
import type { ImportCommandPayload, ReplayCommandPayload } from "../import-replay-commands.ts";
import type { TaskCommitPlanPayload } from "../task-commit-plan-commands.ts";
import type {
  TaskDecomposePayload,
  TaskProgressPayload,
  TaskValidatePayload,
} from "../task-intelligence-commands.ts";
import { displayValue, safe } from "./text.ts";

export function quietResultLines(result: RunCommandResult): readonly string[] {
  switch (result.command) {
    case "config.show":
      return result.payload === null
        ? []
        : result.payload.inspection.values
            .filter((value) => value.value !== null)
            .map((value) => `${value.path}=${displayValue(value.value)}`);
    case "config.path":
      return result.payload === null
        ? []
        : result.payload.sources.map((source) => safe(source.path));
    case "config.set":
      return result.payload === null
        ? []
        : [`${result.payload.keyPath}=${safe(result.payload.path)}`];
    case "data.reset":
    case "data.uninstall":
      return quietDataLines(result.payload);
    case "data.backup":
      return quietDataBackupLines(result.payload);
    case "data.restore":
      return quietDataRestoreLines(result.payload);
    case "data.inspect":
      return quietDataInspectLines(result.payload);
    case "data.diagnostics":
      return quietDataDiagnosticsLines(result.payload);
    case "data.retention":
      return quietDataRetentionLines(result.payload);
    case "data.gc":
      return quietDataGcLines(result.payload);
    case "config.validate":
    case "doctor":
      return [];
    case "export":
      return quietExportLines(result.payload);
    case "import":
      return quietImportLines(result.payload);
    case "replay":
      return quietReplayLines(result.payload);
    case "task.decompose":
      return quietTaskDecomposeLines(result.payload);
    case "task.validate":
      return quietTaskValidateLines(result.payload);
    case "task.progress":
      return quietTaskProgressLines(result.payload);
    case "task.commit-plan":
      return quietTaskCommitPlanLines(result.payload);
    case "session.list":
      return result.payload === null
        ? []
        : result.payload.sessions.map((entry) => safe(entry.sessionId));
    case "session.show":
      return result.payload === null ? [] : [safe(result.payload.session.sessionId)];
    case "session.resume":
      return result.payload === null ? [] : [safe(result.payload.sessionId)];
    case "session.fork":
    case "session.rewind":
      return result.payload === null ? [] : [safe(result.payload.sessionId)];
    case "session.replay":
      return result.payload === null
        ? []
        : [`${safe(result.payload.sessionId)} ${safe(result.payload.status)}`];
    case "artifact.list":
      return result.payload === null
        ? []
        : result.payload.artifacts.map((entry) => safe(entry.artifactId));
    case "artifact.show":
      return result.payload === null ? [] : [safe(result.payload.lineage.record.artifactId)];
    case "artifact.get":
      return result.payload === null
        ? []
        : [
            [
              safe(result.payload.artifactId),
              result.payload.destination,
              result.payload.path === null ? "" : safe(result.payload.path),
              String(result.payload.bytesWritten),
            ].join("\t"),
          ];
    case "workspace.list":
      return result.payload === null
        ? []
        : result.payload.layouts.map((entry) => `${safe(entry.name)}\t${entry.rootCount}`);
    case "workspace.show":
    case "workspace.load":
      return result.payload === null
        ? []
        : result.payload.roots.map(
            (root) => `${safe(root.rootId)}\t${safe(root.name)}\t${safe(root.path)}`,
          );
    case "workspace.save":
      return result.payload === null
        ? []
        : [
            safe(result.payload.name),
            ...result.payload.roots.map(
              (root) => `${safe(root.rootId)}\t${safe(root.name)}\t${safe(root.path)}`,
            ),
          ];
    case "provider":
      return result.payload === null || result.payload.kind === "failed"
        ? []
        : result.payload.connections.map((connection) =>
            [
              connection.selected ? "*" : "-",
              safe(connection.profileId),
              safe(connection.providerId),
              connection.credentialConfigured ? "configured" : "unconfigured",
              connection.models.map(safe).join(","),
            ].join("\t"),
          );
    case "run":
      return result.payload === null
        ? []
        : [
            [
              safe(result.payload.stage),
              safe(result.payload.sessionId === "" ? "-" : result.payload.sessionId),
              result.payload.turnId === null ? "-" : safe(result.payload.turnId),
              String(result.payload.eventCount),
            ].join("\t"),
          ];
    default:
      return assertNever(result, "unhandled command result");
  }
}

function quietExportLines(payload: ExportCommandPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  if (payload.bundle !== null) {
    return [
      [
        payload.mode,
        safe(payload.bundle.name),
        safe(payload.bundle.path),
        String(payload.bundle.byteLength),
      ].join("\t"),
    ];
  }
  return payload.sessionIds.map((id) => safe(id));
}

function quietImportLines(payload: ImportCommandPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  return [
    [
      safe(payload.name),
      payload.sessionIds.map(safe).join(","),
      String(payload.events),
      String(payload.artifacts),
    ].join("\t"),
  ];
}

function quietReplayLines(payload: ReplayCommandPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  return [
    [
      safe(payload.sessionId),
      safe(payload.streamId),
      String(payload.turnCount),
      String(payload.artifactCount),
      payload.truncated ? "truncated" : "complete",
    ].join("\t"),
  ];
}

function quietTaskDecomposeLines(payload: TaskDecomposePayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  return payload.decomposition.tasks.map((task) =>
    [safe(task.taskId), safe(task.objective), safe(task.goal)].join("\t"),
  );
}

function quietTaskValidateLines(payload: TaskValidatePayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  return payload.advice.recommendations.map((recommendation) =>
    [safe(recommendation.taskId), safe(recommendation.kind), safe(recommendation.statement)].join(
      "\t",
    ),
  );
}

function quietTaskProgressLines(payload: TaskProgressPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  return payload.projection.nextActions.map((action) =>
    [safe(payload.projection.overall), safe(action.kind), safe(action.taskId)].join("\t"),
  );
}

function quietTaskCommitPlanLines(payload: TaskCommitPlanPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  return [
    [
      safe(payload.confirmation),
      safe(payload.confirmToken),
      String(payload.advice.plan.groups.length),
      String(payload.commits.length),
    ].join("\t"),
  ];
}

function quietDataLines(payload: DataRemovalPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  const plan = payload.plan.classes.flatMap((entry) =>
    entry.paths.length === 0
      ? [
          [
            safe(payload.plan.planId),
            safe(entry.ownershipClass),
            entry.action,
            String(entry.byteCount),
            String(entry.itemCount),
            "",
          ].join("\t"),
        ]
      : entry.paths.map((path) =>
          [
            safe(payload.plan.planId),
            safe(entry.ownershipClass),
            entry.action,
            String(entry.byteCount),
            String(entry.itemCount),
            safe(path),
          ].join("\t"),
        ),
  );
  if (payload.execution === null) {
    return plan;
  }
  return [
    ...plan,
    ...payload.execution.deleted.map((path) => `deleted\t${safe(path)}`),
    ...payload.execution.retained.map(
      (entry) => `retained\t${safe(entry.reason)}\t${safe(entry.path)}`,
    ),
    ...payload.execution.failed.map((entry) => `failed\t${safe(entry.code)}\t${safe(entry.path)}`),
  ];
}

function quietDataBackupLines(payload: DataBackupPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  return [[safe(payload.name), safe(payload.fileName), String(payload.schemaVersion)].join("\t")];
}

function quietDataInspectLines(payload: DataInspectPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  return [
    [
      safe(payload.name),
      safe(payload.fileName),
      String(payload.schemaVersion),
      String(payload.byteLength),
    ].join("\t"),
  ];
}

function quietDataRestoreLines(payload: DataRestorePayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  return [
    [
      safe(payload.name),
      safe(payload.fileName),
      String(payload.schemaVersion),
      payload.confirmation,
    ].join("\t"),
  ];
}

function quietDataDiagnosticsLines(payload: DataDiagnosticsPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  return [
    [
      String(payload.schemaVersion),
      payload.crashSignals.writeAheadLogPresent ? "wal" : "",
      payload.crashSignals.sharedMemoryPresent ? "shm" : "",
      payload.sweep === null ? "" : String(payload.sweep.examined),
    ].join("\t"),
  ];
}

function quietDataRetentionLines(payload: DataRetentionPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  return payload.report.classes.map((usage) =>
    [
      safe(usage.ownershipClass),
      String(usage.byteCount),
      String(usage.itemCount),
      usage.completeness,
    ].join("\t"),
  );
}

function quietDataGcLines(payload: DataGcPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  const header = [
    safe(payload.plan.planId),
    String(payload.plan.candidateSessions),
    String(payload.plan.candidateArtifacts),
    String(payload.plan.candidateBytes),
    payload.confirmation,
  ].join("\t");
  const rows = payload.plan.candidates.map((candidate) =>
    [candidate.kind, safe(candidate.identity), String(candidate.byteCount)].join("\t"),
  );
  return [header, ...rows];
}
