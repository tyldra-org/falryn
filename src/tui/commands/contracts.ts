/** Command identities, contexts, and live capability facts. */

export const COMMAND_CONTEXTS = [
  "global",
  "overlay",
  "scrollable",
  "transcript",
  "composer",
  "confirmation",
] as const;

export type CommandContext = (typeof COMMAND_CONTEXTS)[number];

/** Layer priority per context. Higher wins; the keymap resolves by this number. */
export const CONTEXT_PRIORITY: Readonly<Record<CommandContext, number>> = {
  global: 10,
  scrollable: 20,
  transcript: 30,
  composer: 40,
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

export type ShellCommand = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly context: CommandContext;
  readonly defaultBinding: string | null;
  readonly keywords: readonly string[];
  availability(state: CommandState): CommandAvailability;
};

export type BindingConflict = {
  readonly context: CommandContext;
  readonly binding: string;
  readonly commands: readonly string[];
};

/** Commands that may never be unbound. */
export const RESERVED_COMMANDS: readonly string[] = ["app.exit", "overlay.close"];
