import { assertNever } from "../../domain/index.ts";
import type { Invocation, RunnableCommand } from "../command-tree.ts";
import {
  type RunCommandResult,
  runArtifactGet,
  runArtifactList,
  runArtifactShow,
  runCoding,
  runConfigPath,
  runConfigSet,
  runConfigShow,
  runConfigValidate,
  runDataReset,
  runDataUninstall,
  runDoctor,
  runExport,
  runProvider,
  runSessionList,
  runSessionShow,
  runWorkspaceList,
  runWorkspaceLoad,
  runWorkspaceSave,
  runWorkspaceShow,
} from "../commands.ts";
import {
  runDataBackup,
  runDataDiagnostics,
  runDataInspect,
  runDataRestore,
} from "../data-backup-commands.ts";
import { runDataGc, runDataRetention } from "../data-retention-gc-commands.ts";
import { runImport, runReplay } from "../import-replay-commands.ts";
import type { InvocationGovernance } from "../invocation-scope.ts";
import type { GlobalOptions } from "../options.ts";
import type { ServiceProvider } from "../services.ts";
import {
  runSessionForkOrRewind,
  runSessionReplay,
  runSessionResume,
} from "../session-navigation.ts";
import type { CliStreams } from "../streams.ts";
import { runTaskCommitPlan } from "../task-commit-plan-commands.ts";
import {
  runTaskDecompose,
  runTaskProgress,
  runTaskValidate,
} from "../task-intelligence-commands.ts";

export type DispatchProduceOptions = {
  readonly streams: CliStreams;
  readonly governance?: InvocationGovernance;
};

