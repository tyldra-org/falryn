/** Shell lifetime and cancellation for admitted session operations. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellAction } from "./shell-state.ts";
export function useSessionOperation(
  control:
    | ((argument: string | null, signal: AbortSignal) => Promise<{ readonly message: string }>)
    | undefined,
  dispatch: (action: ShellAction) => void,
  label: string,
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
        dispatch({ kind: "notice", message: `${label} is unavailable in this shell.` });
        return false;
      }
      if (active.current) {
        dispatch({
          kind: "notice",
          message: `${label} is running. Escape requests cancellation.`,
        });
        return false;
      }
      const controller = new AbortController();
      active.current = controller;
      setPending(true);
      dispatch({ kind: "close-overlay" });
      dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
      dispatch({ kind: "notice", message: `Preparing ${label.toLowerCase()}…` });
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
                message: `${label} interrupted; inspect its receipt before retrying a write.`,
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
    [control, dispatch, label],
  );
  const cancel = useCallback(() => {
    if (!active.current) return false;
    active.current.abort();
    return true;
  }, []);
  return { run, pending, cancel };
}
