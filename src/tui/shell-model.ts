/**
 * What the shell can honestly say about itself today.
 *
 * A pure function from the invocation's options to a view model, so the frame's
 * content is testable without a renderer and the components stay functions of
 * data they were handed.
 *
 * Most of this model is `unavailable`, and that is the point rather than a gap
 * waiting to be filled. There is no producer of sessions, models, or Git state
 * yet, so a header that showed a dash — or worse, a plausible default — would be
 * telling a user something Falryn does not know. Each `unavailable` carries the
 * reason, which is what turns "we cannot show this" into "nothing produces this
 * yet".
 */

import type { GlobalOptions } from "../cli/index.ts";
import { known, type ShellModel, unavailable } from "./view-model.ts";

/**
 * The keys this build actually honours.
 *
 * Exactly one, and it is not a keymap: interrupt reaches the shell through the
 * invocation's cancellation scope because the renderer was created with
 * `exitSignals: []`. #26 introduces bindings; advertising one here that nothing
 * dispatched would be a promise the interface cannot keep.
 */
export const SHELL_KEY_HINTS = [{ keys: "^C", command: "exit" }] as const;

/** What the help overlay explains. True sentences about the build that ships it. */
export const SHELL_HELP = [
  {
    title: "Where this is",
    body:
      "Falryn's interface is running, but nothing is behind it yet. There is no " +
      "conversation, no composer, and no commands — those arrive with the views " +
      "and the input model.",
  },
  {
    title: "Leaving",
    body:
      "Ctrl+C ends the session. It reaches Falryn's own cancellation rather than " +
      "the renderer's, so the terminal is restored on the way out. A --timeout " +
      "ends it the same way.",
  },
  {
    title: "If it looks wrong",
    body:
      "FALRYN_THEME selects dark, light, monochrome, or high-contrast. " +
      "FALRYN_MOTION=off removes transitions. FALRYN_TUI=off skips the interface " +
      "entirely and prints help instead.",
  },
] as const;

export function shellModel(options: GlobalOptions): ShellModel {
  return {
    header: {
      // The one fact this build genuinely has. With no `--workspace`, Falryn
      // operates on the current directory — a true statement that needs no
      // filesystem to make, which matters because this area may not touch one.
      workspace: options.workspace === null ? known("current directory") : known(options.workspace),
      branch: unavailable("no Git yet"),
      session: unavailable("no session yet"),
      model: unavailable("no provider yet"),
    },
    status: {
      status: "informational",
      message: "Interface only; nothing is running.",
      hints: [...SHELL_KEY_HINTS],
    },
    // Nothing opens an overlay: there are no bindings until #26. The routes are
    // mounted by `AppShell` and reachable from a caller that sets this.
    overlay: { kind: "none" },
    // Genuinely empty rather than staged. The palette renders its empty state,
    // which is the honest thing for a build with no commands to run.
    commands: [],
    help: [...SHELL_HELP],
  };
}
