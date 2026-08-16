/**
 * Focused confirmations and protected secret input, on a real terminal.
 *
 * The sheet is an overlay over one immutable intent. Labelled keys belong to
 * this confirmation, not to a reusable registry binding. A secret is captured
 * into a process ref and drawn as a mask — if it appears in the frame, history,
 * or a notice, the test has failed.
 */

import { describe, expect, test } from "bun:test";
import { CONFIRMATION_ALTERNATIVES, type ConfirmationPrompt } from "../confirmation/index.ts";
import { mount } from "../harness.tsx";
import type { ThemeRequest } from "../theme/index.ts";
import { known, type ShellModel, unavailable } from "../view-model.ts";
import { ShellApp } from "./shell-app.tsx";

const THEME: ThemeRequest = {
  variant: "dark",
  colorLevel: "truecolor",
  symbols: "unicode",
  reducedMotion: true,
  generation: 1,
};

const MODEL: Omit<ShellModel, "overlay" | "commands" | "transcript" | "composer" | "activity"> = {
  header: {
    workspace: known("/work/falryn"),
    branch: unavailable("no Git yet"),
    session: unavailable("no session yet"),
    model: unavailable("no provider yet"),
  },
  status: { status: "informational", message: "Nothing is running.", hints: [] },
  help: [{ title: "Leaving", body: "Ctrl+C ends the shell." }],
};

const WRITE: ConfirmationPrompt = {
  id: "conf-write",
  title: "Write file",
  operation: "write_file",
  target: "path=src/app.ts",
  reason: "This would change files or other local state.",
  effect: "mutation",
  alternatives: CONFIRMATION_ALTERNATIVES,
  scope: "once",
  fingerprint: "fp-write",
  secret: null,
};

const TOKEN: ConfirmationPrompt = {
  ...WRITE,
  id: "conf-token",
  title: "Store token",
  operation: "credentials",
  target: "(no target)",
  fingerprint: "fp-token",
  secret: { label: "API token" },
};

const SECRET = "hunter2";

describe("a confirmation sheet", () => {
  test("shows operation, target, reason, alternatives, and labelled keys", async () => {
    using shell = await mount(
      <ShellApp theme={THEME} model={MODEL} onExit={() => {}} confirmation={WRITE} />,
    );
    const frame = await shell.frame("Write file");
    expect(frame).toContain("Write file");
    expect(frame).toContain("write_file");
    expect(frame).toContain("path=src/app.ts");
    expect(frame).toContain("This would change files or other local state.");
    expect(frame).toContain("Cancel");
    expect(frame).toContain("Preview (unavailable in this build)");
    expect(frame).toContain("This decision applies once.");
    expect(frame).toContain("This confirmation expires if the target or input changes.");
    expect(frame).toContain("y  Accept");
    expect(frame).toContain("n  Decline");
    expect(frame).toContain("Esc declines this");
  });

  test("accepts with the labelled key and does not execute a tool", async () => {
    const decisions: string[] = [];
    using shell = await mount(
      <ShellApp
        theme={THEME}
        model={MODEL}
        onExit={() => {}}
        confirmation={WRITE}
        onConfirmation={(decision) => {
          decisions.push(decision.status);
        }}
      />,
    );
    await shell.frame("Write file");
    const frame = await shell.type("y");
    expect(frame).toContain("Accepted.");
    expect(frame).not.toContain("Esc declines this");
    expect(decisions).toEqual(["accepted"]);
  });

  test("escape refuses", async () => {
    const decisions: string[] = [];
    using shell = await mount(
      <ShellApp
        theme={THEME}
        model={MODEL}
        onExit={() => {}}
        confirmation={WRITE}
        onConfirmation={(decision) => {
          decisions.push(decision.status);
        }}
      />,
    );
    await shell.frame("Write file");
    const frame = await shell.pressEscape();
    expect(frame).toContain("Declined.");
    expect(decisions).toEqual(["refused"]);
  });

  test("palette dispatch accepts without a registry default key", async () => {
    using shell = await mount(
      <ShellApp theme={THEME} model={MODEL} onExit={() => {}} confirmation={WRITE} />,
    );
    await shell.frame("Write file");
    await shell.press("p", { ctrl: true });
    await shell.frame("Commands");
    await shell.type("confirmation.accept");
    shell.setup.mockInput.pressEnter();
    const frame = await shell.frame("Accepted.");
    expect(frame).toContain("Accepted.");
  });

  test("escape on the palette restores the sheet rather than accepting", async () => {
    using shell = await mount(
      <ShellApp theme={THEME} model={MODEL} onExit={() => {}} confirmation={WRITE} />,
    );
    await shell.frame("Write file");
    await shell.press("p", { ctrl: true });
    await shell.frame("Commands");
    const restored = await shell.pressEscape();
    expect(restored).toContain("Write file");
    expect(restored).toContain("y  Accept");
    expect(restored).not.toContain("Accepted.");
  });
});

describe("protected secret input", () => {
  test("masks the value and never draws it", async () => {
    const submitted: string[] = [];
    using shell = await mount(
      <ShellApp
        theme={THEME}
        model={MODEL}
        onExit={() => {}}
        confirmation={TOKEN}
        onSecretSubmit={(value) => {
          submitted.push(value);
        }}
      />,
      { shape: { columns: 100, rows: 36 } },
    );
    await shell.frame("API token");
    await shell.type(SECRET);
    const typed = await shell.frame("•••••••");
    expect(typed).toContain("API token");
    expect(typed).toContain("•••••••");
    expect(typed).not.toContain(SECRET);
    expect(typed).toContain("return  Accept");

    shell.setup.mockInput.pressEnter();
    const accepted = await shell.frame("Accepted.");
    expect(accepted).toContain("Accepted.");
    expect(accepted).not.toContain(SECRET);
    expect(submitted).toEqual([SECRET]);
  });

  test("does not put the secret in composer history", async () => {
    using shell = await mount(
      <ShellApp theme={THEME} model={MODEL} onExit={() => {}} confirmation={TOKEN} />,
    );
    await shell.frame("API token");
    await shell.type(SECRET);
    await shell.pressEscape();
    await shell.frame("Declined.");
    const after = await shell.press("up");
    expect(after).not.toContain(SECRET);
  });

  test("refuses accept while the secret field is empty", async () => {
    using shell = await mount(
      <ShellApp theme={THEME} model={MODEL} onExit={() => {}} confirmation={TOKEN} />,
    );
    await shell.frame("API token");
    shell.setup.mockInput.pressEnter();
    const frame = await shell.frame("secret field is empty");
    expect(frame).toContain("secret field is empty");
    expect(frame).toContain("API token");
  });
});
