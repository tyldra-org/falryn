import { describe, expect, test } from "bun:test";
import { commandById } from "../commands.ts";
import {
  parseComposerSlash,
  WORKSPACE_SLASH_ALIASES,
  workspacePanelForSlashCommand,
} from "./slash.ts";

describe("parseComposerSlash", () => {
  test("maps /workspace verbs onto palette command ids", () => {
    expect(parseComposerSlash("/workspace show")).toEqual({
      kind: "match",
      commandId: "workspace.show",
      argument: null,
      form: "/workspace show",
    });
    expect(parseComposerSlash("/workspace add")).toEqual({
      kind: "match",
      commandId: "workspace.addRoot",
      argument: null,
      form: "/workspace add",
    });
    expect(parseComposerSlash("/workspace save app")).toEqual({
      kind: "match",
      commandId: "workspace.save",
      argument: "app",
      form: "/workspace save",
    });
    expect(parseComposerSlash("/workspace load app")).toEqual({
      kind: "match",
      commandId: "workspace.load",
      argument: "app",
      form: "/workspace load",
    });
  });

  test("accepts doc forms as aliases of the same ids", () => {
    expect(parseComposerSlash("/add-dir /tmp/extra")).toMatchObject({
      kind: "match",
      commandId: "workspace.addRoot",
      argument: "/tmp/extra",
    });
    expect(parseComposerSlash("/save-workspace app")).toMatchObject({
      kind: "match",
      commandId: "workspace.save",
      argument: "app",
    });
    expect(parseComposerSlash("/load-workspace app")).toMatchObject({
      kind: "match",
      commandId: "workspace.load",
      argument: "app",
    });
  });

  test("keeps path arguments case-sensitive", () => {
    expect(parseComposerSlash("/workspace add /Tmp/Extra")).toMatchObject({
      kind: "match",
      argument: "/Tmp/Extra",
    });
  });

  test("refuses an unknown /workspace verb without inventing a catalog", () => {
    expect(parseComposerSlash("/workspace remove")).toEqual({
      kind: "unresolved",
      reason: "/workspace expects add, save, load, or show",
    });
    expect(parseComposerSlash("/workspace")).toEqual({
      kind: "unresolved",
      reason: "/workspace expects add, save, load, or show",
    });
  });

  test("refuses an argument on /workspace show", () => {
    expect(parseComposerSlash("/workspace show extra")).toEqual({
      kind: "unresolved",
      reason: "/workspace show takes no argument",
    });
  });

  test("leaves ordinary prompts and other slash text alone", () => {
    expect(parseComposerSlash("hello")).toBeNull();
    expect(parseComposerSlash("/help")).toBeNull();
    expect(parseComposerSlash("")).toBeNull();
  });

  test("declares an argument schema for every workspace alias onto a real command", () => {
    for (const alias of WORKSPACE_SLASH_ALIASES) {
      expect(["none", "path", "layout-name"]).toContain(alias.argument);
      expect(commandById(alias.commandId)?.id).toBe(alias.commandId);
      if (alias.commandId === "brief.set") {
        expect(workspacePanelForSlashCommand(alias.commandId)).toBeNull();
        continue;
      }
      expect(workspacePanelForSlashCommand(alias.commandId)).not.toBeNull();
    }
  });
});
