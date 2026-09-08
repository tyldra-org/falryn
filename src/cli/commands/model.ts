/** Model configuration command over the same service used by the terminal shell. */
import { adoptForeignError } from "../../application/diagnostics/index.ts";
import type {
  ModelSettingsRequest,
  ModelSettingsResult,
} from "../../application/providers/model-settings.ts";
import type { GlobalOptions } from "../options.ts";
import type { CommandResultOf } from "../output/result.ts";
import { composeProductModelSettings } from "../runtime/product-model-settings.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { MUTATION_NOT_OBSERVED, resultFor, WRITE_COMPLETED_EFFECT } from "./shared.ts";
export async function runModel(
  services: ServiceProvider,
  request: ModelSettingsRequest,
  globals: GlobalOptions,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"model", ModelSettingsResult>> {
  const mutation =
    request.kind === "edit" || request.kind === "apply-clear" || request.kind === "apply-migration";
  if (mutation) onMutationStart?.();
  const payload = await composeProductModelSettings(services(), globals).execute(request, signal);
  const errors =
    payload.kind === "failed" || payload.kind === "invalid"
      ? [
          adoptForeignError(
            {
              code: payload.kind === "failed" ? payload.code : "invalid-model-policy",
              category: "configuration",
              message:
                payload.kind === "failed"
                  ? `Model settings failed: ${payload.code}. Inspect settings and retry with their current revision.`
                  : payload.message,
            },
            { operation: "model settings" },
          ),
        ]
      : [];
  return resultFor(
    "model",
    payload,
    errors,
    undefined,
    payload.kind === "written"
      ? WRITE_COMPLETED_EFFECT
      : mutation
        ? MUTATION_NOT_OBSERVED
        : undefined,
  );
}
