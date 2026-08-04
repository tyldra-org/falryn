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
  // The palette's search field. #364: a search field is a focused text control,
  // and routing every character through the command registry would put a
  // dispatch between a keystroke and the character it produces. Help shares this
  // module and subscribes to nothing.
  "components/overlay-routes.tsx",
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

/**
 * The shared test harness, which is test support and ships in nothing.
 *
 * Named here rather than matched by a pattern, so widening the exemption is a
 * deliberate edit to this line. #374: the controls below ask what a *run* loads,
 * and this module is loaded by `bun test` and by nothing else — which the
 * control in "the rendered test harness" asserts rather than assumes.
 */
const HARNESS = "harness.tsx";

/** Files that are neither tests, fixtures, nor the harness — the ones that ship. */
function isProduct(file: string): boolean {
  return !/\.test\.tsx?$/.test(file) && !/fixtures\.tsx?$/.test(file) && file !== HARNESS;
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

describe("the command palette", () => {
  test("narrows through the registry's own matcher, in one place", async () => {
    // No second matcher. `searchCommands` is what the published reference
    // describes, and a palette that filtered differently would find different
    // commands from the ones the documentation says it will.
    const matchers: string[] = [];
    for (const file of await productFiles()) {
      if ((await readCode(file)).includes("function paletteRows")) {
        matchers.push(file);
      }
    }
    expect(matchers).toEqual(["components/shell-app.tsx"]);
    expect(await readCode("components/shell-app.tsx")).toContain("searchCommands(");
  });

  test("is driven by a product caller rather than only exported", async () => {
    // #364 in one assertion, and the failure it records: `paletteRows` existed,
    // was exported, and had tests — and no product caller, so the palette was
    // handed a literal empty query and typing narrowed nothing. A matcher
    // nothing matches with is not a feature, it is a function that compiles.
    const source = await readCode("components/shell-app.tsx");
    expect(source).toContain("paletteRows(plan,");
    expect(await readCode("components/app-shell.tsx")).not.toContain('query=""');
  });

  test("holds the query on the route rather than beside it", async () => {
    // Which is what makes "closing clears the search" true by construction:
    // closing replaces the route, so there is nowhere a stale query can survive.
    expect(await readCode("view-model.ts")).toContain(
      'kind: "palette"; readonly query: EditorState',
    );
  });

  test("does not clamp its content budget up to a minimum", async () => {
    // The root cause of both #364 defects, and the only part of them a source
    // control can see. `Math.max(1, rows - 1)` promises a row that the caller
    // may not have given, so the palette drew the search line plus a notice into
    // a one-row panel — and a terminal does not clip, it overdraws.
    //
    // What the palette actually draws is measured in
    // `./palette.test.tsx`, at every budget. This guards the shape that made the
    // measurement wrong, because a clamp reads as defensive rather than as the
    // overdraw it is.
    const source = await readCode("components/overlay-routes.tsx");
    const palette = source.slice(source.indexOf("export function CommandPalette"));
    expect(palette).not.toContain("Math.max(1, props.rows");
  });

  test("is handed a budget the host does not clamp up either", async () => {
    // #366: the same shape, one level up. The host reserved three rows and then
    // clamped what remained to `Math.max(1, height - 3)`, so at the reveal's
    // three-row step it promised a row that the border and the hint had already
    // spent — and the palette's search line landed on the dismissal hint.
    //
    // Guarded on the function that decides the split rather than the whole
    // module, so the rule stays about the budget handed to a route rather than
    // about every arithmetic clamp in the file.
    const source = await readCode("components/overlay.tsx");
    const start = source.indexOf("export function overlayRows");
    // Asserted, not assumed. Slicing from a missing marker yields a string that
    // contains nothing, so without this the control passes against exactly the
    // code it exists to reject — which is how #364 shipped a test that agreed
    // with its own bug.
    expect(start).toBeGreaterThan(0);
    const rows = source.slice(start);
    expect(rows.slice(0, rows.indexOf("\n}"))).not.toContain("Math.max(1");
  });
});

describe("the activity projection", () => {
  test("is folded by a product caller rather than only by its tests", async () => {
    // #370, and the same failure #364 recorded one surface over: a correct,
    // fixture-proved reducer with nothing calling it, behind a rail that
    // rendered a constant. `reduceActivity` and `resubscribeActivity` were
    // exported from the presentation barrel and reached only by tests.
    const callers: string[] = [];
    for (const file of await productFiles()) {
      if ((await readCode(file)).includes("reduceActivity(")) {
        callers.push(file);
      }
    }
    expect(callers).toEqual(["runtime-feed.ts"]);
    // Both halves. The resume path is what makes a cursor worth carrying, and a
    // caller that only ever rebuilt would leave it decorative.
    expect(await readCode("runtime-feed.ts")).toContain("resubscribeActivity(");
    expect(await readCode("shell.tsx")).toContain("useRuntimeProjection(");
  });

  test("is read through a feed rather than through the scope tree itself", async () => {
    // A view holding a `ScopeTree` could cancel a scope. The two modules that
    // name it are the adapter that narrows it to three read-only questions and
    // the shell that hands it over; no component sees it at all.
    const holders: string[] = [];
    for (const file of await productFiles()) {
      if (/\bScopeTree\b/.test(await readCode(file))) {
        holders.push(file);
      }
    }
    expect(holders.toSorted()).toEqual(["runtime-feed.ts", "shell.tsx"]);
    for (const file of await productFiles()) {
      if (!file.startsWith("components/")) {
        continue;
      }
      const source = await readCode(file);
      // The mutating half of the tree's surface. A component that could reach
      // any of these is a view that can stop work it is only meant to describe.
      for (const forbidden of [".cancel(", ".complete(", ".acknowledge(", ".recordEffect("]) {
        expect({ file, forbidden, found: source.includes(forbidden) }).toEqual({
          file,
          forbidden,
          found: false,
        });
      }
    }
  });
});

describe("the frame's row arithmetic", () => {
  test("is one function rather than one subtraction per region", async () => {
    // #368. The overlay host kept its own `RESERVED_FRAME_ROWS = 2` — the header
    // and the status line — written before #357 put a composer between them and
    // never raised. The transcript meanwhile sized itself with `primaryRows`,
    // which does account for the composer, so the two regions disagreed by three
    // rows and the panel drew over the status line on a short terminal.
    //
    // The rule is not "the constant must be bigger". It is that a region does not
    // get to hold its own opinion of what the frame costs.
    const source = await readCode("components/overlay.tsx");
    expect(source).not.toContain("RESERVED_FRAME_ROWS");
    expect(source).toContain("primaryRows(frame.viewport, frame.composerRows)");
  });

  test("is used by every region that has to fit beside another", async () => {
    // Named callers rather than a count, so adding a region that sizes itself
    // from the raw viewport is a failure here rather than a smear on a short
    // terminal three issues later.
    const callers: string[] = [];
    for (const file of await productFiles()) {
      if ((await readCode(file)).includes("primaryRows(frame.viewport")) {
        callers.push(file);
      }
    }
    expect(callers.toSorted()).toEqual(["components/overlay.tsx", "components/transcript.tsx"]);
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

describe("the rendered test harness", () => {
  /** Every check in this area, which is what the harness exists for. */
  async function testFiles(): Promise<readonly string[]> {
    return (await areaFiles()).filter((file) => /\.test\.tsx?$/.test(file) && file !== SELF);
  }

  /** The checks that mount through the harness. */
  async function consumers(): Promise<readonly string[]> {
    const files: string[] = [];
    for (const file of await testFiles()) {
      if ((await readValues(file)).includes(`/${HARNESS}"`)) {
        files.push(file);
      }
    }
    return files.toSorted();
  }

  test("is loaded by checks and by nothing that ships", async () => {
    // The exemption in `isProduct` is only safe while this holds. A product
    // module importing the harness would put `@opentui/core/testing` on the
    // graph of a real run, which is the one thing the controls at the top of
    // this file exist to prevent.
    const files = await productFiles();
    // A control that walks an empty list passes against anything, which is the
    // way #366's own control was found to be worthless.
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect({ file, imports: (await readValues(file)).includes(HARNESS) }).toEqual({
        file,
        imports: false,
      });
    }
  });

  test("is where every rendered check mounts", async () => {
    // Not an aspiration: the nine files #374 consolidated are named, so a tenth
    // rendered check that rolls its own setup shows up here as a difference
    // rather than as a slow drift back to nine copies.
    expect(await consumers()).toEqual([
      // #376: the coalescing check mounts the same tree every other rendered
      // check mounts, which is why it is here rather than standing up a
      // renderer of its own.
      "coalescing.test.tsx",
      "components/activity-rail.test.tsx",
      "components/composer.test.tsx",
      "components/frame.test.tsx",
      "components/interaction.test.tsx",
      "components/palette.test.tsx",
      "components/scrollback-commits.test.tsx",
      "components/transcript.test.tsx",
      // The harness's own checks, which are what prove it cleans up.
      "harness.test.tsx",
      "runtime-feed.test.tsx",
      "scrollback.test.ts",
    ]);
  });

  test("owns teardown, so no check that uses it declares its own", async () => {
    // The acceptance criterion, as a control. A renderer is process-wide state:
    // one that outlives its check fails the *next* one, so teardown being in
    // nine places was nine chances to get it subtly different.
    const files = await consumers();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readCode(file);
      // `renderer.destroy()` specifically: `scrollback.test.ts` destroys the
      // *adapter* it is testing, which is the subject rather than the setup.
      expect({ file, destroys: /renderer\.destroy\(\)/.test(source) }).toEqual({
        file,
        destroys: false,
      });
      expect({ file, hooks: /\bafterEach\s*\(/.test(source) }).toEqual({ file, hooks: false });
    }
  });

  test("mounts the React tree, so no check creates a root of its own", async () => {
    // `createRoot` without a matching `unmount` is the leak that survives
    // destroying a renderer: effects stay subscribed to something that is gone.
    const roots: string[] = [];
    for (const file of await areaFiles()) {
      if (file !== SELF && /\bcreateRoot\s*\(/.test(await readValues(file))) {
        roots.push(file);
      }
    }
    expect(roots.toSorted()).toEqual([HARNESS, "shell.tsx"]);
  });

  test("declares the settle predicate once", async () => {
    // #372 corrected this predicate in one file while eight others went on
    // settling by a fixed flush count. One declaration is what stops the next
    // correction from reaching one ninth of the checks.
    const declarers: string[] = [];
    for (const file of await areaFiles()) {
      if (file !== SELF && /function hasPainted\b/.test(await readCode(file))) {
        declarers.push(file);
      }
    }
    expect(declarers).toEqual([HARNESS]);
  });
});