export async function produce(
  command: Exclude<RunnableCommand, "default">,
  data: Extract<Invocation, { kind: "run" }>["data"],
  dataLifecycleArgs: Extract<Invocation, { kind: "run" }>["dataLifecycleArgs"],
  exportArgs: Extract<Invocation, { kind: "run" }>["exportArgs"],
  importArgs: Extract<Invocation, { kind: "run" }>["importArgs"],
  replayArgs: Extract<Invocation, { kind: "run" }>["replayArgs"],
  sessionArgs: Extract<Invocation, { kind: "run" }>["sessionArgs"],
  artifactArgs: Extract<Invocation, { kind: "run" }>["artifactArgs"],
  workspaceArgs: Extract<Invocation, { kind: "run" }>["workspaceArgs"],
  configSetArgs: Extract<Invocation, { kind: "run" }>["configSetArgs"],
  runArgs: Extract<Invocation, { kind: "run" }>["runArgs"],
  taskArgs: Extract<Invocation, { kind: "run" }>["taskArgs"],
  commitPlanArgs: Extract<Invocation, { kind: "run" }>["commitPlanArgs"],
  providerArgs: Extract<Invocation, { kind: "run" }>["providerArgs"],
  services: ServiceProvider,
  overrides: Readonly<Record<string, string>>,
  globals: GlobalOptions,
  options: DispatchProduceOptions,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<RunCommandResult> {
  switch (command) {
    case "config.show":
      return runConfigShow(services, overrides, globals, signal);
    case "config.validate":
      return runConfigValidate(services, overrides, globals, signal);
    case "config.path":
      return runConfigPath(services, globals, signal);
    case "config.set":
      if (configSetArgs === null) {
        throw new Error("Missing parsed config set arguments.");
      }
      return runConfigSet(services, configSetArgs, globals, signal, onMutationStart);
    case "data.reset":
      if (data === null) {
        throw new Error("Missing parsed data reset arguments.");
      }
      return runDataReset(services, data, signal, onMutationStart);
    case "data.uninstall":
      if (data === null) {
        throw new Error("Missing parsed data uninstall arguments.");
      }
      return runDataUninstall(services, data, signal, onMutationStart);
    case "data.backup":
      if (dataLifecycleArgs === null || dataLifecycleArgs.action !== "backup") {
        throw new Error("Missing parsed data backup arguments.");
      }
      return runDataBackup(services, dataLifecycleArgs, signal, onMutationStart);
    case "data.restore":
      if (dataLifecycleArgs === null || dataLifecycleArgs.action !== "restore") {
        throw new Error("Missing parsed data restore arguments.");
      }
      return runDataRestore(services, dataLifecycleArgs, signal, onMutationStart);
    case "data.inspect":
      if (dataLifecycleArgs === null || dataLifecycleArgs.action !== "inspect") {
        throw new Error("Missing parsed data inspect arguments.");
      }
      return runDataInspect(services, dataLifecycleArgs, signal);
    case "data.diagnostics":
      if (dataLifecycleArgs === null || dataLifecycleArgs.action !== "diagnostics") {
        throw new Error("Missing parsed data diagnostics arguments.");
      }
      return runDataDiagnostics(services, signal);
    case "data.retention":
      if (dataLifecycleArgs === null || dataLifecycleArgs.action !== "retention") {
        throw new Error("Missing parsed data retention arguments.");
      }
      return runDataRetention(services, signal);
    case "data.gc":
      if (dataLifecycleArgs === null || dataLifecycleArgs.action !== "gc") {
        throw new Error("Missing parsed data gc arguments.");
      }
      return runDataGc(services, dataLifecycleArgs, signal, onMutationStart);
    case "doctor":
      return runDoctor(services);
    case "export":
      if (exportArgs === null) {
        throw new Error("Missing parsed export arguments.");
      }
      return runExport(services, exportArgs, signal, onMutationStart);
    case "import":
      if (importArgs === null) {
        throw new Error("Missing parsed import arguments.");
      }
      return runImport(services, importArgs, signal, onMutationStart);
    case "replay":
      if (replayArgs === null) {
        throw new Error("Missing parsed replay arguments.");
      }
      return runReplay(services, replayArgs, signal);
    case "task.decompose":
      if (taskArgs === null || taskArgs.action !== "decompose") {
        throw new Error("Missing parsed task decompose arguments.");
      }
      return runTaskDecompose(taskArgs, signal);
    case "task.validate":
      if (taskArgs === null || taskArgs.action !== "validate") {
        throw new Error("Missing parsed task validate arguments.");
      }
      return runTaskValidate(taskArgs, signal);
    case "task.progress":
      if (taskArgs === null || taskArgs.action !== "progress") {
        throw new Error("Missing parsed task progress arguments.");
      }
      return runTaskProgress(taskArgs, signal);
    case "task.commit-plan":
      if (commitPlanArgs === null) {
        throw new Error("Missing parsed task commit-plan arguments.");
      }
      return runTaskCommitPlan(commitPlanArgs, signal);
    case "session.list":
      if (sessionArgs === null || sessionArgs.action !== "list") {
        throw new Error("Missing parsed session list arguments.");
      }
      return runSessionList(services, sessionArgs, signal);
    case "session.show":
      if (sessionArgs === null || sessionArgs.action !== "show") {
        throw new Error("Missing parsed session show arguments.");
      }
      return runSessionShow(services, sessionArgs, signal);
    case "session.resume":
      if (sessionArgs === null || sessionArgs.action !== "resume") {
        throw new Error("Missing parsed session resume arguments.");
      }
      return runSessionResume(services, sessionArgs, signal);
    case "session.fork":
      if (sessionArgs === null || sessionArgs.action !== "fork") {
        throw new Error("Missing parsed session fork arguments.");
      }
      return runSessionForkOrRewind(services, sessionArgs, signal);
    case "session.rewind":
      if (sessionArgs === null || sessionArgs.action !== "rewind") {
        throw new Error("Missing parsed session rewind arguments.");
      }
      return runSessionForkOrRewind(services, sessionArgs, signal);
    case "session.replay":
      if (sessionArgs === null || sessionArgs.action !== "replay") {
        throw new Error("Missing parsed session replay arguments.");
      }
      return runSessionReplay(services, sessionArgs, signal);
    case "artifact.list":
      if (artifactArgs === null || artifactArgs.action !== "list") {
        throw new Error("Missing parsed artifact list arguments.");
      }
      return runArtifactList(services, artifactArgs, signal);
    case "artifact.show":
      if (artifactArgs === null || artifactArgs.action !== "show") {
        throw new Error("Missing parsed artifact show arguments.");
      }
      return runArtifactShow(services, artifactArgs, signal);
    case "artifact.get":
      if (artifactArgs === null || artifactArgs.action !== "get") {
        throw new Error("Missing parsed artifact get arguments.");
      }
      return runArtifactGet(
        services,
        artifactArgs,
        {
          resultStream: options.streams.result,
          stdoutIsTty: options.streams.capabilities.stdout.isTty,
        },
        signal,
      );
    case "workspace.list":
      if (workspaceArgs === null || workspaceArgs.action !== "list") {
        throw new Error("Missing parsed workspace list arguments.");
      }
      return runWorkspaceList(services, workspaceArgs, signal);
    case "workspace.show":
      return runWorkspaceShow(services, signal);
    case "workspace.save":
      if (workspaceArgs === null || workspaceArgs.action !== "save") {
        throw new Error("Missing parsed workspace save arguments.");
      }
      onMutationStart?.();
      return runWorkspaceSave(services, workspaceArgs, signal);
    case "workspace.load":
      if (workspaceArgs === null || workspaceArgs.action !== "load") {
        throw new Error("Missing parsed workspace load arguments.");
      }
      return runWorkspaceLoad(services, workspaceArgs, signal);
    case "provider":
      if (providerArgs === null) {
        throw new Error("Missing parsed provider arguments.");
      }
      return runProvider(
        services,
        providerArgs,
        globals,
        options.streams.input,
        signal,
        onMutationStart,
      );
    case "run":
      if (runArgs === null) {
        throw new Error("Missing parsed coding run arguments.");
      }
      return runCoding(services, runArgs, {
        input: options.streams.input,
        globals,
        reloadDiagnostics: options.streams,
        ...(signal === undefined ? {} : { signal }),
        ...(options.governance?.ownedProcesses === undefined
          ? {}
          : { ownedProcesses: options.governance.ownedProcesses }),
      });
    case "completion":
      throw new Error("completion is handled before services are constructed.");
    default:
      // `default`, `help`, and `version` are answered before this is reached,
      // so a new command reaching here without a branch fails to compile.
      return assertNever(command, "unhandled command");
  }
}
