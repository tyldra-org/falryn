/**
 * The command registry: what the shell can be asked to do.
 *
 * A command is the stable identity. Bindings change, titles get reworded, and
 * a palette entry is display text — the ID is what a keymap override, a help
 * entry, and a palette dispatch all reference, and it is the only part of this
 * module that is a compatibility promise.
 *
 * Every command declares whether it is available *right now* and, when it is
 * not, why. That is the honesty mechanism this milestone most needs: there is no
 * agent loop, no transcript, and no composer, so a registry that listed
 * `composer.submit` as a working command would be advertising a key that does
 * nothing. Listing it as unavailable with "no composer yet" is a different
 * statement, and a true one — the command exists, the binding is reserved, and
 * the user is told what is missing rather than left pressing a key.
 *
 * Commands whose *concept* does not exist are omitted entirely rather than
 * listed as unavailable. `task.inspect` has no task to inspect and no task
 * anywhere in the build; carrying it here would be inventing a domain.
 *
 * This module imports no OpenTUI value and holds no state. Availability is a
 * function of a state value the caller supplies.
 */

/**
 * Where a command is reachable from.
 *
 * The layer order the canonical contract names, narrowest last. A binding in a
 * more specific context wins over the same key in a broader one, which is what
 * lets `escape` close an overlay when one is open and request cancellation when
 * none is.
 */
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
  // Highest of all: a confirmation is asking a question, and nothing behind it
  // may answer on the user's behalf.
  confirmation: 60,
};

export type CommandAvailability =
  | { readonly kind: "available" }
  /** Carries why, because "unavailable" alone is a category rather than an answer. */
  | { readonly kind: "unavailable"; readonly reason: string };

export const AVAILABLE: CommandAvailability = { kind: "available" };

function unavailable(reason: string): CommandAvailability {
  return { kind: "unavailable", reason };
}

/**
 * What the shell can currently do, as the registry sees it.
 *
 * Deliberately a set of capability facts rather than the view model: a command's
 * availability must not depend on what is drawn, only on what exists. Overlay,
 * composer, transcript, and confirmation facts are live; the rest stay false
 * until a later issue fills them.
 */
export type CommandState = {
  readonly overlayOpen: boolean;
  /**
   * Whether the composer is mounted *and* focused.
   *
   * Focus rather than existence, because the canonical layer stack's narrowest
   * layer is the focused editor or control. An always-active composer layer
   * would take `up` and `down` from the transcript permanently, since the
   * composer's priority is higher — so "the composer exists" is the wrong
   * question for whether its keys should win.
   */
  readonly hasComposer: boolean;
  /** A held-out preview paste can be included as an attachment. */
  readonly hasHeldPaste: boolean;
  /** At least one attachment handle is on the composer. */
  readonly hasAttachments: boolean;
  /** The composer draft has non-whitespace text. */
  readonly hasDraft: boolean;
  /** A proposal is waiting (ready or stale). */
  readonly hasEnhancement: boolean;
  /** A ready proposal can be accepted. */
  readonly hasReadyEnhancement: boolean;
  /** An enhancement notice (empty/unchanged/unavailable) is showing. */
  readonly hasEnhancementFeedback: boolean;
  /** The selected transcript block is a tool, process, reasoning, or error entry. */
  readonly hasInspectableSelection: boolean;
  /** The selected inspectable block carries a non-completed outcome. */
  readonly hasDiagnosticSelection: boolean;
  /**
   * Whether a transcript is mounted with something in it.
   *
   * Since #355 this is a fact about the projection rather than a constant. An
   * empty transcript has no entry to select, expand, or jump to, so its
   * commands stay unavailable and say why rather than appearing to work.
   */
  readonly hasTranscript: boolean;
  /** Whether the mounted content is taller than the region drawing it. */
  readonly hasScrollableContent: boolean;
  readonly hasConfirmation: boolean;
  /** The bound prompt no longer matches the live identity. */
  readonly confirmationStale: boolean;
  /** A secret field is showing and still empty. */
  readonly confirmationNeedsSecret: boolean;
  /** Whether any cancellable work is in flight. Nothing runs work yet. */
  readonly hasRunningWork: boolean;
};

/** The state of a shell with nothing behind it, which is every run today. */
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
};

