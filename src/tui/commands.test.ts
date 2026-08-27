/**
 * The command registry and the keymap plan built from it.
 *
 * Two properties carry this issue's honesty. Every command says whether it can
 * run and why not — because a milestone with no agent loop is where an interface
 * is most tempted to list keys that do nothing. And a binding conflict is a
 * refusal rather than a race, because "which command wins" decided by
 * registration order is a fact no user can see and no reviewer can predict.
 *
 * None of this needs a renderer, which is the point of having written the
 * registry and the plan as values.
 */

import { describe, expect, test } from "bun:test";
import { createTestKeymap } from "@opentui/keymap/testing";
import {
  bindingConflicts,
  COMMAND_CONTEXTS,
  CONTEXT_PRIORITY,
  commandById,
  EMPTY_COMMAND_STATE,
  missingReservedCommands,
  RESERVED_COMMANDS,
  SHELL_COMMANDS,
  type ShellCommand,
  searchCommands,
} from "./commands.ts";
import {
  activeCommandIds,
  bindingsForContext,
  bindingsWhileTyping,
  commandRows,
  describeRefusal,
  isContextActive,
  isTypedKey,
  planKeymap,
} from "./keymap.ts";

const OVERLAY_OPEN = { ...EMPTY_COMMAND_STATE, overlayOpen: true };

function plan() {
  const verdict = planKeymap();
  if (!verdict.ok) {
    throw new Error(`the shipped keymap is invalid: ${verdict.refusals.map(describeRefusal)}`);
  }
  return verdict.plan;
}

function activeFor(contexts: readonly (typeof COMMAND_CONTEXTS)[number][]): ReadonlySet<string> {
  const harness = createTestKeymap({ defaultKeys: true });
  const current = plan();
  const releases = contexts.map((context) =>
    harness.keymap.registerLayer({
      priority: CONTEXT_PRIORITY[context],
      bindings: bindingsForContext(current, context).map((binding) => ({
        key: binding.key,
        cmd: binding.command,
      })),
    }),
  );
  const releaseCommands = harness.keymap.registerLayer({
    commands: SHELL_COMMANDS.map((command) => ({ name: command.id, run: () => true })),
  });
  const active = activeCommandIds(harness.keymap.getActiveKeys({ includeBindings: true }));
  releaseCommands();
  for (const release of releases) {
    release();
  }
  harness.cleanup();
  return active;
}

