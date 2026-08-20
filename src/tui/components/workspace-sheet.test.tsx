/**
 * Workspace-set overlays on a real terminal (#607).
 *
 * Palette commands open sheets that call the application-backed controller.
 * The header projects primary + extras when a set is attached.
 */

import { describe, expect, test } from "bun:test";
import {
  createInMemoryFileSystem,
  createWorkspaceSet,
  localPath,
  workspaceRootId,
} from "../../domain/index.ts";
import { mount } from "../harness.tsx";
import type { ThemeRequest } from "../theme/index.ts";
import { known, type ShellModel, unavailable } from "../view-model.ts";
import { createWorkspaceController } from "../workspace/index.ts";
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
    workspace: known("current directory"),
    branch: unavailable("no Git yet"),
    session: unavailable("no session yet"),
    model: unavailable("no provider yet"),
  },
  status: { status: "informational", message: "Nothing is running.", hints: [] },
  help: [{ title: "Leaving", body: "Ctrl+C ends the shell." }],
};

function controllerWithTwoRoots() {
  const fs = createInMemoryFileSystem({
    nodes: {
      "/work/falryn": { kind: "directory" },
      "/work/docs": { kind: "directory" },
      "/home/user/.config/falryn": { kind: "directory" },
    },
  });
  const set = createWorkspaceSet([
    {
      rootId: workspaceRootId.from("root-1"),
      name: "falryn",
      path: localPath("/work/falryn"),
    },
    {
      rootId: workspaceRootId.from("root-2"),
      name: "docs",
      path: localPath("/work/docs"),
    },
  ]);
  expect(set.ok).toBe(true);
  if (!set.ok) {
    throw new Error("expected set");
  }
  return createWorkspaceController({
    fileSystem: fs,
    configurationRoot: localPath("/home/user/.config/falryn"),
    currentDirectory: localPath("/work"),
    initial: set.value,
  });
}

async function runCommand(shell: Awaited<ReturnType<typeof mount>>, id: string): Promise<void> {
  await shell.frame();
  await shell.press("p", { ctrl: true });
  await shell.frame("Commands");
  await shell.type(id);
  shell.setup.mockInput.pressEnter();
}

describe("workspace overlays", () => {
  test("lists every root from workspace.show", async () => {
    const controller = controllerWithTwoRoots();
    using shell = await mount(
      <ShellApp
        theme={THEME}
        model={MODEL}
        onExit={() => {}}
        workspaceController={controller}
        workspace={controller.initial}
      />,
    );
    await runCommand(shell, "workspace.show");
    const frame = await shell.frame("Workspace set");
    expect(frame).toContain("Workspace set");
    expect(frame).toContain("falryn (primary)");
    expect(frame).toContain("/work/falryn");
    expect(frame).toContain("docs");
    expect(frame).toContain("/work/docs");
  });

  test("projects primary plus extras in the header", async () => {
    const controller = controllerWithTwoRoots();
    using shell = await mount(
      <ShellApp
        theme={THEME}
        model={MODEL}
        onExit={() => {}}
        workspaceController={controller}
        workspace={controller.initial}
      />,
    );
    const frame = await shell.frame("falryn +1");
    expect(frame).toContain("falryn +1");
    expect(frame).not.toContain("current directory");
  });

  test("keeps workspace commands unavailable without a controller", async () => {
    using shell = await mount(<ShellApp theme={THEME} model={MODEL} onExit={() => {}} />);
    await shell.frame();
    await shell.press("p", { ctrl: true });
    await shell.frame("Commands");
    await shell.type("workspace.show");
    const frame = await shell.frame("Show workspace set");
    expect(frame).toContain("Show workspace set");
    expect(frame.toLowerCase()).toContain("unavailable");
  });

  test("opens add-root with a path field", async () => {
    const controller = controllerWithTwoRoots();
    using shell = await mount(
      <ShellApp
        theme={THEME}
        model={MODEL}
        onExit={() => {}}
        workspaceController={controller}
        workspace={controller.initial}
      />,
    );
    await runCommand(shell, "workspace.addRoot");
    const frame = await shell.frame("Add workspace root");
    expect(frame).toContain("Add workspace root");
    expect(frame).toContain("Path to add");
  });
});
