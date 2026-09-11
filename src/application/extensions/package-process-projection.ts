import type { PackageHealthResult } from "../../domain/extensions/package-health.ts";

/** Process ownership paths stay in the attempt store; consumers receive the enforced boundary. */
export function projectPackageProcessResult(result: PackageHealthResult): PackageHealthResult {
  return {
    ...result,
    sandbox:
      result.sandbox === null
        ? null
        : {
            ...result.sandbox,
            readRoots: result.sandbox.readRoots.map(() => "package-root"),
            writeRoots: [],
            credentialHandles: [],
          },
  };
}
