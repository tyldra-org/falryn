import type { HookRegistration } from "../../domain/extensions/hook-handlers.ts";
import type { HookDecision, HookWireInput } from "../../domain/extensions/hook-protocol.ts";
import type { PackageSnapshot } from "../../domain/extensions/package-source.ts";
import type { ToolHookContext } from "../../domain/tools/tool-hooks.ts";

export interface HookCommandPort {
  available(): boolean;
  run(input: {
    snapshot: PackageSnapshot;
    registration: HookRegistration;
    wire: HookWireInput;
    context: ToolHookContext;
    current(): Promise<boolean>;
  }): Promise<HookDecision>;
}
