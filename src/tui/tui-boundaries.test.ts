/**
 * Negative controls over the interface area.
 *
 * Like `src/cli-boundaries.test.ts` and `src/sqlite-boundaries.test.ts`, these
 * assert absences. Every one of them guards something that would work perfectly
 * on the day it was written and would remove a guarantee the area exists to
 * provide: that the interface adapts intent rather than doing the work itself,
 * that it never takes the process's exit for itself, and — the one that is
 * easiest to break by accident — that a run which will never open a shell does
 * not load a native renderer to discover that.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const AREA = dirname(import.meta.path);
const SOURCE_ROOT = dirname(AREA);

/** This control file names every forbidden token, so it excludes itself. */
const SELF = "tui-boundaries.test.ts";

/** The pure entrypoint: decisions only, and nothing that loads a renderer. */
const ENTRYPOINT = "index.ts";

/** The modules allowed to reach OpenTUI's runtime. */
const RENDERER_OWNERS = [
  "renderer-session.ts",
  "shell.tsx",
  // The one module that writes above the footer, and the seam that drives it.
  // #356: scrollback is the terminal's own durable region, so the path to it is
  // narrow by construction rather than by convention.
  "scrollback.ts",
  "components/scrollback-commits.tsx",
  // The composer subscribes to keys and pastes. #357: typing is not a command,
  // so the control receives raw input rather than routing every character
  // through the registry.
  "components/composer.tsx",
  // The root measures the viewport through the renderer's own hooks. Nothing
  // below it does: every component reads the frame from context instead, which
  // is what keeps the measurement in one place.
  "components/app-shell.tsx",
  // The interactive root builds the keymap over the live renderer, and the
  // bridge registers layers with it. Both are the seam between a plan this area
  // owns and a dispatcher it does not.
  "components/shell-app.tsx",
  "components/keymap-bridge.tsx",
  // Grows the footer while an overlay is open, which is a renderer setting and
  // nothing else. See `./overlay-room.tsx` for why a constant would not do.
  "components/overlay-room.tsx",
];

/** The one module allowed to author a colour. */
const PALETTE_OWNER = "theme/palette.ts";

/** The modules allowed to name a token, because they define the vocabulary. */
const THEME_CONTRACT = "theme/";

/** The one module that turns a token into what OpenTUI draws with. */
const STYLE_OWNER = "components/primitives.tsx";

/** The seam in the CLI that launches the shell. */
const LAUNCH_SEAM = "cli/dispatch.ts";

async function areaFiles(): Promise<readonly string[]> {
  // Recursive since #24: the theme contract and the components are their own
  // directories, and a control that stopped at the top level would stop looking
  // at exactly the modules most likely to name a colour.
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for await (const entry of glob.scan({ cwd: AREA })) {
    files.push(entry);
  }
  return files.sort();
}

/** Files that are neither tests nor fixtures — the ones that ship. */
function isProduct(file: string): boolean {
  return !/\.test\.tsx?$/.test(file) && !/fixtures\.tsx?$/.test(file);
}

async function readCode(file: string): Promise<string> {
  // Comments stripped, for the reason `src/cli-boundaries.test.ts` states: these
  // modules have every reason to *name* a forbidden token in prose, and
  // explaining why they do not call it is the point.
  return (await readFile(join(AREA, file), "utf8"))
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/[^\n]*/g, "");
}

async function productFiles(): Promise<readonly string[]> {
  return (await areaFiles()).filter((file) => isProduct(file) && file !== SELF);
}

/**
 * A file with every type-only import and export removed.
 *
 * `import type` and `export type` are erased under `verbatimModuleSyntax`, so
 * they put nothing on the module graph and cost nothing to load. The controls
 * below are about what a run *executes*, so naming a renderer's types has to
 * read as what it is — free — while importing its values does not.
 */
function withoutTypeImports(source: string): string {
  return source.replaceAll(/\b(?:import|export)\s+type\s[\s\S]*?from\s+"[^"]*";/g, "");
}

async function readValues(file: string): Promise<string> {
  return withoutTypeImports(await readCode(file));
}

