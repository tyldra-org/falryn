/** React lifecycle around the shell's pure state and command boundaries. */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { type CommandState, commandById } from "../commands.ts";
import {
  type ComposerAction,
  type SubmissionPort,
  UNAVAILABLE_SUBMISSION,
} from "../composer/index.ts";
import type { FocusRegion } from "../focus.ts";
import { totalRowsOf } from "../transcript/index.ts";
import { EMPTY_GEOMETRY, type TranscriptGeometry } from "../transcript-model.ts";
import { runAvailableCommand } from "./shell-command-runner.ts";
import {
  COMPOSER_REGION,
  commandStateFor,
  INITIAL_SHELL_STATE,
  type ShellState,
  shellReducer,
} from "./shell-state.ts";

export type {
  ShellAction,
  ShellState,
  TranscriptFacts,
} from "./shell-state.ts";
export {
  activeContexts,
  COMPOSER_REGION,
  commandStateFor,
  FRAME_REGIONS,
  INITIAL_SHELL_STATE,
  NO_TRANSCRIPT,
  overlayRegions,
  shellReducer,
} from "./shell-state.ts";

export type ShellRuntime = {
  readonly state: ShellState;
  readonly commandState: CommandState;
  run(id: string): boolean;
  reseat(regions: readonly FocusRegion[]): void;
  reportTranscriptGeometry(geometry: TranscriptGeometry): void;
  composer(action: ComposerAction): void;
  focusComposer(): void;
  paletteQuery(query: string): void;
};

export type ShellRuntimeOptions = {
  readonly onExit: () => void;
  readonly transcriptKeys: readonly string[];
  readonly submission?: SubmissionPort;
};

export function useShellRuntime(options: ShellRuntimeOptions): ShellRuntime {
  const [state, dispatch] = useReducer(shellReducer, INITIAL_SHELL_STATE);
  const commandState = useMemo(() => commandStateFor(state), [state]);
  const geometry = useRef<TranscriptGeometry>(EMPTY_GEOMETRY);

  const reportTranscriptGeometry = useCallback((next: TranscriptGeometry): void => {
    geometry.current = next;
    dispatch({
      kind: "transcript-facts",
      facts: { blocks: next.spans.length, scrollable: totalRowsOf(next.spans) > next.rows },
    });
  }, []);

  const run = useCallback(
    (id: string): boolean => {
      const command = commandById(id);
      if (command === undefined) {
        dispatch({ kind: "notice", message: `No command named ${id}.` });
        return false;
      }

      const availability = command.availability(commandStateFor(state));
      if (availability.kind === "unavailable") {
        dispatch({
          kind: "notice",
          message: `${command.title} is unavailable: ${availability.reason}.`,
        });
        return false;
      }

      return runAvailableCommand(command, dispatch, options.onExit, {
        geometry: geometry.current,
        anchor: state.transcript.anchor,
        selected: state.transcript.selected,
        keys: options.transcriptKeys,
      });
    },
    [state, options.onExit, options.transcriptKeys],
  );

  const reseat = useCallback((regions: readonly FocusRegion[]): void => {
    dispatch({ kind: "reseat", regions });
  }, []);

  const composer = useCallback((action: ComposerAction): void => {
    dispatch({ kind: "composer", action });
  }, []);

  const focusComposer = useCallback((): void => {
    dispatch({ kind: "focus-region", id: COMPOSER_REGION });
  }, []);

  const paletteQuery = useCallback((query: string): void => {
    dispatch({ kind: "palette-query", query });
  }, []);

  const { transcriptKeys } = options;
  useEffect(() => {
    dispatch({ kind: "transcript", action: { kind: "reconcile", keys: transcriptKeys } });
  }, [transcriptKeys]);

  const port = options.submission ?? UNAVAILABLE_SUBMISSION;
  const inFlight = state.composer.inFlight;
  useEffect(() => {
    if (inFlight !== null) {
      dispatch({ kind: "composer", action: { kind: "resolve", outcome: port.submit(inFlight) } });
    }
  }, [inFlight, port]);

  return {
    state,
    commandState,
    run,
    reseat,
    reportTranscriptGeometry,
    composer,
    focusComposer,
    paletteQuery,
  };
}
