import type { HttpHookGrant, HttpHookRegistration } from "../../domain/extensions/hook-http.ts";
import type { HookDecision, HookWireInput } from "../../domain/extensions/hook-protocol.ts";
import type { ToolHookContext } from "../../domain/tools/tool-hooks.ts";

/** One approved HTTPS POST per invocation; the host owns resolution, pinning and bounds. */
export interface HookHttpPort {
  run(input: {
    registration: HttpHookRegistration;
    grant: HttpHookGrant;
    wire: HookWireInput;
    context: ToolHookContext;
    current(): Promise<boolean>;
  }): Promise<HookDecision>;
}
