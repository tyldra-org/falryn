import type { ProcessCaptureReport, ProcessStreamCapture } from "../../../process-capture.ts";

export function completeSuccessfulCapture(capture: ProcessCaptureReport): boolean {
  return (
    capture.stop.kind === "exited" &&
    capture.exit.exitCode === 0 &&
    capture.exit.signal === null &&
    completeText(capture.stdout) &&
    completeText(capture.stderr)
  );
}

function completeText(capture: ProcessStreamCapture): boolean {
  return (
    capture.encoding === "utf-8" &&
    capture.inlineText !== null &&
    !capture.truncated &&
    capture.omittedBytes === 0 &&
    !capture.maxLineExceeded
  );
}
