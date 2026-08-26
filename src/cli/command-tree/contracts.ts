/** Public invocation contracts and the private raw parser shape. */

import type {
  ArtifactId,
  BackupName,
  ExportName,
  ExportSelection,
  GcPlanId,
  OwnershipClass,
  PlanId,
  SessionCatalogFilter,
  SessionId,
  StreamId,
  WorkspaceId,
} from "../../domain/index.ts";
import type { ProviderAuthMethod, ProviderProfile } from "../../providers/index.ts";
import type { CodingRunArguments } from "../coding-run.ts";
import type { GlobalOptions } from "../options.ts";
import type { CommandId } from "../result.ts";
import type { TaskCommitPlanArguments } from "../task-commit-plan-commands.ts";
import type { TaskCommandArguments } from "../task-intelligence-parse.ts";

export const SCRIPT_NAME = "falryn";

/**
 * A command the tree can dispatch.
 *
 * `help` and `version` are answered by their own invocation kinds, so they are
 * excluded here rather than being reachable as a run — which is what lets the
 * dispatch switch be exhaustive without branches that cannot happen.
 */
export type RunnableCommand = Exclude<CommandId, "help" | "version">;

/** Command-specific inputs for one local-data removal command. */
export type DataCommandArguments = {
  readonly classes: readonly OwnershipClass[];
  /** The exact plan identity supplied by the caller, or `null` for preview. */
  readonly confirmation: PlanId | null;
};

/** Command-specific inputs for backup, restore, inspect, and local diagnostics. */
export type DataLifecycleArguments =
  | { readonly action: "backup"; readonly name: BackupName }
  | {
      readonly action: "restore";
      readonly name: BackupName;
      /** The backup name from a prior preview, or `null` to preview only. */
      readonly confirmation: BackupName | null;
    }
  | { readonly action: "inspect"; readonly name: BackupName }
  | { readonly action: "diagnostics" }
  | { readonly action: "retention" }
  | {
      readonly action: "gc";
      readonly confirmation: GcPlanId | null;
      readonly pinnedSessions: readonly string[];
    };

/** Command-specific inputs for `falryn export`. */
export type ExportCommandArguments = {
  readonly selection: ExportSelection;
  readonly write: boolean;
  readonly name: ExportName | null;
};

/** Command-specific inputs for `falryn import`. */
export type ImportCommandArguments = {
  readonly name: ExportName;
};

/** Command-specific inputs for `falryn replay`. */
export type ReplayCommandArguments = {
  readonly sessionId: SessionId;
};

/** Command-specific inputs for `falryn artifact`. */
export type ArtifactCommandArguments =
  | {
      readonly action: "list";
      readonly limit: number;
    }
  | {
      readonly action: "show";
      readonly artifactId: ArtifactId;
    }
  | {
      readonly action: "get";
      readonly artifactId: ArtifactId;
      readonly outputPath: string | null;
    };

/** Replay control verbs accepted by `falryn session replay`. */
export const SESSION_REPLAY_ACTIONS = ["play", "pause", "step", "seek"] as const;
export type SessionReplayAction = (typeof SESSION_REPLAY_ACTIONS)[number];

/** Command-specific inputs for `falryn session`. */
export type SessionCommandArguments =
  | {
      readonly action: "list";
      readonly workspaceId: WorkspaceId;
      readonly filter: SessionCatalogFilter;
      readonly search: string | undefined;
      readonly limit: number;
    }
  | {
      readonly action: "show";
      readonly workspaceId: WorkspaceId;
      readonly sessionId: SessionId;
    }
  | {
      readonly action: "resume";
      readonly workspaceId: WorkspaceId;
      readonly sessionId: SessionId;
      readonly afterSequence: number | null;
      readonly schemaGeneration: number;
    }
  | {
      readonly action: "fork";
      readonly workspaceId: WorkspaceId;
      readonly sessionId: SessionId;
      readonly newSessionId: SessionId | undefined;
      readonly newStreamId: StreamId | undefined;
    }
  | {
      readonly action: "rewind";
      readonly workspaceId: WorkspaceId;
      readonly sessionId: SessionId;
      readonly atTurnId: string;
      readonly newSessionId: SessionId | undefined;
      readonly newStreamId: StreamId | undefined;
    }
  | {
      readonly action: "replay";
      readonly workspaceId: WorkspaceId;
      readonly sessionId: SessionId;
      readonly replayCommand:
        | { readonly kind: "play" }
        | { readonly kind: "pause" }
        | { readonly kind: "step" }
        | { readonly kind: "seek"; readonly sequence: number };
    };

/** Command-specific inputs for `falryn workspace`. */
export type WorkspaceCommandArguments =
  | {
      readonly action: "list";
      readonly limit: number;
    }
  | {
      readonly action: "show";
    }
  | {
      readonly action: "save";
      readonly name: string;
      readonly force: boolean;
    }
  | {
      readonly action: "load";
      readonly name: string;
    };

/** Command-specific inputs for `falryn config set`. */
export type ConfigSetArguments = {
  readonly keyPath: string;
  readonly rawValue: string;
  readonly scope: "user" | "project" | "profile";
  readonly expectedRevision: string | null;
};

/** Command-specific inputs for `falryn completion`. */
export type CompletionCommandArguments = {
  readonly shell: "bash" | "zsh" | "fish";
};

export type { TaskCommandArguments };

