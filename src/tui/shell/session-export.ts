/** Shell lifetime and cancellation for the shared session export control. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionExportControl } from "../../application/sessions/session-export.ts";
import type { ShellAction } from "./shell-state.ts";
export function useSessionExport(
  control: SessionExportControl | undefined,
  dispatch: (action: ShellAction) => void,
) {
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(
    () => () => {
      const previous = active.current;
      active.current = null;
      previous?.abort();
    },
    [],
  );
  const run = useCallback(
    (argument: string | null) => {
      if (!control) {
        dispatch({ kind: "notice", message: "Session export is unavailable in this shell." });
        return false;
      }
      if (active.current) {
        dispatch({
          kind: "notice",
          message: "An export is running. Escape requests cancellation.",
        });
        return false;
      }
      const controller = new AbortController();
      active.current = controller;
      setPending(true);
      dispatch({ kind: "close-overlay" });
      dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
      dispatch({ kind: "notice", message: "Preparing session export…" });
      void control(argument, controller.signal)
        .then(
          (result) => {
            if (active.current !== controller) return;
            dispatch({ kind: "notice", message: result.message });
          },
          () => {
            if (active.current === controller)
              dispatch({
                kind: "notice",
                message: "Export interrupted; inspect its destination before retrying a write.",
              });
          },
        )
        .finally(() => {
          if (active.current === controller) {
            active.current = null;
            setPending(false);
          }
        });
      return true;
    },
    [control, dispatch],
  );
  const cancel = useCallback(() => {
    if (!active.current) return false;
    active.current.abort();
    return true;
  }, []);
  return { run, pending, cancel };
}
