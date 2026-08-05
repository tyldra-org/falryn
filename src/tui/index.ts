/**
 * The terminal interface area's entrypoint — the half that costs nothing.
 *
 * This module exports the *decision* surface only: the capability record, the
 * launch decision, and shell-capability record. Every one of them is a pure
 * function over facts, and none of them imports an OpenTUI runtime value. That
 * is the whole reason the entrypoint is split.
 *
 * The renderer, the React root, and the shell live in `./shell.tsx`, which
 * `src/cli/dispatch.ts` reaches through a dynamic import and only after the
 * decision here said to launch. A static re-export of the shell would put
 * `@opentui/core` on the module graph of every invocation, so `falryn config
 * show --format json` in a container with no terminal would load a native Zig
 * library through FFI to answer a question about a settings file. It would work.
 * It would also be the reason a headless run got slower and a platform without a
 * prebuilt binary stopped working entirely — for a capability that run never
 * asked for.
 *
 * `src/tui/tui-boundaries.test.ts` asserts the split rather than leaving it to
 * be remembered.
 *
 * Nothing in this area imports a provider SDK, a SQLite adapter, a process
 * launcher, a Git implementation, an MCP transport, or a plugin runtime. It
 * receives facts and returns decisions.
 */

export type {
  CapabilitySource,
  Multiplexer,
  RendererCapabilities,
  ShellCapabilities,
  ShellCapabilitiesRequest,
  ShellOverride,
  TerminalHints,
} from "./capabilities.ts";
export {
  CAPABILITY_SOURCES,
  FIRST_CAPABILITY_GENERATION,
  hasUsableSize,
  MULTIPLEXERS,
  readShellOverride,
  SHELL_OVERRIDE_OFF,
  SHELL_OVERRIDE_VALUES,
  SHELL_OVERRIDE_VARIABLE,
  shellCapabilities,
  terminalHints,
  usesMouse,
  withRendererCapabilities,
  withSize,
} from "./capabilities.ts";
export type { LaunchDecision, NonLaunchReason } from "./launch.ts";
export { decideLaunch, NON_LAUNCH_REASONS, nonLaunchNotice } from "./launch.ts";
/**
 * Types only, and deliberately so.
 *
 * `export type` is erased under `verbatimModuleSyntax`, so naming the session's
 * shapes here costs the module graph nothing. A caller that wants the *values*
 * behind them has to import `./renderer-session.ts` itself, which is exactly the
 * boundary this entrypoint exists to keep.
 */
export type {
  RendererFactory,
  RendererSession,
  RestorableTerminal,
  RestorationReport,
  TerminalMode,
} from "./renderer-session.ts";
