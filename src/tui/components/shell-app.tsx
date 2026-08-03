/**
 * The interactive root.
 *
 * `AppShell` is presentational: hand it a model and it draws a frame. This is
 * the component that gives it one that changes — it owns the runtime state,
 * builds the keymap over the live renderer, and derives the model from what the
 * user has done.
 *
 * The split is not ceremony. `AppShell` and every component under it stay
 * testable by handing them a value, and the whole of the interactive behavior
 * sits in one place that can be reasoned about without asking what a frame looks
 * like. It is also what let the theme, layout, and frame ship in #24 before any
 * of this existed.
 *
 * ## The keymap's failure mode
 *
 * `planKeymap` can refuse — a binding conflict, or a reserved command unbound.
 * It refuses by returning rather than throwing, and this component renders the
 * frame anyway with a notice saying what is wrong. A throw here would take the
 * renderer down mid-render and leave the terminal in raw mode, which is the
 * exact failure the reserved commands exist to prevent: refusing to start
 * because the way out is misconfigured would be the worst possible response.
 */

import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/react";
import { useRenderer } from "@opentui/react";
import { type ReactNode, useMemo } from "react";
import { searchCommands } from "../commands.ts";
import { commandRows, describeRefusal, type KeymapPlan, planKeymap } from "../keymap.ts";
import type { ThemeRequest } from "../theme/index.ts";
import type { ShellModel } from "../view-model.ts";
import { AppShell } from "./app-shell.tsx";
import { KeymapBridge } from "./keymap-bridge.tsx";
import { useOverlayRoom } from "./overlay-room.tsx";
import { activeContexts, useShellRuntime } from "./shell-runtime.tsx";

export type ShellAppProps = {
  /** Everything that does not change with interaction: the header, the help prose. */
  readonly model: Omit<ShellModel, "overlay" | "commands">;
  readonly theme: ThemeRequest;
  /** Ends the session. Owned by the invocation's scope, not by this component. */
  readonly onExit: () => void;
  readonly children?: ReactNode;
};

/**
 * An empty plan, for the run whose keymap was refused.
 *
 * No bindings rather than a partial set: a keymap with a conflict in it has an
 * unreachable command, and guessing which one to drop would make the interface
 * behave differently from what help says. The notice carries the reason and
 * every command stays reachable from the palette.
 */
const NO_BINDINGS: KeymapPlan = { bindings: [], unbound: [] };

export function ShellApp(props: ShellAppProps): ReactNode {
  const renderer = useRenderer();
  // `createDefault…` rather than `createOpenTuiKeymap`: the plain constructor
  // returns a keymap with no binding parsers registered, so the first
  // `registerLayer` throws "No keymap binding parsers are registered" — inside a
  // React effect, where nothing surfaces it. The shell shipped with every key
  // silently dead for exactly that reason.
  const keymap = useMemo(() => createDefaultOpenTuiKeymap(renderer), [renderer]);

  const verdict = useMemo(() => planKeymap(), []);
  const plan = verdict.ok ? verdict.plan : NO_BINDINGS;
  const refusal = verdict.ok
    ? null
    : `The keymap was refused: ${verdict.refusals.map(describeRefusal).join("; ")}.`;

  const runtime = useShellRuntime({ plan, onExit: props.onExit });
  // The footer grows to hold an overlay and shrinks back when it closes. See
  // `./overlay-room.tsx` for why this is not a constant.
  useOverlayRoom(runtime.state.overlay.kind !== "none");
  const rows = commandRows(plan, runtime.commandState);

  const model: ShellModel = {
    ...props.model,
    overlay: runtime.state.overlay,
    commands: runtime.state.overlay.kind === "palette" ? rows : [],
    status: {
      ...props.model.status,
      // A refusal outranks anything a command said, and a notice outranks the
      // resting message: the most recent thing that happened is what a status
      // line is for.
      ...(refusal !== null
        ? { status: "error" as const, message: refusal }
        : runtime.state.notice !== null
          ? { status: "warning" as const, message: runtime.state.notice }
          : {}),
      hints: hintsFor(rows),
    },
    help: props.model.help,
  };

  return (
    <KeymapProvider keymap={keymap}>
      <KeymapBridge plan={plan} contexts={activeContexts(runtime.state)} run={runtime.run} />
      <AppShell theme={props.theme} model={model} commandRows={rows}>
        {props.children}
      </AppShell>
    </KeymapProvider>
  );
}

/**
 * The keys the status line advertises.
 *
 * Drawn from the same rows help uses, and only the ones that currently run —
 * a hint for an unavailable command is a promise the interface cannot keep, and
 * the status line is the worst place to make one because it is always visible.
 */
function hintsFor(
  rows: readonly {
    id: string;
    title: string;
    binding: string | null;
    unavailableReason: string | null;
  }[],
) {
  const shown = ["app.exit", "app.help", "app.commandPalette"];
  return shown
    .map((id) => rows.find((row) => row.id === id))
    .filter((row) => row !== undefined && row.binding !== null && row.unavailableReason === null)
    .map((row) => ({
      keys: displayKey(row?.binding ?? ""),
      command: (row?.title ?? "").toLowerCase(),
    }));
}

/**
 * A key as a person writes it.
 *
 * `ctrl+c` is what a binding is called; `^C` is what a status line has room for
 * and what every terminal user already reads. The mapping is here rather than in
 * the registry because it is presentation — help shows the binding's own name.
 */
export function displayKey(binding: string): string {
  const control = /^ctrl\+(.)$/.exec(binding);
  if (control !== null) {
    return `^${(control[1] ?? "").toUpperCase()}`;
  }
  return binding;
}

/** Commands matching a palette query, as rows. Exported for the palette's tests. */
export function paletteRows(
  plan: KeymapPlan,
  state: Parameters<typeof commandRows>[1],
  query: string,
) {
  const matching = new Set(searchCommands(query).map((command) => command.id));
  return commandRows(plan, state).filter((row) => matching.has(row.id));
}
