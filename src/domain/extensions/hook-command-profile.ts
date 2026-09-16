import { ExtensionInputError } from "./canonical.ts";
import type { ContributionDeclaration } from "./manifest.ts";

export const HOOK_COMMAND_PROTOCOL = "falryn-hook-command-v1";
export const HOOK_PYTHON_PROFILE = "python39-macos-observer-v1";
/** This profile grants no direct effects. Decisions still need native gateway admission. */
export function hookCommandContract(declaration: ContributionDeclaration) {
  const registration = declaration.hook;
  const execution = declaration.execution;
  if (
    declaration.kind !== "hook" ||
    registration?.handler.kind !== "external-command-v1" ||
    registration.handler.executable !== "python3.9" ||
    registration.handler.executionProfile !== HOOK_PYTHON_PROFILE ||
    execution?.loader !== "python" ||
    execution.mode !== "governed" ||
    execution.protocolVersion !== HOOK_COMMAND_PROTOCOL ||
    execution.executable !== registration.handler.entrypoint ||
    JSON.stringify(execution.argv) !== JSON.stringify(registration.handler.argv) ||
    execution.cwd !== undefined
  )
    throw new ExtensionInputError("hook-execution-profile-unavailable");
  return registration;
}
