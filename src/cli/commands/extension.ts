import { adoptForeignError } from "../../application/diagnostics/index.ts";
import { preparePackage } from "../../application/extensions/index.ts";
import {
  type PackageInspectionReport,
  packageInspectionReport,
} from "../../application/extensions/inspection-report.ts";
import { createHostPackageSource } from "../../integrations/extensions/host-package-inspection.ts";
import type { CommandResultOf } from "../output/result.ts";
import { FALRYN_VERSION } from "../version.ts";
import { resultFor } from "./shared.ts";

export async function runExtensionInspect(
  path: string,
  signal?: AbortSignal,
): Promise<CommandResultOf<"extension.inspect", PackageInspectionReport>> {
  const prepared = await preparePackage(
    createHostPackageSource(path),
    { falryn: FALRYN_VERSION, bun: Bun.version, os: process.platform, arch: process.arch },
    signal === undefined ? {} : { signal },
  );
  const payload = packageInspectionReport(prepared);
  const errors =
    payload.status === "failed"
      ? [
          adoptForeignError(
            {
              code: payload.code,
              category: "configuration",
              message: `Extension inspection failed: ${payload.code}. Check the local package and retry.`,
            },
            { operation: "extension inspection" },
          ),
        ]
      : [];
  return resultFor("extension.inspect", payload, errors);
}
