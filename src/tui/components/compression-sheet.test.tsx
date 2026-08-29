import { describe, expect, test } from "bun:test";
import {
  composeProductBriefControls,
  composeProductOutputControls,
} from "../../application/index.ts";
import { UNAVAILABLE_SUBMISSION } from "../composer/index.ts";
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
  help: [],
};

describe("compression sheet", () => {
  test("opens from the shared command and changes the live Brief control", async () => {
    const brief = composeProductBriefControls({ initialVerbosity: "balanced" });
    const output = composeProductOutputControls();
    const submission = { ...UNAVAILABLE_SUBMISSION, brief, output };
    using shell = await mount(
      <ShellApp theme={THEME} model={MODEL} onExit={() => {}} submission={submission} />,
      { shape: { columns: 100, rows: 34 } },
    );

    await shell.frame("workspace");
    await shell.press("p", { ctrl: true });
    await shell.frame("Commands");
    await shell.type("compression.show");
    shell.setup.mockInput.pressEnter();

    const opened = await shell.frame("Brief · balanced (current)");
    expect(opened).toContain("Compression");
    expect(opened).toContain("Hush · on");
    expect(opened).toContain("Loom · on");

    shell.setup.mockInput.pressArrow("down");
    shell.setup.mockInput.pressEnter();
    const changed = await shell.frame("Brief · detailed (current)");
    expect(brief.getFrontendMode()).toBe("detailed");
    expect(changed).toContain("Brief set to detailed.");
  });

  test("opens through /compression and names unattached controls honestly", async () => {
    using shell = await mount(<ShellApp theme={THEME} model={MODEL} onExit={() => {}} />);
    await shell.frame();
    await shell.press("\t");
    await shell.press("\t");
    await shell.type("/compression");
    await shell.press("\r");

    const frame = await shell.frame("Compression");
    expect(frame).toContain("Compression");
    expect(frame).toContain("Brief · unavailable");
    expect(frame).toContain("Hush · unavailable");
  });
});
