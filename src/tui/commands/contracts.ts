/** Command identities, contexts, and live capability facts. */

import { type CommandSpec, NO_ARGUMENT, planned, SHIPPED } from "../../domain/commands/index.ts";

export const COMMAND_CONTEXTS = [
  "global",
  "overlay",
  "scrollable",
  "transcript",
  "composer",
  "suggestions",
  "confirmation",
] as const;

export type CommandContext = (typeof COMMAND_CONTEXTS)[number];

/** Layer priority per context. Higher wins; the keymap resolves by this number. */
export const CONTEXT_PRIORITY: Readonly<Record<CommandContext, number>> = {
  global: 10,
  scrollable: 20,
  transcript: 30,
  composer: 40,
  // Above the composer so Tab, Escape and the arrows reach the open list first,
  // and below overlays, which the list never opens over.
  suggestions: 45,
  overlay: 50,
  confirmation: 60,
};

export type CommandAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: string };

export const AVAILABLE: CommandAvailability = { kind: "available" };

export function unavailable(reason: string): CommandAvailability {
  return { kind: "unavailable", reason };
}

/** Capability facts used to calculate command availability. */
export type CommandState = {
  readonly overlayOpen: boolean;
  readonly hasComposer: boolean;
  /** The composer's suggestion list is open with rows to pick (#1206). */
  readonly hasSuggestions: boolean;
  readonly hasHeldPaste: boolean;
  readonly hasAttachments: boolean;
  readonly hasDraft: boolean;
  readonly hasEnhancement: boolean;
  readonly hasReadyEnhancement: boolean;
  readonly hasEnhancementFeedback: boolean;
  readonly hasInspectableSelection: boolean;
  readonly hasDiagnosticSelection: boolean;
  readonly hasTranscript: boolean;
  readonly hasScrollableContent: boolean;
  readonly hasConfirmation: boolean;
  readonly confirmationStale: boolean;
  readonly confirmationNeedsSecret: boolean;
  /** A structured question was left unanswered and can be shown again. */
  readonly hasWaitingQuestions: boolean;
  readonly hasRunningWork: boolean;
  readonly hasInFlightSubmission: boolean;
  readonly hasOpenableArtifact: boolean;
  readonly hasDiffArtifactOverlay: boolean;
  readonly diffArtifactHunkIndex: number;
  readonly hasChangesOverlay: boolean;
  readonly changesTab: "files" | "worktrees" | "checkpoints" | null;
  readonly hasWorkspaceSet: boolean;
  readonly hasRemovableWorkspaceRoot: boolean;
  readonly hasSessionNavigation: boolean;
  readonly hasSessionCreation: boolean;
};

export const EMPTY_COMMAND_STATE: CommandState = {
  overlayOpen: false,
  hasComposer: false,
  hasSuggestions: false,
  hasHeldPaste: false,
  hasAttachments: false,
  hasDraft: false,
  hasEnhancement: false,
  hasReadyEnhancement: false,
  hasEnhancementFeedback: false,
  hasInspectableSelection: false,
  hasDiagnosticSelection: false,
  hasTranscript: false,
  hasScrollableContent: false,
  hasConfirmation: false,
  confirmationStale: false,
  confirmationNeedsSecret: false,
  hasWaitingQuestions: false,
  hasRunningWork: false,
  hasInFlightSubmission: false,
  hasOpenableArtifact: false,
  hasDiffArtifactOverlay: false,
  diffArtifactHunkIndex: 0,
  hasChangesOverlay: false,
  changesTab: null,
  hasWorkspaceSet: false,
  hasRemovableWorkspaceRoot: false,
  hasSessionNavigation: false,
  hasSessionCreation: false,
};

/**
 * A registry entry (#790) plus what the shell adds: the key context, the default
 * binding and live availability. Identity, slash forms, argument, timing, effect
 * and callers are the registry's; the shell never keeps a second copy of them.
 */
export type ShellCommand = CommandSpec & {
  readonly context: CommandContext;
  readonly defaultBinding: string | null;
  availability(state: CommandState): CommandAvailability;
};

/**
 * Fields most shell commands share: no slash form, no argument, no confirmation,
 * run by the interactive shell only, shipped. Timing and effect are not here:
 * every entry declares those itself.
 */
export const SHELL_DEFAULTS = {
  slash: [],
  argument: NO_ARGUMENT,
  confirmation: "none",
  behavior: "execute",
  callers: ["interactive"],
  status: SHIPPED,
} as const satisfies Partial<CommandSpec>;

/**
 * A command whose owning issue has not delivered its action yet. It is listed,
 * searchable and completable, and every caller is told who owns it; it can never
 * run, whatever its availability would otherwise say.
 */
export function plannedCommand(
  spec: Omit<ShellCommand, "status" | "availability" | "context" | "defaultBinding"> & {
    readonly owner: string;
    readonly reason: string;
  },
): ShellCommand {
  const { owner, reason, ...rest } = spec;
  return {
    ...rest,
    context: "global",
    defaultBinding: null,
    status: planned(owner, reason),
    availability: () => unavailable(`${reason} (${owner})`),
  };
}

export type BindingConflict = {
  readonly context: CommandContext;
  readonly binding: string;
  readonly commands: readonly string[];
};

/** Commands that may never be unbound. */
export const RESERVED_COMMANDS: readonly string[] = ["app.exit", "overlay.close"];
