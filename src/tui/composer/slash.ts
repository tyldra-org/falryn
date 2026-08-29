/**
 * Optional composer slash text that aliases palette command ids (#609).
 *
 * `/workspace add|save|load|show` (and the doc forms `/add-dir`,
 * `/save-workspace`, `/load-workspace`) resolve to the same registry ids the
 * palette uses. This is not a second command language and not a completion
 * popup — unknown `/` text is left alone, and general `composer.completion`
 * stays reported as missing.
 *
 * Pure. No renderer, no shell state.
 */

export const SLASH_ARGUMENT_KINDS = ["none", "path", "layout-name", "profile"] as const;
export type SlashArgumentKind = (typeof SLASH_ARGUMENT_KINDS)[number];

export type ComposerSlashAlias = {
  /** Slash forms that mean this alias, longest match first in the table. */
  readonly forms: readonly string[];
  /** Palette / registry command id. */
  readonly commandId: string;
  readonly argument: SlashArgumentKind;
  /** Fixed argument supplied by a direct convenience alias. */
  readonly fixedArgument?: string;
};

/**
 * Workspace slash aliases of palette ids.
 *
 * Argument schema is declared here so a later completion producer can read it
 * without inventing a parallel catalog.
 */
export const WORKSPACE_SLASH_ALIASES: readonly ComposerSlashAlias[] = [
  {
    forms: ["/workspace add", "/add-dir"],
    commandId: "workspace.addRoot",
    argument: "path",
  },
  {
    forms: ["/workspace save", "/save-workspace"],
    commandId: "workspace.save",
    argument: "layout-name",
  },
  {
    forms: ["/workspace load", "/load-workspace"],
    commandId: "workspace.load",
    argument: "layout-name",
  },
  {
    forms: ["/workspace show"],
    commandId: "workspace.show",
    argument: "none",
  },
  {
    forms: ["/brief"],
    commandId: "brief.set",
    argument: "layout-name",
  },
  {
    forms: ["/hush"],
    commandId: "hush.set",
    argument: "layout-name",
  },
  {
    forms: ["/loom"],
    commandId: "loom.set",
    argument: "layout-name",
  },
  {
    forms: ["/mode"],
    commandId: "mode.select",
    argument: "profile",
  },
  { forms: ["/ask"], commandId: "mode.select", argument: "none", fixedArgument: "ask" },
  { forms: ["/plan"], commandId: "mode.select", argument: "none", fixedArgument: "plan" },
  { forms: ["/debug"], commandId: "mode.select", argument: "none", fixedArgument: "debug" },
  { forms: ["/agent"], commandId: "mode.select", argument: "none", fixedArgument: "agent" },
];

export type ParsedComposerSlash =
  | {
      readonly kind: "match";
      readonly commandId: string;
      /** Trimmed argument text, or `null` when omitted. */
      readonly argument: string | null;
      readonly form: string;
    }
  | {
      readonly kind: "unresolved";
      readonly reason: string;
    };

/**
 * Parse composer draft text as an optional slash alias.
 *
 * Returns `null` when the text is not slash-shaped for this table — including
 * other `/…` prompts — so ordinary submit still owns them.
 */
export function parseComposerSlash(text: string): ParsedComposerSlash | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  for (const alias of WORKSPACE_SLASH_ALIASES) {
    for (const form of alias.forms) {
      const formLower = form.toLowerCase();
      if (lower === formLower) {
        return {
          kind: "match",
          commandId: alias.commandId,
          argument: alias.fixedArgument ?? null,
          form,
        };
      }
      if (lower.startsWith(`${formLower} `) || lower.startsWith(`${formLower}\t`)) {
        const rest = trimmed.slice(formLower.length).trim();
        if (alias.argument === "none" && rest !== "") {
          return {
            kind: "unresolved",
            reason: `${form} takes no argument`,
          };
        }
        return {
          kind: "match",
          commandId: alias.commandId,
          argument: rest === "" ? null : rest,
          form,
        };
      }
    }
  }

  if (/^\/workspace(\s|$)/i.test(trimmed)) {
    return {
      kind: "unresolved",
      reason: "/workspace expects add, save, load, or show",
    };
  }
  if (/^\/mode(\s|$)/i.test(trimmed)) {
    return {
      kind: "unresolved",
      reason: "/mode expects ask, plan, debug, or agent",
    };
  }

  return null;
}

/** Overlay panel for a matched workspace slash command id, or `null`. */
export function workspacePanelForSlashCommand(
  commandId: string,
): "add" | "save" | "load" | "show" | null {
  switch (commandId) {
    case "workspace.addRoot":
      return "add";
    case "workspace.save":
      return "save";
    case "workspace.load":
      return "load";
    case "workspace.show":
      return "show";
    default:
      return null;
  }
}
