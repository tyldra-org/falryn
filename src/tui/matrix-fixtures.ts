/**
 * The machine-readable TUI matrix inventory.
 *
 * This is test support, not a product registry. A row is either owned by a
 * named test (the control proves that the file still contains that test name)
 * or by an inline manual result that names the platform. The control deliberately
 * does not claim that a named test ran or passed, and it cannot read the docs
 * repository where the prose qualification record lives.
 */

export type MatrixTestOwner = {
  readonly kind: "test";
  readonly file: string;
  readonly test: string;
};

export type MatrixManualOwner = {
  readonly kind: "manual";
  readonly platform: string;
  readonly result: string;
};

export type MatrixOwner = MatrixTestOwner | MatrixManualOwner;

export type MatrixRow = {
  readonly id: string;
  readonly description: string;
  readonly owner: MatrixOwner | null;
};

/**
 * Rows from #27's children, including rows that are deliberately unqualified.
 * The source-tree owners are named here once so a new row cannot be added only
 * to the documentation and look covered.
 */
export const TUI_MATRIX: readonly MatrixRow[] = [
  {
    id: "launch-modes",
    description: "interactive, piped, redirected, CI, dumb-terminal, and no-dimension launch paths",
    owner: {
      kind: "test",
      file: "src/tui/launch.test.ts",
      test: "is reachable from some combination",
    },
  },
  {
    id: "renderer-screen-modes",
    description: "alternate-screen renderer configuration and lifecycle ownership",
    owner: {
      kind: "test",
      file: "src/tui/renderer-session.test.ts",
      test: "always requests the full alternate screen",
    },
  },
  {
    id: "renderer-restoration",
    description: "single renderer, idempotent restoration, and failure cleanup",
    owner: { kind: "test", file: "src/tui/shell.test.tsx", test: "gives the terminal back" },
  },
  {
    id: "theme-layout-motion",
    description: "theme, width class, status, and reduced-motion frame matrix",
    owner: {
      kind: "test",
      file: "src/tui/components/frame.test.tsx",
      test: "renders in every variant",
    },
  },
  {
    id: "keyboard-journey",
    description: "help, palette, escape, and interrupt bindings",
    owner: {
      kind: "test",
      file: "src/tui/components/interaction.test.tsx",
      test: "opens help, closes it",
    },
  },
  {
    id: "unicode-widths",
    description: "grapheme, combining, wide-glyph, emoji, invalid-byte, and ASCII width behavior",
    owner: {
      kind: "test",
      file: "src/domain/text-display.test.ts",
      test: "never exceeds the width",
    },
  },
  {
    id: "native-assets",
    description: "native renderer and Tree-sitter assets in source and compiled modes",
    owner: { kind: "test", file: "src/tui/probe.test.tsx", test: "loads the native renderer" },
  },
  {
    id: "compiled-walk",
    description: "compiled pseudo-terminal interaction, resize, exit, and restoration",
    owner: { kind: "test", file: "src/tui/shell.compiled.test.ts", test: "opens help, scrolls" },
  },
  {
    id: "shared-render-harness",
    description: "one mounted-renderer harness with scope-bound teardown",
    owner: {
      kind: "test",
      file: "src/tui/harness.test.tsx",
      test: "destroys the renderer when the scope",
    },
  },
  {
    id: "painted-unicode",
    description: "Unicode and ASCII content through a painted frame",
    owner: {
      kind: "test",
      file: "src/tui/components/frame.test.tsx",
      test: "never draws a row wider",
    },
  },
  {
    id: "resize-storm",
    description: "a resize burst preserves the active view and settles at the final shape",
    owner: { kind: "test", file: "src/tui/components/frame.test.tsx", test: "survives a storm" },
  },
  {
    id: "shell-resource-measurements",
    description: "six gated shell resource measurements with platform and distributions",
    owner: {
      kind: "test",
      file: "src/data/measurement.test.ts",
      test: "measures startup to first draw",
    },
  },
  {
    id: "mounted-frame-coalescing",
    description: "a mounted shell preserves every semantic terminal outcome under a burst",
    owner: {
      kind: "test",
      file: "src/data/measurement.test.ts",
      test: "keeps every semantic outcome visible",
    },
  },
  {
    id: "macos-arm64-qualification",
    description: "manual qualification of the compiled artifact and terminal interaction",
    owner: {
      kind: "manual",
      platform: "macOS arm64, Ghostty 1.3.1, zsh 5.9, no multiplexer, C.UTF-8",
      result:
        "compiled artifact and renderer controls recorded; human emulator steps remain unqualified",
    },
  },
  {
    id: "linux-qualification",
    description: "Linux terminal qualification",
    owner: {
      kind: "manual",
      platform: "Linux targets",
      result: "not qualified: no Linux host was exercised",
    },
  },
  {
    id: "windows-qualification",
    description: "Windows terminal qualification",
    owner: {
      kind: "manual",
      platform: "Windows targets",
      result: "not qualified: no Windows host was exercised",
    },
  },
  {
    id: "other-target-qualification",
    description: "all other operating-system and architecture targets",
    owner: {
      kind: "manual",
      platform: "Other operating systems and architectures",
      result: "not qualified: no host was exercised",
    },
  },
  {
    id: "suspend-resume",
    description: "terminal suspend/resume and capability refresh",
    owner: {
      kind: "manual",
      platform: "All targets",
      result: "not qualified: suspend/resume refresh remains a documented design target",
    },
  },
  {
    id: "clipboard-modes",
    description: "clipboard present and absent",
    owner: {
      kind: "manual",
      platform: "All targets",
      result: "not qualified: no clipboard consumer exists in this build",
    },
  },
  {
    id: "rtl-mixed-text",
    description: "RTL and mixed-text rendering",
    owner: {
      kind: "manual",
      platform: "All targets",
      result: "not qualified: the current contract supports this only where a producer exists",
    },
  },
  {
    id: "multiplexer-remote",
    description: "multiplexer and remote-shell behavior",
    owner: {
      kind: "manual",
      platform: "macOS arm64 qualification host",
      result: "not qualified: no multiplexed or remote session was exercised",
    },
  },
] as const;

/** Rows that do not have either a named test owner or a manual result. */
export function rowsWithoutOwner(rows: readonly MatrixRow[]): readonly MatrixRow[] {
  return rows.filter((row) => {
    if (row.owner === null) {
      return true;
    }
    if (row.owner.kind === "test") {
      return row.owner.file.trim() === "" || row.owner.test.trim() === "";
    }
    return row.owner.platform.trim() === "" || row.owner.result.trim() === "";
  });
}