describe("every command", () => {
  test("has a stable id, a title, and a description", () => {
    for (const command of SHELL_COMMANDS) {
      expect({ id: command.id, named: command.id.includes(".") }).toEqual({
        id: command.id,
        named: true,
      });
      expect(command.title.length).toBeGreaterThan(0);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  test("has an id no other command uses", () => {
    // The id is the compatibility promise. Two commands sharing one would make
    // an override ambiguous and a palette dispatch arbitrary.
    const ids = SHELL_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("declares a context the keymap knows how to layer", () => {
    for (const command of SHELL_COMMANDS) {
      expect({
        id: command.id,
        known: (COMMAND_CONTEXTS as readonly string[]).includes(command.context),
      }).toEqual({ id: command.id, known: true });
    }
  });

  test("answers whether it is available, and says why when it is not", () => {
    // The acceptance criterion, over the whole registry rather than a sample.
    for (const command of SHELL_COMMANDS) {
      const availability = command.availability(EMPTY_COMMAND_STATE);
      if (availability.kind === "unavailable") {
        expect({ id: command.id, reason: availability.reason.length > 0 }).toEqual({
          id: command.id,
          reason: true,
        });
      }
    }
  });

  test("is either bound or explicitly unbound, never accidentally either", () => {
    // `null` is a decision — "this action has a name and no key" — and every
    // other value is a key. There is no third state for a command to be in.
    for (const command of SHELL_COMMANDS) {
      const binding = command.defaultBinding;
      expect({ id: command.id, decided: binding === null || binding.length > 0 }).toEqual({
        id: command.id,
        decided: true,
      });
    }
  });

  test("is findable by its id", () => {
    for (const command of SHELL_COMMANDS) {
      expect(commandById(command.id)?.id).toBe(command.id);
    }
    expect(commandById("nope.missing")).toBeUndefined();
  });
});

describe("what this build can actually do", () => {
  test("makes exit, help, the palette, and focus movement available", () => {
    // The commands that must work in a shell with nothing behind it. `app.exit`
    // most of all: a terminal in raw mode raises no `SIGINT`, so without it the
    // interface has no keyboard route out at all.
    for (const id of [
      "app.exit",
      "app.help",
      "app.commandPalette",
      "focus.next",
      "focus.previous",
    ]) {
      const command = commandById(id);
      expect({ id, available: command?.availability(EMPTY_COMMAND_STATE).kind }).toEqual({
        id,
        available: "available",
      });
    }
  });

  test("says what is missing for everything else", () => {
    // Not omitted and not silently inert: listed, discoverable, and answered.
    const expected: Readonly<Record<string, string>> = {
      "composer.submit": "composer",
      "transcript.search": "transcript",
      "view.scrollUp": "scrollable",
      "confirmation.accept": "confirmation",
      "app.cancel": "running",
    };
    for (const [id, word] of Object.entries(expected)) {
      const availability = commandById(id)?.availability(EMPTY_COMMAND_STATE);
      expect({ id, kind: availability?.kind }).toEqual({ id, kind: "unavailable" });
      expect({
        id,
        explains: availability?.kind === "unavailable" && availability.reason.includes(word),
      }).toEqual({ id, explains: true });
    }
  });

  test("becomes available when its surface exists", () => {
    // The predicate has to be able to answer yes, or it is a constant wearing a
    // function's clothes.
    expect(commandById("overlay.close")?.availability(OVERLAY_OPEN).kind).toBe("available");
    expect(commandById("overlay.close")?.availability(EMPTY_COMMAND_STATE).kind).toBe(
      "unavailable",
    );
    expect(
      commandById("transcript.inspect")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasInspectableSelection: true,
      }).kind,
    ).toBe("available");
    expect(
      commandById("transcript.showDiagnostics")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasDiagnosticSelection: true,
      }).kind,
    ).toBe("available");
    expect(commandById("transcript.inspect")?.defaultBinding).toBe(null);
    expect(commandById("transcript.showDiagnostics")?.defaultBinding).toBe(null);
    expect(
      commandById("transcript.includeInDraft")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasTranscript: true,
      }).kind,
    ).toBe("available");
    expect(commandById("transcript.includeInDraft")?.defaultBinding).toBe(null);
    expect(
      commandById("transcript.copy")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasTranscript: true,
      }).kind,
    ).toBe("available");
    expect(
      commandById("transcript.copyIdentity")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasTranscript: true,
      }).kind,
    ).toBe("available");
    expect(commandById("transcript.copy")?.defaultBinding).toBe(null);
    expect(commandById("transcript.copyIdentity")?.defaultBinding).toBe(null);
    expect(
      commandById("changes.nextTab")?.availability({
        ...EMPTY_COMMAND_STATE,
        overlayOpen: true,
        hasChangesOverlay: true,
      }).kind,
    ).toBe("available");
    expect(commandById("changes.restoreCheckpoint")?.availability(EMPTY_COMMAND_STATE).kind).toBe(
      "unavailable",
    );
    expect(
      commandById("changes.restoreCheckpoint")?.availability({
        ...EMPTY_COMMAND_STATE,
        overlayOpen: true,
        hasChangesOverlay: true,
        changesTab: "checkpoints",
      }).kind,
    ).toBe("available");
    expect(
      commandById("confirmation.accept")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasConfirmation: true,
      }).kind,
    ).toBe("available");
    expect(
      commandById("confirmation.accept")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasConfirmation: true,
        confirmationStale: true,
      }).kind,
    ).toBe("unavailable");
    expect(
      commandById("confirmation.accept")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasConfirmation: true,
        confirmationNeedsSecret: true,
      }).kind,
    ).toBe("unavailable");
    expect(commandById("confirmation.accept")?.defaultBinding).toBe(null);
    expect(commandById("confirmation.deny")?.defaultBinding).toBe(null);
  });

  test("declares session, model, context, and resource controls", () => {
    expect(commandById("session.switch")?.defaultBinding).toBe(null);
    expect(commandById("model.select")?.defaultBinding).toBe(null);
    expect(commandById("context.show")?.defaultBinding).toBe(null);
    expect(commandById("resource.show")?.defaultBinding).toBe(null);
    expect(commandById("session.new")?.availability(EMPTY_COMMAND_STATE)).toEqual({
      kind: "unavailable",
      reason: "no durable session factory yet",
    });
    expect(
      commandById("session.new")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasSessionCreation: true,
      }),
    ).toEqual({ kind: "available" });
    expect(
      commandById("session.new")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasSessionCreation: true,
        hasInFlightSubmission: true,
      }),
    ).toEqual({ kind: "unavailable", reason: "the current session still has active work" });
    expect(
      commandById("session.new")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasSessionCreation: true,
        hasConfirmation: true,
      }),
    ).toEqual({ kind: "unavailable", reason: "resolve the pending confirmation first" });
    expect(commandById("session.switch")?.availability(EMPTY_COMMAND_STATE).kind).toBe("available");
  });

  test("declares mid-turn submit commands only while work is running", () => {
    expect(commandById("composer.submitAsSteer")?.defaultBinding).toBe(null);
    expect(commandById("composer.submitAsFollowUp")?.defaultBinding).toBe(null);
    expect(
      commandById("composer.submitAsSteer")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasComposer: true,
      }),
    ).toEqual({ kind: "unavailable", reason: "no turn is in flight to steer" });
    expect(
      commandById("composer.submitAsFollowUp")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasComposer: true,
      }),
    ).toEqual({ kind: "unavailable", reason: "no turn is in flight to queue against" });
    expect(
      commandById("composer.submitAsSteer")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasComposer: true,
        hasRunningWork: true,
      }).kind,
    ).toBe("available");
    expect(
      commandById("composer.submitAsFollowUp")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasComposer: true,
        hasRunningWork: true,
      }).kind,
    ).toBe("available");
    expect(
      commandById("app.cancel")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasRunningWork: true,
      }).kind,
    ).toBe("available");
  });

  test("declares workspace-set commands with no default key", () => {
    for (const id of [
      "workspace.addRoot",
      "workspace.removeRoot",
      "workspace.save",
      "workspace.load",
      "workspace.show",
    ] as const) {
      expect(commandById(id)?.defaultBinding).toBe(null);
      expect(commandById(id)?.availability(EMPTY_COMMAND_STATE)).toEqual({
        kind: "unavailable",
        reason: "no workspace set yet",
      });
    }
    expect(
      commandById("workspace.addRoot")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasWorkspaceSet: true,
      }).kind,
    ).toBe("available");
    expect(
      commandById("workspace.removeRoot")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasWorkspaceSet: true,
      }),
    ).toEqual({ kind: "unavailable", reason: "only the primary root is bound" });
    expect(
      commandById("workspace.removeRoot")?.availability({
        ...EMPTY_COMMAND_STATE,
        hasWorkspaceSet: true,
        hasRemovableWorkspaceRoot: true,
      }).kind,
    ).toBe("available");
  });

  test("declares no command for a concept that does not exist", () => {
    // Omitted rather than listed as unavailable. There is no task anywhere in
    // the build, so a `task.inspect` row would be inventing a domain.
    const ids = SHELL_COMMANDS.map((command) => command.id);
    for (const absent of ["task.inspect", "task.cancel", "composer.attach"]) {
      expect({ absent, declared: ids.includes(absent) }).toEqual({ absent, declared: false });
    }
  });
});

