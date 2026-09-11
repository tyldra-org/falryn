import type { ModelSettingsRequest } from "../../application/providers/model-settings.ts";
import { assertNever } from "../../domain/foundation/index.ts";
import type { Invocation, RunnableCommand } from "../command-tree.ts";
import {
  runDataBackup,
  runDataDiagnostics,
  runDataInspect,
  runDataRestore,
} from "../commands/data-backup-commands.ts";
import { runDataGc, runDataRetention } from "../commands/data-retention-gc-commands.ts";
import { runExtensionInspect } from "../commands/extension.ts";
import {
  type ExtensionCatalogArguments,
  runExtensionCatalog,
} from "../commands/extension-catalog.ts";
import { runImport, runReplay } from "../commands/import-replay-commands.ts";
import { runModel } from "../commands/model.ts";
import { type PackageArguments, runPackage } from "../commands/package.ts";
import { type PeerArguments, runPeer } from "../commands/peer.ts";
import { runTaskCommitPlan } from "../commands/task-commit-plan-commands.ts";
import {
  runTaskDecompose,
  runTaskProgress,
  runTaskValidate,
} from "../commands/task-intelligence-commands.ts";
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
import type { GlobalOptions } from "../options.ts";
import type { CliStreams } from "../output/streams.ts";
import type { InvocationGovernance } from "../runtime/invocation-scope.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "../runtime/product-configuration.ts";
import { createProductSandbox } from "../runtime/sandbox-configuration.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import {
  runSessionForkOrRewind,
  runSessionReplay,
  runSessionResume,
} from "../runtime/session-navigation.ts";

export type DispatchProduceOptions = {
  readonly extensionCatalogArgs?: ExtensionCatalogArguments;
  readonly packageArgs?: PackageArguments;
  readonly peerArgs?: PeerArguments;
  readonly modelRequest?: ModelSettingsRequest;
  readonly extensionPath?: string;
  readonly extensionTrust?: import("../../application/extensions/package-trust.ts").TrustRequest;
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
    case "extension.catalog":
    case "extension.scope":
      if (options.extensionCatalogArgs === undefined)
        throw new Error("Missing extension catalog arguments.");
      if (
        options.extensionCatalogArgs.action === "scope" &&
        options.extensionCatalogArgs.request.confirmation !== undefined
      )
        onMutationStart?.();
      return runExtensionCatalog(services, options.extensionCatalogArgs, signal);
    case "package":
      if (options.packageArgs === undefined) throw new Error("Missing package arguments.");
      if (options.packageArgs.request.confirmation !== undefined) onMutationStart?.();
      return runPackage(services, options.packageArgs, signal);
    case "peer":
      if (!options.peerArgs) throw new Error("Missing peer arguments.");
      onMutationStart?.();
      return runPeer(services, options.peerArgs, signal);
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
      return runDoctor(services, globals);
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
    case "task.commit-plan": {
      if (commitPlanArgs === null) {
        throw new Error("Missing parsed task commit-plan arguments.");
      }
      const graph = services();
      const configuration = await loadProductConfiguration(
        graph,
        productConfigurationLoadRequest(globals),
        signal,
      );
      return runTaskCommitPlan(
        commitPlanArgs,
        signal,
        createProductSandbox({
          configuration: () => graph.loader.current(),
          values: () => graph.loader.current()?.values ?? configuration.values,
          generation: () => Number(graph.loader.current()?.generation ?? configuration.generation),
          now: () => Number(graph.clock.now()),
          workspaceRoot: graph.workspaceRoot,
        }),
      );
    }
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
    case "model":
      if (options.modelRequest === undefined) throw new Error("Missing model settings request.");
      return runModel(services, options.modelRequest, globals, signal, onMutationStart);
    case "extension.inspect":
    case "extension.trust":
      if (options.extensionPath === undefined) throw new Error("Missing extension package path.");
      if (command === "extension.trust" && options.extensionTrust === undefined)
        throw new Error("Missing trust request.");
      if (options.extensionTrust?.confirmation !== undefined) onMutationStart?.();
      return runExtensionInspect(options.extensionPath, signal, services, options.extensionTrust);
    case "provider":
      if (providerArgs === null) {
        throw new Error("Missing parsed provider arguments.");
      }
      return runProvider(services, providerArgs, globals, options.streams, signal, onMutationStart);
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
