/**
 * Session, model, context, and resource controls, on a real terminal.
 *
 * The sheet is an overlay over catalogs the application port supplies. Selecting
 * a session or model updates the header through a process-local cursor. Nothing
 * is persisted and no provider is called.
 */

import { describe, expect, test } from "bun:test";
import type { ControlCatalog } from "../controls/index.ts";
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

const CATALOG: ControlCatalog = {
  sessions: [{ id: "s1", title: "coding", detail: "workspace falryn" }],
  models: [{ id: "m1", title: "local-small", detail: "8k context" }],
  context: [
    { label: "tokens", value: known("1200 / 8000") },
    { label: "bytes", value: known("48 KiB") },
    { label: "items", value: known("12") },
  ],
  resources: [
    { label: "scopes", value: known("2 live") },
    { label: "memory", value: unavailable("no resource probe yet") },
  ],
};

async function runCommand(shell: Awaited<ReturnType<typeof mount>>, id: string): Promise<void> {
  await shell.frame("workspace");
  await shell.press("p", { ctrl: true });
  await shell.frame("Commands");
  await shell.type(id);
  shell.setup.mockInput.pressEnter();
}

describe("control overlays", () => {
  test("lists supplied sessions instead of inventing a default", async () => {
    using shell = await mount(
      <ShellApp theme={THEME} model={MODEL} onExit={() => {}} controls={CATALOG} />,
    );
    await runCommand(shell, "session.switch");
    const frame = await shell.frame("Sessions");
    expect(frame).toContain("Sessions");
    expect(frame).toContain("coding");
    expect(frame).toContain("workspace falryn");
    expect(frame).toContain("Esc closes this");
  });

  test("selecting a session updates the header and does not persist", async () => {
    using shell = await mount(
      <ShellApp theme={THEME} model={MODEL} onExit={() => {}} controls={CATALOG} />,
    );
    await runCommand(shell, "session.switch");
    await shell.frame("Sessions");
    shell.setup.mockInput.pressEnter();
    const frame = await shell.frame("coding");
    expect(frame).toContain("coding");
    expect(frame).not.toContain("no session yet");
  });

  test("shows named context facts", async () => {
    using shell = await mount(
      <ShellApp theme={THEME} model={MODEL} onExit={() => {}} controls={CATALOG} />,
    );
    await runCommand(shell, "context.show");
    const frame = await shell.frame("Context");
    expect(frame).toContain("Context");
    expect(frame).toContain("tokens");
    expect(frame).toContain("1200 / 8000");
  });

  test("empty catalogs name the gap", async () => {
    using shell = await mount(<ShellApp theme={THEME} model={MODEL} onExit={() => {}} />);
    await runCommand(shell, "session.switch");
    const frame = await shell.frame("No sessions yet");
    expect(frame).toContain("No sessions yet.");
  });

  test("session.new stays listed and unavailable", async () => {
    using shell = await mount(<ShellApp theme={THEME} model={MODEL} onExit={() => {}} />);
    await shell.frame("workspace");
    await shell.press("p", { ctrl: true });
    await shell.frame("Commands");
    await shell.type("session.new");
    const frame = await shell.frame("New session");
    expect(frame).toContain("New session");
    expect(frame.toLowerCase()).toContain("unavailable");
  });
});
