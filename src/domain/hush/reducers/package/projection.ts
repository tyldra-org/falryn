import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { boundStream, boundText, joinStreams } from "../../bounds.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import {
  hasPackageOutputOverride,
  packageAction,
  packageExecutable,
} from "../../package-command.ts";
import { completeSuccessfulCapture } from "../forge/capture.ts";
import { losslessTextProjection } from "../lossless-text.ts";
import {
  formatPackageInstall,
  formatPackageList,
  formatPackageOutdated,
  formatPackageRunner,
  formatPackageScript,
} from "./format.ts";

export function packageProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  const executable = packageExecutable(commandTokens);
  if (
    executable === null ||
    patterns.length > 0 ||
    hasPackageOutputOverride(commandTokens) ||
    !completeSuccessfulCapture(capture)
  ) {
    return losslessTextProjection(capture, maxBytes, patterns, false);
  }
  const source = capture.stdout.inlineText;
  if (source === null) {
    return losslessTextProjection(capture, maxBytes, patterns, false);
  }
  const action = packageAction(commandTokens);
  const formatted =
    action === "install"
      ? formatPackageInstall(executable, source)
      : action === "list"
        ? formatPackageList(executable, source)
        : action === "outdated"
          ? formatPackageOutdated(source)
          : action === "run"
            ? formatPackageScript(executable, source)
            : null;
  if (formatted === null && executable !== "npx" && executable !== "pnpx") {
    return joinStreams(
      boundStream("stdout", capture.stdout, maxBytes, [], false),
      boundStream("stderr", capture.stderr, maxBytes, [], false),
      maxBytes,
    );
  }
  const projected = formatted ?? formatPackageRunner(source);
  return joinStreams(
    boundText(projected, "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, [], false),
    maxBytes,
  );
}