describe("the cost of not launching", () => {
  test("keeps every OpenTUI runtime import out of the entrypoint's graph", async () => {
    // The load-bearing control of this whole area. `src/cli/dispatch.ts` imports
    // `src/tui/index.ts` on every invocation, so anything that entrypoint pulls
    // in is paid for by `falryn config show --format json` in a container with
    // no terminal. A value import of `@opentui/core` here would make that run
    // load a native Zig library through FFI to answer a question about a
    // settings file — and would break outright on a platform with no prebuilt
    // binary, for a capability the run never asked for.
    const reachable = new Set<string>();
    const visit = async (file: string): Promise<void> => {
      if (reachable.has(file)) {
        return;
      }
      reachable.add(file);
      // Type-only edges are not followed: they are erased before anything runs,
      // so a module reached only through one is never loaded at all.
      const source = await readValues(file);
      for (const match of source.matchAll(/from "\.\/([\w./-]+\.tsx?)"/g)) {
        const target = match[1];
        if (target !== undefined) {
          await visit(target);
        }
      }
    };
    await visit(ENTRYPOINT);

    for (const file of reachable) {
      const source = await readValues(file);
      expect({ file, imports: /from "@opentui\//.test(source) }).toEqual({
        file,
        imports: false,
      });
      expect({ file, imports: /from "react"/.test(source) }).toEqual({ file, imports: false });
      // No JSX either, and this is not redundant with the two above: the
      // `jsxImportSource` pragma makes every `.tsx` file import
      // `@opentui/react/jsx-runtime` in its *emitted* output, with nothing in
      // the source naming it. A component reachable from this entrypoint would
      // load the reconciler on a run that never renders anything.
      expect({ file, jsx: file.endsWith(".tsx") }).toEqual({ file, jsx: false });
    }
  });

  test("reaches the shell from the CLI only through a dynamic import", async () => {
    // A static `import { runShell } from "../tui/shell.tsx"` would put the whole
    // renderer on the module graph of every invocation and undo the control
    // above without touching this area at all.
    const seam = (await readFile(join(SOURCE_ROOT, LAUNCH_SEAM), "utf8"))
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/\/\/[^\n]*/g, "");
    expect(seam).toContain('await import("../tui/shell.tsx")');
    expect(seam).not.toMatch(/^import\s[^;]*from "\.\.\/tui\/(?!index\.ts)/m);
  });

  test("names the renderer's runtime in the modules that own it, and no others", async () => {
    for (const file of await productFiles()) {
      const owns = RENDERER_OWNERS.includes(file);
      expect({ file, imports: /from "@opentui\//.test(await readValues(file)) }).toEqual({
        file,
        imports: owns,
      });
    }
  });
});

