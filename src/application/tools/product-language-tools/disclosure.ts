import type { CapabilityId } from "../../../domain/foundation/index.ts";
import type { ToolRegistry } from "../../../domain/tools/index.ts";

/** Include the prerequisites for language/debug work within ordinary disclosure limits. */
export function languageToolPrerequisites(
  task: string,
  tools: ToolRegistry,
): readonly CapabilityId[] {
  const text = task.toLowerCase();
  const names = new Set<string>();
  if (/\blsp(?:_|\b)|language server|\bhover\b|\bdefinition\b/u.test(text)) {
    for (const name of [
      "lsp_configurations",
      "lsp_start",
      "lsp_open_document",
      "lsp_hover",
      "lsp_definition",
      "lsp_shutdown",
    ])
      names.add(name);
  }
  if (/\bdap(?:_|\b)|debug adapter|\bdebugger\b/u.test(text)) {
    for (const name of [
      "dap_configurations",
      "dap_start",
      text.includes("attach") ? "dap_attach" : "dap_launch",
      "dap_threads",
      "dap_stack_trace",
      "dap_disconnect",
    ])
      names.add(name);
  }
  for (const entry of tools.entries) {
    const name = entry.manifest.name;
    if ((name.startsWith("lsp_") || name.startsWith("dap_")) && text.includes(name))
      names.add(name);
  }
  if ([...names].some((name) => name.startsWith("lsp_call_hierarchy_")))
    names.add("lsp_call_hierarchy_prepare");
  if ([...names].some((name) => name.startsWith("lsp_type_hierarchy_")))
    names.add("lsp_type_hierarchy_prepare");
  return [...names].flatMap((name) => {
    const entry = tools.resolveByName(name);
    return entry === null ? [] : [entry.manifest.capabilityId];
  });
}