export type ProviderCommandArguments =
  | { readonly action: "list" }
  | { readonly action: "add" | "configure"; readonly profile: ProviderProfile }
  | { readonly action: "use" | "test" | "logout" | "remove"; readonly profileId: string }
  | {
      readonly action: "login";
      readonly profileId: string;
      readonly method: ProviderAuthMethod;
      readonly accountLabel: string | null;
    };

/**
 * What parsing an argument vector produced.
 *
 * A closed union rather than a partly-filled record: an invocation that failed
 * to parse has no command and no options, and a shape that carried both would
 * let a caller read them anyway.
 */
export type Invocation =
  /** Run this command with these options. */
  | {
      readonly kind: "run";
      readonly command: RunnableCommand;
      readonly options: GlobalOptions;
      readonly data: DataCommandArguments | null;
      readonly dataLifecycleArgs: DataLifecycleArguments | null;
      readonly exportArgs: ExportCommandArguments | null;
      readonly importArgs: ImportCommandArguments | null;
      readonly replayArgs: ReplayCommandArguments | null;
      readonly sessionArgs: SessionCommandArguments | null;
      readonly artifactArgs: ArtifactCommandArguments | null;
      readonly workspaceArgs: WorkspaceCommandArguments | null;
      readonly configSetArgs: ConfigSetArguments | null;
      readonly completionArgs: CompletionCommandArguments | null;
      readonly runArgs: CodingRunArguments | null;
      readonly taskArgs: TaskCommandArguments | null;
      readonly commitPlanArgs: TaskCommitPlanArguments | null;
      readonly providerArgs: ProviderCommandArguments | null;
    }
  /** Show help. `topic` is `null` for the root, or the subcommand asked about. */
  | { readonly kind: "help"; readonly topic: string | null; readonly options: GlobalOptions }
  | { readonly kind: "version"; readonly options: GlobalOptions }
  /**
   * The invocation was not usable. Exits with #20's invalid-usage code.
   *
   * `message` is yargs' own text or a conflict this module detected; it is
   * actionable and safe to print, and it never carries a secret because the
   * only values in it are the flags the caller typed.
   */
  | { readonly kind: "invalid"; readonly message: string };

/** The shape yargs parses into. Narrowed into `GlobalOptions` after validation. */
export type RawArguments = {
  readonly _: readonly (string | number)[];
  /** Bound by name from `config <action>`; it never appears in `_`. */
  readonly action: string | undefined;
  readonly class: readonly string[] | undefined;
  readonly confirm: string | undefined;
  readonly "pinned-session": readonly string[] | undefined;
  readonly session: readonly string[] | undefined;
  readonly after: string | undefined;
  readonly before: string | undefined;
  readonly name: string | undefined;
  readonly write: boolean | undefined;
  readonly "include-sensitive": boolean | undefined;
  readonly id: string | undefined;
  readonly filter: string | undefined;
  readonly search: string | undefined;
  readonly limit: number | undefined;
  readonly "workspace-id": string | undefined;
  readonly "after-sequence": number | undefined;
  readonly "schema-generation": number | undefined;
  readonly "at-turn": string | undefined;
  readonly "new-session-id": string | undefined;
  readonly "new-stream-id": string | undefined;
  readonly "replay-action": string | undefined;
  readonly "seek-sequence": number | undefined;
  readonly output: string | undefined;
  readonly force: boolean | undefined;
  readonly "add-dir": readonly string[] | undefined;
  readonly prompt: readonly string[] | undefined;
  readonly brief: string | undefined;
  readonly key: string | undefined;
  readonly value: string | undefined;
  readonly revision: string | undefined;
  readonly shell: string | undefined;
  readonly "file-scope": string | undefined;
  readonly statement: string | undefined;
  readonly "outcome-id": string | undefined;
  readonly "task-id": string | undefined;
  readonly scope: readonly string[] | undefined;
  readonly cwd: string | undefined;
  readonly goal: readonly string[] | undefined;
  readonly "non-goal": readonly string[] | undefined;
  readonly proposed: readonly string[] | undefined;
  readonly task: readonly string[] | undefined;
  readonly depends: readonly string[] | undefined;
  readonly observe: readonly string[] | undefined;
  readonly blocker: readonly string[] | undefined;
  readonly criterion: readonly string[] | undefined;
  readonly input: string | undefined;
  readonly provider: string | undefined;
  readonly adapter: string | undefined;
  readonly endpoint: string | undefined;
  readonly model: readonly string[] | undefined;
  readonly discovery: string | undefined;
  readonly organization: string | undefined;
  readonly project: string | undefined;
  readonly "connect-timeout": number | undefined;
  readonly "request-timeout": number | undefined;
  readonly "auth-method": string | undefined;
  readonly "api-key-stdin": boolean | undefined;
  readonly "account-label": string | undefined;
  readonly format: string;
  readonly color: string;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly "non-interactive": boolean;
  readonly "no-color": boolean;
  readonly workspace: string | undefined;
  readonly profile: string | undefined;
  readonly timeout: number | undefined;
  readonly help: boolean;
  readonly version: boolean;
};

/**
 * Builds the parser for one argument vector.
 *
 * Rebuilt per parse rather than shared: yargs parsers carry state across
 * `parse` calls, and a shared one makes a second invocation in the same process
 * depend on the first — which a test suite notices before a user does.
 */