describe("searching", () => {
  test("matches the title, the keywords, and the id", () => {
    // The id because someone reading the published reference will type
    // `app.exit`, and a palette that only searched display text would not find
    // what the documentation told them to look for.
    expect(searchCommands("exit").map((command) => command.id)).toContain("app.exit");
    expect(searchCommands("quit").map((command) => command.id)).toContain("app.exit");
    expect(searchCommands("app.exit").map((command) => command.id)).toEqual(["app.exit"]);
  });

  test("returns everything for an empty query", () => {
    expect(searchCommands("  ").length).toBe(SHELL_COMMANDS.length);
  });

  test("is case-insensitive and matches nothing when nothing matches", () => {
    expect(searchCommands("EXIT").map((command) => command.id)).toContain("app.exit");
    expect(searchCommands("zzzz")).toEqual([]);
  });
});

describe("conflicts", () => {
  test("the shipped keymap has none", () => {
    expect(bindingConflicts()).toEqual([]);
    expect(planKeymap().ok).toBe(true);
  });

  test("are found, and name both commands", () => {
    // "There is a conflict on escape" tells whoever reads it nothing about which
    // two things to look at.
    const clashing: ShellCommand[] = [
      { ...(commandById("app.help") as ShellCommand), id: "one", defaultBinding: "x" },
      { ...(commandById("app.help") as ShellCommand), id: "two", defaultBinding: "x" },
    ];
    const conflicts = bindingConflicts(clashing);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.commands).toEqual(["one", "two"]);
    expect(conflicts[0]?.binding).toBe("x");
  });

  test("do not count the same key in different contexts", () => {
    // `escape` closing an overlay and `escape` cancelling work is the layering
    // working, not a collision. The shipped registry relies on it.
    const escapes = SHELL_COMMANDS.filter((command) => command.defaultBinding === "escape");
    expect(escapes.length).toBeGreaterThan(1);
    expect(bindingConflicts(escapes)).toEqual([]);
  });

  test("refuse the plan rather than resolving by registration order", () => {
    const clashing: ShellCommand[] = [
      ...SHELL_COMMANDS,
      { ...(commandById("app.help") as ShellCommand), id: "shadow.help" },
    ];
    const verdict = planKeymap(clashing);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(describeRefusal(verdict.refusals[0] as never)).toContain("app.help");
    }
  });
});

