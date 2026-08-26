/**
 * The command surfaces this build can honestly ship.
 *
 * `config` inspects without publishing a durable generation. `doctor` describes
 * roots without creating them. `data` previews a removal and mutates only when
 * the exact plan identity is confirmed. `export` previews a selection by default
 * and writes a package only with `--write`.
 *
 * None of them render anything. Each returns a `CommandResult` and #18/#19 turn
 * it into text.
 */

import { assertNever, effectOf, type TerminalOutcome } from "../domain/index.ts";
import type { CodingRunPayload, runCoding } from "./coding-run.ts";
import type {
  ArtifactGetPayload,
  ArtifactListPayload,
  ArtifactShowPayload,
  runArtifactGet,
  runArtifactList,
  runArtifactShow,
} from "./commands/artifact.ts";
import type {
  ConfigPathPayload,
  ConfigSetPayload,
  ConfigShowPayload,
  ConfigValidatePayload,
  runConfigPath,
  runConfigSet,
  runConfigShow,
  runConfigValidate,
} from "./commands/config.ts";
import type { DataRemovalPayload } from "./commands/data-removal.ts";
import type { DoctorPayload, runDoctor } from "./commands/doctor.ts";
import type { ExportCommandPayload, runExport } from "./commands/export.ts";
import type { ProviderCommandPayload, runProvider } from "./commands/provider.ts";
import type {
  runSessionList,
  runSessionShow,
  SessionListPayload,
  SessionShowPayload,
} from "./commands/session.ts";
import { resultFor } from "./commands/shared.ts";
import type {
  runWorkspaceList,
  runWorkspaceLoad,
  runWorkspaceSave,
  runWorkspaceShow,
  WorkspaceListPayload,
  WorkspaceSavePayload,
  WorkspaceSetPayload,
} from "./commands/workspace.ts";
import type {
  DataBackupPayload,
  DataDiagnosticsPayload,
  DataInspectPayload,
  DataRestorePayload,
} from "./data-backup-commands.ts";
import type { DataGcPayload, DataRetentionPayload } from "./data-retention-gc-commands.ts";
import type { runImport, runReplay } from "./import-replay-commands.ts";
import type { CommandEffect, CommandId, CommandResultOf } from "./result.ts";
import type {
  runSessionForkOrRewind,
  runSessionReplay,
  runSessionResume,
} from "./session-navigation.ts";
import type { TaskCommitPlanPayload } from "./task-commit-plan-commands.ts";
import type {
  runTaskDecompose,
  runTaskProgress,
  runTaskValidate,
} from "./task-intelligence-commands.ts";

export { type CodingRunArguments, type CodingRunPayload, runCoding } from "./coding-run.ts";
export {
  type ArtifactCommandExtras,
  type ArtifactGetPayload,
  type ArtifactListPayload,
  type ArtifactShowPayload,
  type ArtifactStdoutDelivery,
  runArtifactGet,
  runArtifactList,
  runArtifactShow,
} from "./commands/artifact.ts";
export {
  type ConfigPathPayload,
  type ConfigSetPayload,
  type ConfigShowPayload,
  type ConfigValidatePayload,
  runConfigPath,
  runConfigSet,
  runConfigShow,
  runConfigValidate,
} from "./commands/config.ts";
export {
  type DataRemovalPayload,
  runDataReset,
  runDataUninstall,
} from "./commands/data-removal.ts";
export { type DoctorPayload, type DoctorStorage, runDoctor } from "./commands/doctor.ts";
export { type ExportCommandPayload, runExport } from "./commands/export.ts";
export { type ProviderCommandPayload, runProvider } from "./commands/provider.ts";
export {
  runSessionList,
  runSessionShow,
  type SessionListPayload,
  type SessionShowPayload,
} from "./commands/session.ts";
export {
  runWorkspaceList,
  runWorkspaceLoad,
  runWorkspaceSave,
  runWorkspaceShow,
  type WorkspaceListPayload,
  type WorkspaceRootPayload,
  type WorkspaceSavePayload,
  type WorkspaceSetPayload,
} from "./commands/workspace.ts";

