/**
 * Appearance the environment asks for, rather than the terminal reports.
 *
 * Two preferences that are neither a capability nor a command option, so neither
 * `src/domain/terminal.ts` nor `src/cli/options.ts` owns them. They live beside
 * `FALRYN_TUI` for the same reason it does: a user on a terminal Falryn has
 * never run on needs a way to say what they want without waiting for a release.
 *
 * Both are read once and turned into a resolved theme. Nothing downstream sees
 * a variable name.
 */

import type { EnvironmentPort } from "../domain/index.ts";
import type { ShellCapabilities } from "./capabilities.ts";
import { THEME_VARIANTS, type ThemeVariant } from "./theme/index.ts";

/** Names a theme variant, or is unset to let the terminal's own preference decide. */
export const THEME_VARIABLE = "FALRYN_THEME";

/**
 * `off` reduces motion. Anything else, including unset, leaves it alone.
 *
 * There is no cross-tool convention for motion the way `NO_COLOR` is one for
 * colour, so this is Falryn's own and is documented as such. `NO_COLOR` is
 * deliberately *not* read here: refusing colour and refusing motion are
 * different requests, and someone who wants a plain palette has not asked for a
 * different transition.
 */
export const MOTION_VARIABLE = "FALRYN_MOTION";
export const MOTION_OFF = "off";

/** Every value the theme variable accepts, for a diagnostic that names them. */
export const THEME_VALUES: readonly string[] = THEME_VARIANTS;

/**
 * The variant the environment asked for.
 *
 * `null` for unset *and* for a value this build does not understand. Unlike the
 * interactive-shell override, an unrecognized theme is not worth a diagnostic of its
 * own: getting the default palette is a visible outcome on its own, where a
 * silently ignored `FALRYN_TUI` would leave someone wondering why the shell
 * still opened.
 */
export function requestedVariant(environment: EnvironmentPort): ThemeVariant | null {
  const value = environment.get(THEME_VARIABLE);
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return THEME_VARIANTS.find((variant) => variant === normalized) ?? null;
}

/**
 * Whether this run should reduce motion.
 *
 * Three sources, any of which is enough. The explicit request is the one a user
 * makes; the other two are cases where motion is either impossible or pointless:
 * a terminal that renders nothing beyond plain text cannot animate, and an
 * automated run has nobody watching a transition. Reducing motion in CI is not
 * cosmetic — it removes frames from a recorded log that exist only for a human
 * eye that is not there.
 */
export function prefersReducedMotion(
  environment: EnvironmentPort,
  capabilities: ShellCapabilities,
): boolean {
  if (environment.get(MOTION_VARIABLE)?.trim().toLowerCase() === MOTION_OFF) {
    return true;
  }
  return capabilities.hints.dumbTerminal || capabilities.hints.ci;
}

/**
 * Whether to use the narrower Unicode set.
 *
 * A multiplexer rewrites escape sequences on their way through and a remote
 * session adds a link that may not carry a glyph unchanged. Neither means the
 * terminal lacks Unicode — the domain already answered that — so this selects a
 * conservative repertoire rather than dropping to ASCII, which would throw away
 * characters that work fine.
 */
export function prefersConservativeSymbols(capabilities: ShellCapabilities): boolean {
  return capabilities.hints.multiplexer !== null || capabilities.hints.remote;
}
