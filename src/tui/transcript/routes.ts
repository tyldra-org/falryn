/**
 * An expansion route is a command, or it is a lie.
 *
 * The projections contract already says a route is "a promise the running build
 * has to keep, and a phrase nobody dispatches is a promise nobody checks". This
 * module is where that promise is actually kept: every value of
 * `ExpansionRoute` resolves here to a registered command id, and
 * `./routes.test.ts` walks the union to prove it. A route added without a
 * command fails a test rather than reaching a user as an offer nothing honours.
 *
 * The two directions of naming are kept apart on purpose. A *route* is a
 * projection's vocabulary and uses the contract's own spelling; a *command* is
 * the registry's identity and uses the registry's. Mapping them here means
 * neither side has to adopt the other's naming to stay honest.
 */

import type { ExpansionRoute } from "../../presentation/index.ts";
import type { CommandEntry } from "../view-model.ts";

/** The command each route dispatches. */
export function commandForRoute(route: ExpansionRoute): string {
  switch (route) {
    case "transcript.expand":
      return "transcript.expand";
    case "transcript.open-artifact":
      return "transcript.openArtifact";
    case "transcript.show-diagnostics":
      return "transcript.showDiagnostics";
  }
}

/**
 * One sentence offering a route, in the terms a reader can act on.
 *
 * The key when there is one, the command's name when there is not, and the
 * reason when the command exists but cannot run. That third case is the one
 * that matters: an artifact viewer does not exist in this build, so a block
 * clipped from an artifact must say "opening artifacts is unavailable: no
 * artifact viewer yet" rather than offering a key that would do nothing.
 */
export function describeRouteWith(rows: readonly CommandEntry[], route: ExpansionRoute): string {
  const id = commandForRoute(route);
  const row = rows.find((entry) => entry.id === id);
  if (row === undefined) {
    // A route with no command at all. The control in `./routes.test.ts` makes
    // this unreachable through the registry; saying so is better than silence
    // if a caller supplies its own rows.
    return `No command named ${id}.`;
  }
  if (row.unavailableReason !== null) {
    return `${row.title} is unavailable: ${row.unavailableReason}.`;
  }
  return row.binding === null
    ? `Run ${row.title}.`
    : `Press ${row.binding} to ${lower(row.title)}.`;
}

function lower(title: string): string {
  return title.charAt(0).toLowerCase() + title.slice(1);
}
