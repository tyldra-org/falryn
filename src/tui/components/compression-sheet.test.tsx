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

    shell.setup.mockInput.pressArrow("down");
    shell.setup.mockInput.pressArrow("down");
    shell.setup.mockInput.pressEnter();
    const hushChanged = await shell.frame("Hush · off");
    expect(output.getHushState()).toBe("off");
    expect(hushChanged).toContain("Hush set to off.");
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

  test("scrolls a short sheet and applies disable-all and enable-all through live controls", async () => {
    const brief = composeProductBriefControls({ initialVerbosity: "balanced" });
    const output = composeProductOutputControls();
    const submission = { ...UNAVAILABLE_SUBMISSION, brief, output };
    using shell = await mount(
      <ShellApp theme={THEME} model={MODEL} onExit={() => {}} submission={submission} />,
      { shape: { columns: 70, rows: 12 } },
    );

    await shell.frame();
    await shell.press("\t");
    await shell.press("\t");
    await shell.type("/compression");
    await shell.press("\r");
    await shell.frame("Brief · balanced (current)");

    for (let index = 0; index < 6; index += 1) {
      shell.setup.mockInput.pressArrow("down");
    }
    const scrolled = await shell.frame("Disable all");
    expect(scrolled).toContain("Disable all");
    shell.setup.mockInput.pressEnter();

    const disabled = await shell.frame("Brief · off (current)");
    expect(disabled).toContain("Brief, Hush, and Loom are off.");
    expect(brief.getFrontendMode()).toBe("off");
    expect(output.getHushState()).toBe("off");
    expect(output.getLoomState()).toBe("off");

    for (let index = 0; index < 3; index += 1) {
      shell.setup.mockInput.pressArrow("down");
    }
    await shell.frame("Enable all");
    shell.setup.mockInput.pressEnter();

    const enabled = await shell.frame("Brief · balanced (current)");
    expect(enabled).toContain("Brief, Hush, and Loom enabled.");
    expect(brief.getFrontendMode()).toBe("balanced");
    expect(output.getHushState()).toBe("on");
    expect(output.getLoomState()).toBe("on");
  });
});
