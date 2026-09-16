import type { GlobalOptions } from "../options.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { standaloneEnvironment } from "../runtime/standalone-environment.ts";
import { resultFor } from "./shared.ts";

export async function runEnvironment(
  services: ServiceProvider,
  action: "inspect" | "reload",
  globals: GlobalOptions,
  signal?: AbortSignal,
) {
  const runtime = await standaloneEnvironment(services(), globals, signal);
  try {
    const payload = await runtime.control.execute(action, signal);
    const failed =
      action === "reload" &&
      (!["active", "degraded"].includes(payload.inspection.state) ||
        payload.transition?.kind !== "receipt" ||
        payload.transition.receipt.stage !== "settled" ||
        payload.transition.receipt.code !== "applied");
    return resultFor(
      action === "inspect" ? "env.inspect" : "env.reload",
      payload,
      [],
      failed
        ? {
            kind: "failed",
            effect: payload.inspection.effects === "possible" ? "uncertain" : "none",
          }
        : { kind: "completed" },
      {
        intent: action === "reload" ? "mutate" : "none",
        observed: payload.inspection.effects === "possible" ? "uncertain" : "none",
      },
    );
  } finally {
    runtime.close();
  }
}
export type EnvironmentPayload = Awaited<
  ReturnType<Awaited<ReturnType<typeof standaloneEnvironment>>["control"]["execute"]>
>;