export type ShellCommand = {
  /** Stable. Overrides, help, and the palette all reference this and not the title. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly context: CommandContext;
  /**
   * The default key, or `null` for a command that deliberately has none.
   *
   * `null` is a real answer rather than a gap: an essential action must have a
   * name even when no key is worth spending on it, so it stays reachable from
   * the palette and discoverable in help.
   */
  readonly defaultBinding: string | null;
  /** Words for search, beyond the title. The palette matches these too. */
  readonly keywords: readonly string[];
  availability(state: CommandState): CommandAvailability;
};

/**
 * Commands that may never be unbound.
 *
 * Exit and overlay-close are the two paths out. A customization that removed
 * either would leave someone in a full-screen interface with no way back, and
 * on a terminal in raw mode that is a window they have to close. Customization
 * itself is deferred, but the rule is declared and enforced now so the layer
 * that adds it inherits a constraint rather than having to invent one.
 */
export const RESERVED_COMMANDS: readonly string[] = ["app.exit", "overlay.close"];

/**
 * Every command this build declares.
 *
 * The IDs are the canonical reference's, so a user reading the published table
 * and a user reading the palette see the same names. Order is reading order for
 * help: what you can do, then how you move, then what is not here yet.
 */
export const SHELL_COMMANDS: readonly ShellCommand[] = [
  {
    id: "app.help",
    title: "Help",
    description: "Show every command, its key, and whether it is available.",
    context: "global",
    defaultBinding: "?",
    keywords: ["keys", "shortcuts", "bindings"],
    availability: () => AVAILABLE,
  },
  {
    id: "app.commandPalette",
    title: "Command palette",
    description: "Search commands by name and run one.",
    context: "global",
    defaultBinding: "ctrl+p",
    keywords: ["commands", "run", "search"],
    availability: () => AVAILABLE,
  },
  {
    id: "app.exit",
    title: "Exit",
    description: "Close the shell and restore the terminal.",
    context: "global",
    // The binding that makes the interface usable at all. In raw mode Ctrl+C is
    // delivered as a byte rather than as `SIGINT` — the terminal's own signal
    // generation is off — so without this the shell has no keyboard route out,
    // which is exactly what it had before this command existed.
    defaultBinding: "ctrl+c",
    keywords: ["quit", "close", "leave"],
    availability: () => AVAILABLE,
  },
  {
    id: "app.cancel",
    title: "Cancel current work",
    description: "Ask the running operation to stop, without leaving the shell.",
    context: "global",
    defaultBinding: "escape",
    keywords: ["stop", "abort", "interrupt"],
    availability: (state) =>
      state.hasRunningWork ? AVAILABLE : unavailable("nothing is running to cancel"),
  },
  {
    id: "focus.next",
    title: "Focus next region",
    description: "Move to the next region in reading order.",
    context: "global",
    defaultBinding: "tab",
    keywords: ["move", "region", "forward"],
    availability: () => AVAILABLE,
  },
  {
    id: "focus.previous",
    title: "Focus previous region",
    description: "Move to the previous region in reading order.",
    context: "global",
    defaultBinding: "shift+tab",
    keywords: ["move", "region", "back"],
    availability: () => AVAILABLE,
  },
  {
    id: "overlay.close",
    title: "Close overlay",
    description: "Close the open overlay and return focus where it was.",
    context: "overlay",
    defaultBinding: "escape",
    keywords: ["dismiss", "back", "escape"],
    availability: (state) => (state.overlayOpen ? AVAILABLE : unavailable("no overlay is open")),
  },
  {
    id: "view.scrollUp",
    title: "Scroll up",
    description: "Move the view up by a bounded amount.",
    context: "scrollable",
    defaultBinding: "pageup",
    keywords: ["scroll", "up"],
    availability: (state) =>
      state.hasScrollableContent ? AVAILABLE : unavailable("nothing is scrollable yet"),
  },
  {
    id: "view.scrollDown",
    title: "Scroll down",
    description: "Move the view down by a bounded amount.",
    context: "scrollable",
    defaultBinding: "pagedown",
    keywords: ["scroll", "down"],
    availability: (state) =>
      state.hasScrollableContent ? AVAILABLE : unavailable("nothing is scrollable yet"),
  },
  {
    id: "view.top",
    title: "Go to top",
    description: "Move to the start of the view.",
    context: "scrollable",
    defaultBinding: "home",
    keywords: ["start", "beginning"],
    availability: (state) =>
      state.hasScrollableContent ? AVAILABLE : unavailable("nothing is scrollable yet"),
  },
  {
    id: "view.bottom",
    title: "Go to bottom",
    description: "Move to the end of the view.",
    context: "scrollable",
    defaultBinding: "end",
    keywords: ["end", "latest"],
    availability: (state) =>
      state.hasScrollableContent ? AVAILABLE : unavailable("nothing is scrollable yet"),
  },
  {
    id: "transcript.search",
    title: "Search the transcript",
    description: "Find text in the projected conversation.",
    context: "transcript",
    defaultBinding: "ctrl+f",
    keywords: ["find", "filter"],
    // Unavailable even once a transcript exists. #355 delivered the surface, not
    // a search over it, and a command that became available the moment the first
    // block arrived would answer its key by saying it has no effect — which is
    // the "appears to work" failure this registry exists to prevent.
    availability: () => unavailable("there is no transcript search yet"),
  },
  {
    id: "transcript.expand",
    title: "Expand the selected entry",
    description: "Inspect a tool call or artifact in full, or collapse it again.",
    context: "transcript",
    // `return` rather than `enter`, and the difference is not cosmetic: the key
    // parser's canonical name for this key is `return`, and a layer registered
    // under `enter` is never matched. Every binding here is the parser's own
    // name so that a declared key is a key that fires — which is the whole
    // premise of a registry that refuses to advertise what it cannot do.
    defaultBinding: "return",
    keywords: ["inspect", "open", "detail", "collapse"],
    availability: (state) =>
      state.hasTranscript ? AVAILABLE : unavailable("there is no transcript yet"),
  },
  {
    id: "transcript.inspect",
    title: "Inspect the selected entry",
    description: "Inspect a tool, process, reasoning, or error block without submitting.",
    context: "transcript",
    defaultBinding: null,
    keywords: ["inspect", "detail", "tool", "process", "reasoning", "error"],
    availability: (state) =>
      state.hasInspectableSelection
        ? AVAILABLE
        : unavailable("this entry has no tool, process, reasoning, or error inspection"),
  },
  {
    id: "transcript.selectPrevious",
    title: "Select the previous entry",
    description: "Move the transcript selection one entry towards the start.",
    context: "transcript",
    defaultBinding: "up",
    keywords: ["previous", "move", "entry"],
    availability: (state) =>
      state.hasTranscript ? AVAILABLE : unavailable("there is no transcript yet"),
  },
  {
    id: "transcript.selectNext",
    title: "Select the next entry",
    description: "Move the transcript selection one entry towards the latest.",
    context: "transcript",
    defaultBinding: "down",
    keywords: ["next", "move", "entry"],
    availability: (state) =>
      state.hasTranscript ? AVAILABLE : unavailable("there is no transcript yet"),
  },
  {
    id: "transcript.jumpToLatest",
    title: "Jump to the latest entry",
    description: "Follow the transcript again after scrolling away from it.",
    context: "transcript",
    // `end` in the transcript layer rather than a key of its own. The scrollable
    // layer already binds `end` to "go to the end of the view", and for a
    // transcript the end is the latest — so the narrower layer sharpens what the
    // key already meant instead of teaching a reader a second one.
    defaultBinding: "end",
    keywords: ["latest", "bottom", "follow", "unseen"],
    availability: (state) =>
      state.hasTranscript ? AVAILABLE : unavailable("there is no transcript yet"),
  },
  {
    id: "transcript.openArtifact",
    title: "Open the artifact",
    description: "Open the artifact an entry's content was clipped from.",
    context: "transcript",
    // No default key. The command exists because `transcript.open-artifact` is a
    // route the projection can return, and a route with no command is an offer
    // nothing honours — but a key for a viewer that does not exist would be a
    // second, worse promise.
    defaultBinding: null,
    keywords: ["artifact", "open", "export"],
    availability: () => unavailable("there is no artifact viewer yet"),
  },
  {
    id: "transcript.showDiagnostics",
    title: "Show the diagnostics",
    description: "Show the diagnostics behind a failed entry.",
    context: "transcript",
    defaultBinding: null,
    keywords: ["diagnostics", "failure", "why"],
    availability: (state) =>
      state.hasDiagnosticSelection
        ? AVAILABLE
        : unavailable("this entry has no inspectable diagnostics"),
  },
  {
    id: "composer.submit",
    title: "Submit",
    description: "Send what is in the composer.",
    context: "composer",
    // The parser's canonical name. See `transcript.expand`.
    defaultBinding: "return",
    keywords: ["send", "run", "ask"],
    availability: (state) =>
      state.hasComposer ? AVAILABLE : unavailable("the composer is not focused"),
  },
  {
    id: "composer.newline",
    title: "Insert a newline",
    description: "Add a line without submitting.",
    context: "composer",
    defaultBinding: "shift+return",
    keywords: ["newline", "multiline"],
    availability: (state) =>
      state.hasComposer ? AVAILABLE : unavailable("the composer is not focused"),
  },
  {
    id: "composer.historyPrevious",
    title: "Previous entry",
    // Two effects on one key, and the boundary decides which. Inside a multiline
    // draft `up` moves a line, because a composer whose arrows did not move the
    // cursor would not be a text editor. From the first line there is no line to
    // move to, and that is where recall begins — which is what every composer
    // people already use does, and the reason it is one key rather than two.
    description: "Recall the previous submission.",
    context: "composer",
    // Unbound since #399, and that is the composer becoming the library's
    // renderable rather than a lost capability. `up` and `down` are the
    // textarea's motions and it must see them: a binding here claims the key
    // before any renderable does, which measured out as the cursor never
    // moving a line at all. The edge rule — recall when there is no line to
    // move to — lives in `./components/composer.tsx`, where the key lands and
    // where the renderable's own cursor can be read. This entry keeps the
    // command listed, searchable, and reachable from the palette.
    defaultBinding: null,
    keywords: ["history", "previous", "recall"],
    availability: (state) =>
      state.hasComposer ? AVAILABLE : unavailable("the composer is not focused"),
  },
  {
    id: "composer.historyNext",
    title: "Next entry",
    description: "Move forward through recalled submissions.",
    context: "composer",
    // Unbound for the reason `composer.historyPrevious` states.
    defaultBinding: null,
    keywords: ["history", "next"],
    availability: (state) =>
      state.hasComposer ? AVAILABLE : unavailable("the composer is not focused"),
  },
  {
    id: "composer.includePaste",
    title: "Include the held paste",
    description: "Attach the last large paste without inserting it into the draft.",
    context: "composer",
    defaultBinding: null,
    keywords: ["include", "paste", "attach"],
    availability: (state) =>
      state.hasHeldPaste ? AVAILABLE : unavailable("there is no held-out paste to include"),
  },
  {
    id: "composer.excludePaste",
    title: "Discard the held paste",
    description: "Drop the last large paste without attaching it.",
    context: "composer",
    defaultBinding: null,
    keywords: ["exclude", "paste", "discard"],
    availability: (state) =>
      state.hasHeldPaste ? AVAILABLE : unavailable("there is no held-out paste to discard"),
  },
  {
    id: "composer.removeAttachment",
    title: "Remove the last attachment",
    description: "Detach the last attached paste or file.",
    context: "composer",
    defaultBinding: null,
    keywords: ["attachment", "remove", "detach"],
    availability: (state) =>
      state.hasAttachments ? AVAILABLE : unavailable("there is no attachment to remove"),
  },
  {
    id: "composer.moveAttachmentEarlier",
    title: "Move attachment earlier",
    description: "Move the last attachment one place earlier.",
    context: "composer",
    defaultBinding: null,
    keywords: ["attachment", "reorder"],
    availability: (state) =>
      state.hasAttachments ? AVAILABLE : unavailable("there is no attachment to reorder"),
  },
  {
    id: "composer.moveAttachmentLater",
    title: "Move attachment later",
    description: "Move the last attachment one place later.",
    context: "composer",
    defaultBinding: null,
    keywords: ["attachment", "reorder"],
    availability: (state) =>
      state.hasAttachments ? AVAILABLE : unavailable("there is no attachment to reorder"),
  },
  {
    id: "composer.enhancePrompt",
    title: "Enhance the draft",
    description: "Propose a clearer draft without submitting it.",
    context: "composer",
    defaultBinding: null,
    keywords: ["enhance", "improve", "rewrite", "clarify"],
    availability: () => AVAILABLE,
  },
  {
    id: "composer.acceptEnhancement",
    title: "Accept enhancement",
    description: "Replace the draft with the proposed text. Does not submit.",
    context: "composer",
    defaultBinding: null,
    keywords: ["accept", "apply", "proposal"],
    availability: (state) =>
      state.hasReadyEnhancement
        ? AVAILABLE
        : unavailable("there is no ready enhancement to accept"),
  },
  {
    id: "composer.rejectEnhancement",
    title: "Reject enhancement",
    description: "Drop the proposal and keep the current draft.",
    context: "composer",
    defaultBinding: null,
    keywords: ["reject", "discard", "proposal"],
    availability: (state) =>
      state.hasEnhancement || state.hasEnhancementFeedback
        ? AVAILABLE
        : unavailable("there is no enhancement to reject"),
  },
  {
    id: "confirmation.accept",
    title: "Accept",
    description: "Confirm the exact action described.",
    context: "confirmation",
    // No default key, deliberately. A reusable single key that accepts anything
    // is how someone confirms a destructive action they had not read; a
    // confirmation binds its own keys to its own labelled choices.
    defaultBinding: null,
    keywords: ["yes", "confirm", "ok"],
    availability: (state) => {
      if (!state.hasConfirmation) {
        return unavailable("nothing is waiting for confirmation");
      }
      if (state.confirmationStale) {
        return unavailable("this confirmation is no longer valid");
      }
      if (state.confirmationNeedsSecret) {
        return unavailable("the secret field is empty");
      }
      return AVAILABLE;
    },
  },
  {
    id: "confirmation.deny",
    title: "Decline",
    description: "Refuse the action described.",
    context: "confirmation",
    defaultBinding: null,
    keywords: ["no", "cancel", "refuse"],
    availability: (state) =>
      state.hasConfirmation ? AVAILABLE : unavailable("nothing is waiting for confirmation"),
  },
];