describe("the reserved commands", () => {
  test("are bound in the shipped registry", () => {
    expect(missingReservedCommands()).toEqual([]);
    expect(RESERVED_COMMANDS).toContain("app.exit");
  });

  test("cannot be dropped", () => {
    // A customization that unbound the exit would leave someone in a
    // full-screen interface with no way back — and on a terminal in raw mode,
    // that is a window they have to close.
    const withoutExit = SHELL_COMMANDS.filter((command) => command.id !== "app.exit");
    expect(missingReservedCommands(withoutExit)).toEqual(["app.exit"]);
    expect(planKeymap(withoutExit).ok).toBe(false);
  });

  test("cannot be silently unbound either", () => {
    // Removing the key is the same removal as removing the command.
    const unbound = SHELL_COMMANDS.map((command) =>
      command.id === "app.exit" ? { ...command, defaultBinding: null } : command,
    );
    expect(missingReservedCommands(unbound)).toEqual(["app.exit"]);
  });

  test("report every problem at once rather than the first", () => {
    const broken = [
      ...SHELL_COMMANDS.filter((command) => command.id !== "app.exit"),
      { ...(commandById("app.help") as ShellCommand), id: "shadow.help" },
    ];
    const verdict = planKeymap(broken);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.refusals.length).toBe(2);
    }
  });
});

describe("layer resolution", () => {
  test("orders contexts so a narrower one wins", () => {
    expect(CONTEXT_PRIORITY.overlay).toBeGreaterThan(CONTEXT_PRIORITY.global);
    expect(CONTEXT_PRIORITY.confirmation).toBeGreaterThan(CONTEXT_PRIORITY.overlay);
  });

  test("sends escape to the overlay when one is open and to cancel when none is", () => {
    // The layering, read from OpenTUI's own active-key projection.
    expect(activeFor(["global", "overlay"]).has("overlay.close")).toBe(true);
    expect(activeFor(["global", "overlay"]).has("app.cancel")).toBe(false);
    expect(activeFor(["global"]).has("app.cancel")).toBe(true);
  });

  test("consults no inactive context", () => {
    // A binding in a context whose surface does not exist must not shadow a
    // broader one — which is how `escape` in a composer would quietly exit.
    expect(isContextActive("composer", EMPTY_COMMAND_STATE)).toBe(false);
    expect(isContextActive("global", EMPTY_COMMAND_STATE)).toBe(true);
    expect(activeFor(["global"]).has("composer.submit")).toBe(false);
  });

  test("groups bindings by the layer they belong to", () => {
    const global = bindingsForContext(plan(), "global").map((binding) => binding.command);
    expect(global).toContain("app.exit");
    expect(global).not.toContain("overlay.close");
  });

  test("reports the keys that currently do something", () => {
    const active = activeFor(["global"]);
    expect(active.has("app.exit")).toBe(true);
    // `overlay.close` is bound but its context is inactive, so it is not a key
    // that does anything right now.
    expect(active.has("overlay.close")).toBe(false);
  });
});