describe("the interface area", () => {
  test("never takes the process exit for itself", async () => {
    // Interface code skipping cleanup to exit sooner is how a user's terminal is
    // left in raw mode with the alternate screen up. The status is resolved by
    // the one table and the loop is allowed to drain.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      expect({ file, exits: /\bprocess\.exit\s*\(/.test(source) }).toEqual({ file, exits: false });
      expect({ file, sets: /\bprocess\.exitCode\b/.test(source) }).toEqual({ file, sets: false });
    }
  });

  test("names no host standard handle", async () => {
    // `src/integrations/host-terminal.ts` owns them. The renderer is handed the
    // handles by OpenTUI itself; a module here reaching for one directly would
    // be a second owner of what stdout carries.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      expect({
        file,
        handles: /\b(process\.(stdout|stderr|stdin)|Bun\.(stdout|stderr|stdin))\b/.test(source),
      }).toEqual({ file, handles: false });
    }
  });

  test("reaches no console method", async () => {
    for (const file of await productFiles()) {
      expect({
        file,
        logs: /\bconsole\.(log|info|warn|error|debug|trace|dir|table)\b/.test(await readCode(file)),
      }).toEqual({ file, logs: false });
    }
  });

  test("opens no database, launches no process, and touches no filesystem", async () => {
    // The ownership boundary, asserted rather than described. A view model
    // arrives; the work behind it happens somewhere else.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      for (const forbidden of [
        /from "bun:sqlite"/,
        /from "node:fs(\/promises)?"/,
        /from "node:child_process"/,
        /\bBun\.spawn\w*\(/,
        /\b(CREATE\s+TABLE|INSERT\s+INTO|SELECT\s+[\w*]+\s+FROM)\b/i,
      ]) {
        expect({ file, forbidden: forbidden.source, found: forbidden.test(source) }).toEqual({
          file,
          forbidden: forbidden.source,
          found: false,
        });
      }
    }
  });

  test("writes no exit table and no escape sequence of its own", async () => {
    // Two owners already exist: `src/cli/exit.ts` picks the number, and
    // `src/cli/render-human.ts` is the one module entitled to emit an escape.
    // OpenTUI's `destroy()` owns every sequence this area needs.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      expect({ file, table: source.includes("EXIT_CODES = ") }).toEqual({ file, table: false });
      expect({ file, escapes: source.includes("\\u001b[") }).toEqual({ file, escapes: false });
    }
  });

  test("recomputes no terminal capability the domain already derives", async () => {
    // The record extends the domain's facts. A colour or symbol derivation here
    // would be a second answer to whether this terminal can draw a character.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      for (const forbidden of ["function colorLevelFor", "function symbolSupportFor", "NO_COLOR"]) {
        expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({
          file,
          forbidden,
          found: false,
        });
      }
    }
  });

  test("substitutes no width for a terminal that reports none", async () => {
    // The failure this guards is `columns ?? 80`. A terminal that reports
    // nothing is not a narrow terminal.
    for (const file of await productFiles()) {
      const source = await readCode(file);
      expect({ file, substituted: /\b(columns|rows)[^\n]*\?\?\s*[1-9]/.test(source) }).toEqual({
        file,
        substituted: false,
      });
    }
  });

  test("registers exactly one participant for restore-terminal", async () => {
    // A second one would be a second answer to whether the terminal was given
    // back, and the two would disagree on the escalated-interrupt path.
    const owners: string[] = [];
    for (const file of await productFiles()) {
      if ((await readCode(file)).includes('phase: "restore-terminal"')) {
        owners.push(file);
      }
    }
    expect(owners).toEqual(["shutdown.ts"]);
  });
});