/** A command by ID, or `undefined`. Lookup is by identity and never by title. */
export function commandById(id: string): ShellCommand | undefined {
  return SHELL_COMMANDS.find((command) => command.id === id);
}

/**
 * Commands matching a search, in registry order.
 *
 * Matches the title, the description, the keywords, and the ID — the ID because
 * someone reading the published reference will type `app.exit`, and a palette
 * that only searched display text would not find the thing the documentation
 * told them to look for.
 */
export function searchCommands(query: string): readonly ShellCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return SHELL_COMMANDS;
  }
  return SHELL_COMMANDS.filter((command) =>
    [command.id, command.title, command.description, ...command.keywords].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

export type BindingConflict = {
  readonly context: CommandContext;
  readonly binding: string;
  /** Both IDs, sorted, so the report names what collided rather than which lost. */
  readonly commands: readonly string[];
};

/**
 * Bindings that collide within one context.
 *
 * A conflict is a validation error, not a last-registration-wins accident: two
 * commands on one key in one context means one of them is unreachable, and
 * which one depends on registration order — a fact no user can see and no
 * reviewer can predict.
 *
 * The same key in *different* contexts is not a conflict. `escape` closing an
 * overlay and `escape` cancelling work is the layering working as designed.
 */
export function bindingConflicts(
  commands: readonly ShellCommand[] = SHELL_COMMANDS,
): readonly BindingConflict[] {
  const seen = new Map<CommandContext, Map<string, string[]>>();
  for (const command of commands) {
    if (command.defaultBinding === null) {
      continue;
    }
    const inContext = seen.get(command.context) ?? new Map<string, string[]>();
    inContext.set(command.defaultBinding, [
      ...(inContext.get(command.defaultBinding) ?? []),
      command.id,
    ]);
    seen.set(command.context, inContext);
  }

  const conflicts: BindingConflict[] = [];
  for (const [context, bindings] of seen) {
    for (const [binding, ids] of bindings) {
      if (ids.length >= 2) {
        conflicts.push({ context, binding, commands: [...ids].sort() });
      }
    }
  }
  return conflicts;
}

/** Reserved commands missing from a set. Empty when every one is still bound. */
export function missingReservedCommands(
  commands: readonly ShellCommand[] = SHELL_COMMANDS,
): readonly string[] {
  return RESERVED_COMMANDS.filter(
    (id) => !commands.some((command) => command.id === id && command.defaultBinding !== null),
  );
}