describe("the rows help and the palette render", () => {
  test("carry the binding that would run now", () => {
    const rows = commandRows(EMPTY_COMMAND_STATE, activeFor(["global"]));
    expect(rows.find((row) => row.id === "app.exit")?.binding).toBe("ctrl+c");
  });

  test("show no binding for a command whose key currently means something else", () => {
    // `app.cancel` owns `escape` until an overlay opens. Showing it afterwards
    // would tell the user to press a key that does something different.
    const rows = commandRows(OVERLAY_OPEN, activeFor(["global", "overlay"]));
    expect(rows.find((row) => row.id === "app.cancel")?.binding).toBe(null);
    expect(rows.find((row) => row.id === "overlay.close")?.binding).toBe("escape");
  });

  test("carry the reason a command cannot run", () => {
    const rows = commandRows(EMPTY_COMMAND_STATE, activeFor(["global"]));
    expect(rows.find((row) => row.id === "composer.submit")?.unavailableReason).toContain(
      "composer",
    );
    expect(rows.find((row) => row.id === "app.exit")?.unavailableReason).toBe(null);
  });

  test("include every command, available or not", () => {
    // A palette that hid unavailable commands would leave someone searching for
    // one and concluding it does not exist.
    expect(commandRows(EMPTY_COMMAND_STATE, activeFor(["global"])).length).toBe(
      SHELL_COMMANDS.length,
    );
  });

  test("show no key for a command that deliberately has none", () => {
    const rows = commandRows(
      { ...EMPTY_COMMAND_STATE, hasConfirmation: true },
      activeFor(["global", "confirmation"]),
    );
    expect(rows.find((row) => row.id === "confirmation.accept")?.binding).toBe(null);
  });
});

describe("bindings while a text control has focus", () => {
  test("withholds bare single-character keys", () => {
    // A layer that claims a key means the focused control never sees it, which
    // was measured against the real keymap rather than assumed. So a composer
    // with `?` bound anywhere above it is a composer that cannot type a question
    // mark, and that is not an inconvenience — it is a text control that is
    // broken for a character prompts use constantly.
    const declared = bindingsForContext(plan(), "global");
    expect(declared.some((binding) => binding.key === "?")).toBe(true);
    expect(bindingsWhileTyping(declared).some((binding) => binding.key === "?")).toBe(false);
  });

  test("keeps every modified and named binding, including both ways out", () => {
    // The rule is deliberately narrow, which is what makes it a re-route of one
    // key rather than a trap: `ctrl+c` and `escape` are the two paths out of a
    // full-screen interface and neither is a bare character.
    const live = bindingsWhileTyping(plan().bindings);
    for (const key of ["ctrl+c", "ctrl+p", "escape", "tab", "shift+tab", "return"]) {
      expect({ key, kept: live.some((binding) => binding.key === key) }).toEqual({
        key,
        kept: true,
      });
    }
  });

  test("recognizes a typed key by what it is rather than from a list", () => {
    for (const key of ["?", "a", "\u00e9"]) {
      expect({ key, typed: isTypedKey(key) }).toEqual({ key, typed: true });
    }
    for (const key of ["ctrl+c", "tab", "escape", "shift+return", " "]) {
      expect({ key, typed: isTypedKey(key) }).toEqual({ key, typed: false });
    }
  });

  test("withholds nothing a command needs to stay listed", () => {
    // Withholding a binding is not removing a command. Every one stays
    // registered, searchable, and reachable from the palette, which is what the
    // composer's own status row points at.
    const withheld = plan().bindings.filter((binding) => isTypedKey(binding.key));
    for (const binding of withheld) {
      expect(commandById(binding.command)).toBeDefined();
    }
  });
});
