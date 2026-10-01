/** Test-only command entries. Product code never imports this file. */

import { type CommandRegistry, createCommandRegistry } from "./command-registry.ts";
import { type CommandSpec, NO_ARGUMENT, planned, SHIPPED } from "./command-spec.ts";

export function commandSpec(
  overrides: Partial<CommandSpec> & { readonly id: string },
): CommandSpec {
  return {
    title: `Title of ${overrides.id}`,
    description: `Description of ${overrides.id}.`,
    keywords: [],
    slash: [],
    argument: NO_ARGUMENT,
    timing: "immediate",
    effect: "interactive",
    confirmation: "none",
    behavior: "execute",
    callers: ["interactive"],
    status: SHIPPED,
    ...overrides,
  };
}

/** A small registry exercising every argument kind and form shape. */
export const SAMPLE_SPECS: readonly CommandSpec[] = [
  commandSpec({
    id: "app.help",
    title: "Help",
    description: "Show every command and its key.",
    keywords: ["keys", "shortcuts"],
    slash: [{ form: "/help" }],
  }),
  commandSpec({
    id: "mode.select",
    title: "Select execution mode",
    description: "Report or change the execution mode.",
    slash: [
      { form: "/mode" },
      { form: "/ask", fixedArgument: "ask" },
      { form: "/plan", fixedArgument: "plan" },
    ],
    argument: {
      kind: "options",
      hint: "mode",
      options: [
        { value: "ask", operand: null, timing: "safe-point" },
        { value: "plan", operand: null, timing: "safe-point" },
      ],
    },
    effect: "mutation",
  }),
  commandSpec({
    id: "profile.inspect",
    title: "Working profile",
    description: "Inspect, preview or apply a working profile.",
    slash: [{ form: "/profile" }],
    argument: {
      kind: "options",
      hint: "action",
      options: [
        { value: "list", operand: null },
        { value: "use", operand: { hint: "profile id", required: true } },
        { value: "apply", operand: { hint: "candidate id", required: true }, timing: "safe-point" },
        { value: "preview", operand: { hint: "profile id", required: false } },
      ],
    },
  }),
  commandSpec({
    id: "model.settings",
    title: "Model roles",
    description: "Open model role settings.",
    slash: [{ form: "/model" }, { form: "/model roles" }],
  }),
  commandSpec({
    id: "model.routes",
    title: "Named model routes",
    description: "Open named model routes.",
    slash: [{ form: "/model routes" }, { form: "/route" }],
  }),
  commandSpec({
    id: "workspace.load",
    title: "Load workspace layout",
    description: "Load a saved workspace layout by name.",
    slash: [{ form: "/workspace load" }, { form: "/load-workspace" }],
    argument: {
      kind: "text",
      hint: "layout name",
      maxBytes: 64,
      required: false,
      timing: "safe-point",
    },
  }),
  commandSpec({
    id: "workspace.show",
    title: "Show workspace set",
    description: "Show the workspace roots.",
    slash: [{ form: "/workspace show" }],
  }),
  commandSpec({
    id: "advisor.consult",
    title: "Consult the advisor",
    description: "Ask the advisor model about the current work.",
    slash: [{ form: "/advisor" }],
    argument: { kind: "text", hint: "focus", maxBytes: 1024, required: true },
    status: planned("#1216", "the advisor action is not wired yet"),
  }),
];

export function sampleRegistry(): CommandRegistry {
  const built = createCommandRegistry(SAMPLE_SPECS);
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  return built.value;
}