describe("the design system", () => {
  test("authors a colour in exactly one module", async () => {
    // A hex string in a view is a colour that cannot be lowered for a 16-colour
    // terminal, cannot be removed for a monochrome one, and cannot be checked
    // for contrast. It would look right on the machine it was written on and
    // nowhere else.
    for (const file of await productFiles()) {
      if (file === PALETTE_OWNER) {
        continue;
      }
      expect({ file, colors: /#[0-9a-fA-F]{6}\b/.test(await readCode(file)) }).toEqual({
        file,
        colors: false,
      });
    }
    expect(await readCode(PALETTE_OWNER)).toMatch(/#[0-9a-fA-F]{6}\b/);
  });

  test("turns a token into a renderer style in exactly one module", async () => {
    // Everything else asks for `error` and gets whatever this terminal can show.
    // A second module setting `fg` would be a second answer to what a token
    // means, reachable on paths where colour was refused.
    const setters: string[] = [];
    for (const file of await productFiles()) {
      if (!file.startsWith("components/")) {
        continue;
      }
      if (/\bfg=\{|\bbackgroundColor=\{|\battributes=\{/.test(await readCode(file))) {
        setters.push(file);
      }
    }
    expect(setters).toEqual([STYLE_OWNER]);
  });

  test("writes no second width rule", async () => {
    // Alignment follows measured cell width. A `.length` used as a width, or a
    // hand-rolled slice, would be right for ASCII and wrong for every wide
    // glyph, combining mark, and emoji sequence a real path contains.
    for (const file of await productFiles()) {
      // Scoped to the components, which is where text is laid out. `toHex` in
      // the palette pads a hex digit, which is formatting a number rather than
      // aligning a cell.
      if (!file.startsWith("components/")) {
        continue;
      }
      const source = await readCode(file);
      for (const forbidden of [
        /function displayWidth/,
        /function truncateToWidth/,
        /function wrapToWidth/,
        /\.padEnd\(/,
        /\.padStart\(/,
        // Slicing a *string* by index is the width bug this guards: it counts
        // UTF-16 units, so it cuts a wide glyph in half. Slicing an array of
        // rows is bounding a list and has nothing to do with cell width, which
        // is why the pattern names the receiver rather than the method.
        /\b(text|line|label|title|value|content)\w*\.slice\(/i,
      ]) {
        expect({ file, forbidden: forbidden.source, found: forbidden.test(source) }).toEqual({
          file,
          forbidden: forbidden.source,
          found: false,
        });
      }
    }
  });

  test("measures through the domain rather than by counting characters", async () => {
    // The positive half: the modules that lay text out do use the measured
    // function, so the control above is holding a line something actually walks.
    expect(await readCode(STYLE_OWNER)).toContain("truncateToWidth");
    expect(await readCode("components/workspace-header.tsx")).toContain("displayWidth");
  });

  test("keeps the theme contract free of the renderer and of React", async () => {
    // Tokens resolve from the domain's own colour and symbol facts, so the whole
    // contract is testable without a terminal — and a component cannot reach a
    // renderer through the theme it reads on every render.
    for (const file of await productFiles()) {
      if (!file.startsWith(THEME_CONTRACT)) {
        continue;
      }
      const source = await readValues(file);
      expect({ file, opentui: /from "@opentui\//.test(source) }).toEqual({ file, opentui: false });
      expect({ file, react: /from "react"/.test(source) }).toEqual({ file, react: false });
    }
  });

  test("selects a symbol repertoire from the domain's own answer", async () => {
    // A second derivation of what this terminal can draw would disagree with the
    // first the day one of them learned about a new locale.
    for (const file of await productFiles()) {
      expect({
        file,
        derived: /function symbolSupportFor/.test(await readCode(file)),
      }).toEqual({ file, derived: false });
    }
    expect(await readCode("theme/symbols.ts")).toContain("SymbolSupport");
  });
});

describe("the transcript surface", () => {
  test("persists no scroll state", async () => {
    // A scroll position is a property of a reading session. Restoring one from a
    // previous run would put a reader somewhere they did not leave, and the only
    // way to be sure it cannot happen is that nothing in this area can write it
    // anywhere that outlives the process.
    for (const file of await productFiles()) {
      if (!file.startsWith("transcript")) {
        continue;
      }
      const source = await readCode(file);
      for (const forbidden of [
        /localStorage/,
        /\bwriteFile\b/,
        /\bBun\.write\b/,
        /\bglobalThis\.[A-Za-z_]+\s*=/,
      ]) {
        expect({ file, forbidden: forbidden.source, found: forbidden.test(source) }).toEqual({
          file,
          forbidden: forbidden.source,
          found: false,
        });
      }
    }
  });

  test("re-derives none of the block model it is given", async () => {
    // The owner boundary #355 names: the surface consumes the projection and the
    // reducer. A second definition of what a block is, or a second fold of a
    // stream into blocks, would be a copy that goes stale.
    for (const file of await productFiles()) {
      if (!file.startsWith("transcript")) {
        continue;
      }
      const source = await readCode(file);
      for (const forbidden of [
        /TRANSCRIPT_BLOCK_KINDS\s*=/,
        /function reduceTranscript/,
        /function applyRevision/,
        /function blockKey/,
      ]) {
        expect({ file, forbidden: forbidden.source, found: forbidden.test(source) }).toEqual({
          file,
          forbidden: forbidden.source,
          found: false,
        });
      }
    }
  });

  test("holds no content of its own, only identities", async () => {
    // Full content is read from its canonical source every time it is drawn.
    // The surface's state is keys, which is what the reducer's type says and
    // what this keeps true of the module that could most easily change it.
    const surface = await readCode("transcript/surface.ts");
    expect(surface).toContain("ReadonlySet<string>");
    expect(surface).not.toMatch(/BoundedText/);
  });

  test("resolves every expansion route to a registered command", async () => {
    // A route is a promise the running build has to keep. The walk over the
    // union lives in `transcript/routes.test.ts`; this asserts the mapping has
    // exactly one owner, so a second one cannot disagree with it.
    const owners: string[] = [];
    for (const file of await productFiles()) {
      if ((await readCode(file)).includes("function commandForRoute")) {
        owners.push(file);
      }
    }
    expect(owners).toEqual(["transcript/routes.ts"]);
  });
});

describe("the composer", () => {
  test("keeps the editing model free of the renderer and of React", async () => {
    // The owner boundary #357 names: graphemes, history, and draft survival are
    // asserted without a terminal, which only stays true while nothing in the
    // model can reach one.
    for (const file of await productFiles()) {
      if (!file.startsWith("composer/")) {
        continue;
      }
      const source = await readValues(file);
      expect({ file, opentui: /from "@opentui\//.test(source) }).toEqual({ file, opentui: false });
      expect({ file, react: /from "react"/.test(source) }).toEqual({ file, react: false });
    }
  });

  test("persists no draft and no history", async () => {
    // Nothing outlives the session. History is where text survives the moment it
    // was typed, so it is also the one place a secret that slipped past the
    // refusal could resurface days later — and the only way to be sure it cannot
    // is that nothing here can write anywhere durable.
    for (const file of await productFiles()) {
      if (!file.startsWith("composer/")) {
        continue;
      }
      const source = await readCode(file);
      for (const forbidden of [
        /localStorage/,
        /\bwriteFile\b/,
        /\bBun\.write\b/,
        /from "bun:sqlite"/,
        /\bglobalThis\.[A-Za-z_]+\s*=/,
      ]) {
        expect({ file, forbidden: forbidden.source, found: forbidden.test(source) }).toEqual({
          file,
          forbidden: forbidden.source,
          found: false,
        });
      }
    }
  });

  test("writes no second rule for what a secret looks like", async () => {
    // `looksSecret` in `./paste.ts` is the one weak signal, and
    // `src/application/redaction.ts` owns the strong one. A pattern of this
    // module's own would be a third answer that disagrees with both the first
    // time any of them learned about a new credential shape.
    const history = await readCode("composer/history.ts");
    expect(history).toContain("looksSecret");
    for (const file of await productFiles()) {
      if (!file.startsWith("composer/")) {
        continue;
      }
      const source = await readCode(file);
      for (const forbidden of [/\bapi[_-]?key\b/i, /\bBearer\b/, /PRIVATE KEY/]) {
        expect({ file, forbidden: forbidden.source, found: forbidden.test(source) }).toEqual({
          file,
          forbidden: forbidden.source,
          found: false,
        });
      }
    }
  });

  test("segments graphemes through the domain rather than its own segmenter", async () => {
    // What a character is has one owner. A second `Intl.Segmenter` would be a
    // second answer, and the two would disagree the first time either was
    // configured differently.
    const segmenters: string[] = [];
    for (const file of await productFiles()) {
      if ((await readCode(file)).includes("new Intl.Segmenter")) {
        segmenters.push(file);
      }
    }
    expect(segmenters).toEqual([]);
    expect(await readCode("composer/editor.ts")).toContain("graphemes");
  });

  test("routes every submission through the declared port", async () => {
    // Not a stub agent loop behind the button. The one implementation in this
    // build refuses and says why, and a second submit path would be a second
    // answer to what happens to a turn.
    const ports: string[] = [];
    for (const file of await productFiles()) {
      if ((await readCode(file)).includes("SubmissionPort = {")) {
        ports.push(file);
      }
    }
    expect(ports).toEqual(["composer/submission.ts"]);
  });

  test("reserves the composer's rows in the layout rather than in the view", async () => {
    // The transcript sizes its window from what is left, so the two numbers have
    // to come from one function. A composer that drew a row more than the layout
    // reserved would overdraw the transcript's last line, and it would read as a
    // rendering glitch rather than the arithmetic disagreement it is.
    const declarers: string[] = [];
    for (const file of await productFiles()) {
      if ((await readCode(file)).includes("export function composerRows")) {
        declarers.push(file);
      }
    }
    expect(declarers).toEqual(["layout.ts"]);
    expect(await readCode("components/composer.tsx")).toContain("frame.composerRows");
  });
});

describe("the scrollback boundary", () => {
  test("writes above the footer from exactly one module", async () => {
    // The negative control #356 names. Scrollback is append-only and outlives
    // the process: a row committed to it cannot be repainted, reordered, or
    // taken back. A second writer would be a second ordering rule over the same
    // FIFO, and the two would interleave differently on the day either changed —
    // in the reader's permanent scroll history, where nothing can correct it.
    const writers: string[] = [];
    for (const file of await productFiles()) {
      const source = await readCode(file);
      if (/\b(writeToScrollback|createScrollbackSurface)\s*\(/.test(source)) {
        writers.push(file);
      }
    }
    expect(writers).toEqual(["scrollback.ts"]);
  });

  test("asks the mode contract whether there is a footer at all", async () => {
    // `alternate-screen` and `main-screen` draw into the whole terminal, and
    // OpenTUI's scrollback APIs throw rather than degrade when the mode is
    // wrong. Consulted rather than assumed, and consulted on every commit:
    // renderer mode is application state, so a check done once at construction
    // would be right until the first mode change.
    expect(await readCode("scrollback.ts")).toContain("reservesFooter(host.screenMode)");
  });

  test("is driven by a product caller rather than only exported", async () => {
    // #351 in this boundary's terms. An adapter nothing mounts is a capability
    // that compiles, and the acceptance criterion is about what reaches a
    // terminal.
    expect(await readCode("components/app-shell.tsx")).toContain("<ScrollbackCommits");
  });

  test("keeps the adapter off the pure entrypoint's re-exports", async () => {
    // `./transcript/index.ts` is imported by modules that must not load a
    // renderer. The lines it resolves are pure and belong there; the adapter
    // that draws them is not and does not.
    const surface = await readValues("transcript/index.ts");
    expect(surface).not.toContain("scrollback.ts");
  });
});

describe("the activity rail", () => {
  test("persists no ephemeral view state", async () => {
    // The acceptance criterion. Focus, scroll, and animation are properties of a
    // reading session; restoring one from a previous run would put a reader
    // somewhere they did not leave, and the only way to be sure it cannot happen
    // is that nothing here can write anywhere that outlives the process.
    for (const file of await productFiles()) {
      if (!file.startsWith("activity") && file !== "components/activity-rail.tsx") {
        continue;
      }
      const source = await readCode(file);
      for (const forbidden of [
        /localStorage/,
        /\bwriteFile\b/,
        /\bBun\.write\b/,
        /from "bun:sqlite"/,
        /\bglobalThis\.[A-Za-z_]+\s*=/,
      ]) {
        expect({ file, forbidden: forbidden.source, found: forbidden.test(source) }).toEqual({
          file,
          forbidden: forbidden.source,
          found: false,
        });
      }
    }
  });

  test("maps a status token in one module, and the projection authors none", async () => {
    // The same split the transcript makes. The projection says `cancelling` and
    // `uncertain`; what those look like is the theme's answer, made where the
    // terminal's capabilities are known.
    const owners: string[] = [];
    for (const file of await productFiles()) {
      if ((await readCode(file)).includes("function statusOfActivity")) {
        owners.push(file);
      }
    }
    expect(owners).toEqual(["activity/rows.ts"]);
  });

  test("draws the rail only where the layout says a panel belongs", async () => {
    // One persistent contextual surface on wide layouts, and no permanently
    // tiled control centre. The predicate is consulted rather than a width being
    // compared a second time.
    expect(await readCode("components/app-shell.tsx")).toContain("hasContextPanel(");
    expect(await readCode("components/app-shell.tsx")).toContain("<ActivityRail");
  });

  test("projects health in one place, so the rail and the status line agree", async () => {
    // Two components each deriving a level from overlapping inputs is exactly
    // how a status line says "idle" beside a rail showing a failure.
    const callers: string[] = [];
    for (const file of await productFiles()) {
      if (/\bprojectHealth\(/.test(await readCode(file))) {
        callers.push(file);
      }
    }
    expect(callers).toEqual(["components/shell-app.tsx", "shell-model.ts"]);
  });
});

describe("the mode contract", () => {
  test("is consulted by the renderer configuration rather than only exported", async () => {
    // #351 in one assertion. `capturesStdout` existed, was exported, was
    // re-exported from the entrypoint, and had three tests — and no product
    // caller, so the configuration used a constant and two of the three screen
    // modes could not start. A predicate nothing calls is not a contract, it is
    // a comment that compiles.
    expect(await readCode("renderer-session.ts")).toContain("capturesStdout(");
  });

  test("names every screen mode in one list", async () => {
    // So a check can walk them. Each mode being named individually wherever
    // somebody remembered to name it is why nothing noticed that two of them
    // were unreachable.
    const declarers: string[] = [];
    for (const file of await productFiles()) {
      if ((await readCode(file)).includes("SCREEN_MODES: readonly ScreenMode[]")) {
        declarers.push(file);
      }
    }
    expect(declarers).toEqual(["screen-mode.ts"]);
  });
});