export function stoppedResult(
  command: Exclude<CommandId, "default" | "help" | "version">,
  outcome: TerminalOutcome,
  intent: CommandEffect["intent"] = "none",
): RunCommandResult {
  // The caller supplies the command's declared intent; this records what the
  // scope observed. A preview is still non-mutating when it is interrupted,
  // while a confirmed removal that was interrupted must admit it may have
  // changed data.
  const effect: CommandEffect = { intent, observed: effectOf(outcome) };

  switch (command) {
    case "config.show":
      return resultFor<"config.show", ConfigShowPayload>("config.show", null, [], outcome, effect);
    case "config.validate":
      return resultFor<"config.validate", ConfigValidatePayload>(
        "config.validate",
        null,
        [],
        outcome,
        effect,
      );
    case "config.path":
      return resultFor<"config.path", ConfigPathPayload>("config.path", null, [], outcome, effect);
    case "config.set":
      return resultFor<"config.set", ConfigSetPayload>("config.set", null, [], outcome, effect);
    case "data.reset":
      return resultFor<"data.reset", DataRemovalPayload>("data.reset", null, [], outcome, effect);
    case "data.uninstall":
      return resultFor<"data.uninstall", DataRemovalPayload>(
        "data.uninstall",
        null,
        [],
        outcome,
        effect,
      );
    case "data.backup":
      return resultFor("data.backup", null, [], outcome, effect);
    case "data.restore":
      return resultFor("data.restore", null, [], outcome, effect);
    case "data.inspect":
      return resultFor("data.inspect", null, [], outcome, effect);
    case "data.diagnostics":
      return resultFor("data.diagnostics", null, [], outcome, effect);
    case "data.retention":
      return resultFor("data.retention", null, [], outcome, effect);
    case "data.gc":
      return resultFor("data.gc", null, [], outcome, effect);
    case "doctor":
      return resultFor<"doctor", DoctorPayload>("doctor", null, [], outcome, effect);
    case "export":
      return resultFor<"export", ExportCommandPayload>("export", null, [], outcome, effect);
    case "import":
      return resultFor("import", null, [], outcome, effect);
    case "replay":
      return resultFor("replay", null, [], outcome, effect);
    case "task.decompose":
      return resultFor("task.decompose", null, [], outcome, effect);
    case "task.validate":
      return resultFor("task.validate", null, [], outcome, effect);
    case "task.progress":
      return resultFor("task.progress", null, [], outcome, effect);
    case "task.commit-plan":
      return resultFor("task.commit-plan", null, [], outcome, effect);
    case "session.list":
      return resultFor<"session.list", SessionListPayload>(
        "session.list",
        null,
        [],
        outcome,
        effect,
      );
    case "session.show":
      return resultFor<"session.show", SessionShowPayload>(
        "session.show",
        null,
        [],
        outcome,
        effect,
      );
    case "session.resume":
      return resultFor("session.resume", null, [], outcome, effect);
    case "session.fork":
      return resultFor("session.fork", null, [], outcome, effect);
    case "session.rewind":
      return resultFor("session.rewind", null, [], outcome, effect);
    case "session.replay":
      return resultFor("session.replay", null, [], outcome, effect);
    case "artifact.list":
      return resultFor<"artifact.list", ArtifactListPayload>(
        "artifact.list",
        null,
        [],
        outcome,
        effect,
      );
    case "artifact.show":
      return resultFor<"artifact.show", ArtifactShowPayload>(
        "artifact.show",
        null,
        [],
        outcome,
        effect,
      );
    case "artifact.get":
      return resultFor<"artifact.get", ArtifactGetPayload>(
        "artifact.get",
        null,
        [],
        outcome,
        effect,
      );
    case "workspace.list":
      return resultFor<"workspace.list", WorkspaceListPayload>(
        "workspace.list",
        null,
        [],
        outcome,
        effect,
      );
    case "workspace.show":
      return resultFor<"workspace.show", WorkspaceSetPayload>(
        "workspace.show",
        null,
        [],
        outcome,
        effect,
      );
    case "workspace.save":
      return resultFor<"workspace.save", WorkspaceSavePayload>(
        "workspace.save",
        null,
        [],
        outcome,
        effect,
      );
    case "workspace.load":
      return resultFor<"workspace.load", WorkspaceSetPayload>(
        "workspace.load",
        null,
        [],
        outcome,
        effect,
      );
    case "provider":
      return resultFor<"provider", ProviderCommandPayload>("provider", null, [], outcome, effect);
    case "run":
      return resultFor<"run", CodingRunPayload>("run", null, [], outcome, effect);
    case "completion":
      throw new Error("completion is handled before services are constructed.");
    default:
      // A command added without a branch fails to compile here rather than
      // reporting a stopped run under someone else's command identity.
      return assertNever(command, "unhandled command");
  }
}

/* -------------------------------------------------------------------------- */
/* The result surface a projection renders                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every result a command that does work can produce.
 *
 * Discriminated by `command`, so a projection switching on it reads the payload
 * that command actually declared instead of an `unknown` it has to re-check at
 * runtime. `default`, `help`, and `version` are absent because they answer with
 * text rather than a result — dispatch resolves them before any command runs.
 */
export type RunCommandResult =
  | Awaited<ReturnType<typeof runConfigShow>>
  | Awaited<ReturnType<typeof runConfigValidate>>
  | Awaited<ReturnType<typeof runConfigPath>>
  | Awaited<ReturnType<typeof runConfigSet>>
  | CommandResultOf<"data.reset", DataRemovalPayload>
  | CommandResultOf<"data.uninstall", DataRemovalPayload>
  | CommandResultOf<"data.backup", DataBackupPayload>
  | CommandResultOf<"data.restore", DataRestorePayload>
  | CommandResultOf<"data.inspect", DataInspectPayload>
  | CommandResultOf<"data.diagnostics", DataDiagnosticsPayload>
  | CommandResultOf<"data.retention", DataRetentionPayload>
  | CommandResultOf<"data.gc", DataGcPayload>
  | Awaited<ReturnType<typeof runDoctor>>
  | Awaited<ReturnType<typeof runExport>>
  | Awaited<ReturnType<typeof runImport>>
  | Awaited<ReturnType<typeof runReplay>>
  | Awaited<ReturnType<typeof runTaskDecompose>>
  | Awaited<ReturnType<typeof runTaskValidate>>
  | Awaited<ReturnType<typeof runTaskProgress>>
  | CommandResultOf<"task.commit-plan", TaskCommitPlanPayload>
  | Awaited<ReturnType<typeof runSessionList>>
  | Awaited<ReturnType<typeof runSessionShow>>
  | Awaited<ReturnType<typeof runSessionResume>>
  | Awaited<ReturnType<typeof runSessionForkOrRewind>>
  | Awaited<ReturnType<typeof runSessionReplay>>
  | Awaited<ReturnType<typeof runArtifactList>>
  | Awaited<ReturnType<typeof runArtifactShow>>
  | Awaited<ReturnType<typeof runArtifactGet>>
  | Awaited<ReturnType<typeof runWorkspaceList>>
  | Awaited<ReturnType<typeof runWorkspaceShow>>
  | Awaited<ReturnType<typeof runWorkspaceSave>>
  | Awaited<ReturnType<typeof runWorkspaceLoad>>
  | Awaited<ReturnType<typeof runProvider>>
  | Awaited<ReturnType<typeof runCoding>>;
