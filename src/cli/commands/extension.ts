import { adoptForeignError } from "../../application/diagnostics/index.ts";
import { preparePackage } from "../../application/extensions/index.ts";
import {
  type PackageInspectionReport,
  packageInspectionReport,
} from "../../application/extensions/inspection-report.ts";
import type { TrustRequest } from "../../application/extensions/package-trust.ts";
import { recoveryForEffect } from "../../domain/foundation/index.ts";
import { createHostPackageSource } from "../../integrations/extensions/host-package-inspection.ts";
import type { CommandResultOf } from "../output/result.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { FALRYN_VERSION } from "../version.ts";
import { runPackageTrust } from "./extension-trust.ts";
import { resultFor } from "./shared.ts";

export async function runExtensionInspect(
  path: string,
  signal?: AbortSignal,
  services?: ServiceProvider,
  request?: TrustRequest,
): Promise<CommandResultOf<"extension.inspect" | "extension.trust", PackageInspectionReport>> {
  const prepared = await preparePackage(
    createHostPackageSource(path),
    { falryn: FALRYN_VERSION, bun: Bun.version, os: process.platform, arch: process.arch },
    signal === undefined ? {} : { signal },
  );
  const trust =
    prepared.ok && services !== undefined
      ? await runPackageTrust(prepared.package, services, request, signal)
      : undefined;
  const payload = packageInspectionReport(prepared, trust);
  const effect =
    trust?.status === "applied"
      ? "completed"
      : trust?.status === "failed" && trust.code === "uncertain"
        ? "uncertain"
        : "none";
  const errors =
    payload.status === "failed" || trust?.status === "failed"
      ? [
          adoptForeignError(
            {
              code:
                payload.status === "failed"
                  ? payload.code
                  : trust?.status === "failed"
                    ? trust.code
                    : "trust-unavailable",
              category: "configuration",
              message:
                "Extension inspection or trust decision failed. Inspect the result and retry with fresh evidence.",
            },
            { operation: "extension inspection" },
          ),
        ]
      : [];
  return resultFor(
    request === undefined ? "extension.inspect" : "extension.trust",
    payload,
    errors.map((error) => ({ ...error, effect, recovery: recoveryForEffect(effect) })),
    trust?.status === "failed" && trust.code === "uncertain"
      ? { kind: "uncertain", effect: "uncertain" }
      : signal?.aborted
        ? { kind: "cancelled", effect: trust?.status === "applied" ? "completed" : "none" }
        : undefined,
    {
      intent: request === undefined ? "none" : "mutate",
      observed: effect,
    },
  );
}
