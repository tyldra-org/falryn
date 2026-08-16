/** React lifecycle around the shell's pure state and command boundaries. */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  admitComposerContext,
  digestBytes,
  type FileAttachmentProbe,
} from "../../application/index.ts";
import {
  type AttachmentDescriptor,
  MAX_EVIDENCE_INLINE_BYTES,
  parseMentions,
} from "../../domain/index.ts";
import { type CommandState, commandById } from "../commands.ts";
import {
  type ComposerAction,
  type SubmissionPort,
  UNAVAILABLE_SUBMISSION,
} from "../composer/index.ts";
import { createMemoryAttachmentPayloads } from "../composer/payload.ts";
import type { FocusRegion } from "../focus.ts";
import { classifyPaste, looksSecret } from "../paste.ts";
import { totalRowsOf } from "../transcript/index.ts";
import { EMPTY_GEOMETRY, type TranscriptGeometry } from "../transcript-model.ts";
import { useRenderGate } from "./render-gate.tsx";
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
  readonly fileProbe?: FileAttachmentProbe | null;
};

const encoder = new TextEncoder();

export function useShellRuntime(options: ShellRuntimeOptions): ShellRuntime {
  const [state, dispatch] = useReducer(shellReducer, INITIAL_SHELL_STATE);
  const commandState = useMemo(() => commandStateFor(state), [state]);
  const geometry = useRef<TranscriptGeometry>(EMPTY_GEOMETRY);
  const gate = useRenderGate();
  const stateRef = useRef(state);
  stateRef.current = state;
  const heldPaste = useRef<{
    readonly text: string;
    readonly characters: number;
    readonly lines: number;
  } | null>(null);
  const payloads = useRef(createMemoryAttachmentPayloads());
  const fileProbe = options.fileProbe ?? null;

  const reportTranscriptGeometry = useCallback((next: TranscriptGeometry): void => {
    geometry.current = next;
    dispatch({
      kind: "transcript-facts",
      facts: { blocks: next.spans.length, scrollable: totalRowsOf(next.spans) > next.rows },
    });
  }, []);

  const includeHeldPaste = useCallback((): boolean => {
    const held = heldPaste.current;
    if (held === null) {
      return false;
    }
    const bytes = encoder.encode(held.text);
    const seq = stateRef.current.composer.attachmentSeq + 1;
    const id = `att-${seq}`;
    payloads.current.put(id, bytes);
    const oversized = bytes.byteLength > MAX_EVIDENCE_INLINE_BYTES;
    const attachment: AttachmentDescriptor = {
      id,
      kind: "paste",
      identity: `paste:${id}`,
      status: oversized ? "oversized" : "ready",
      byteLength: bytes.byteLength,
      characters: held.characters,
      lines: held.lines,
      digest: digestBytes(bytes),
      revision: null,
      mediaType: "text/plain",
      secret: looksSecret(held.text),
    };
    heldPaste.current = null;
    dispatch({ kind: "composer", action: { kind: "include-paste", attachment } });
    return true;
  }, []);

  const submitComposer = useCallback((): void => {
    void (async () => {
      const current = stateRef.current.composer;
      const resolved = await admitComposerContext(
        {
          attachments: current.attachments,
          mentions: parseMentions(current.text),
          payloads: payloads.current,
        },
        fileProbe,
      );
      dispatch({
        kind: "composer",
        action: { kind: "submit", attachments: resolved.attachments },
      });
    })();
  }, [fileProbe]);

  const run = useCallback(
    (id: string): boolean => {
      gate.note("input");
      const command = commandById(id);
      if (command === undefined) {
        dispatch({ kind: "notice", message: `No command named ${id}.` });
        return false;
      }

      const availability = command.availability(commandStateFor(stateRef.current));
      if (availability.kind === "unavailable") {
        dispatch({
          kind: "notice",
          message: `${command.title} is unavailable: ${availability.reason}.`,
        });
        return false;
      }

      switch (id) {
        case "composer.submit":
          submitComposer();
          return true;
        case "composer.includePaste": {
          const included = includeHeldPaste();
          if (included) {
            dispatch({ kind: "close-overlay" });
          }
          return included;
        }
        case "composer.excludePaste":
          heldPaste.current = null;
          dispatch({ kind: "composer", action: { kind: "exclude-paste" } });
          dispatch({ kind: "close-overlay" });
          return true;
        case "composer.removeAttachment": {
          const last = stateRef.current.composer.attachments.at(-1);
          if (last === undefined) {
            return false;
          }
          payloads.current.drop(last.id);
          dispatch({ kind: "composer", action: { kind: "remove-attachment", id: last.id } });
          dispatch({ kind: "close-overlay" });
          return true;
        }
        case "composer.moveAttachmentEarlier":
        case "composer.moveAttachmentLater": {
          const last = stateRef.current.composer.attachments.at(-1);
          if (last === undefined) {
            return false;
          }
          dispatch({
            kind: "composer",
            action: {
              kind: "move-attachment",
              id: last.id,
              direction: id === "composer.moveAttachmentEarlier" ? "earlier" : "later",
            },
          });
          dispatch({ kind: "close-overlay" });
          return true;
        }
        default:
          break;
      }

      return runAvailableCommand(command, dispatch, options.onExit, {
        geometry: geometry.current,
        anchor: stateRef.current.transcript.anchor,
        selected: stateRef.current.transcript.selected,
        keys: options.transcriptKeys,
      });
    },
    [options.onExit, options.transcriptKeys, gate, includeHeldPaste, submitComposer],
  );

  const reseat = useCallback((regions: readonly FocusRegion[]): void => {
    dispatch({ kind: "reseat", regions });
  }, []);

  const composer = useCallback(
    (action: ComposerAction): void => {
      gate.note("input");
      if (action.kind === "paste") {
        const classified = classifyPaste(action.text);
        heldPaste.current =
          classified.verdict === "preview"
            ? {
                text: classified.text,
                characters: classified.characters,
                lines: classified.lines,
              }
            : null;
        dispatch({ kind: "composer", action });
        return;
      }
      if (action.kind === "submit") {
        submitComposer();
        return;
      }
      dispatch({ kind: "composer", action });
    },
    [gate, submitComposer],
  );

  const focusComposer = useCallback((): void => {
    gate.note("input");
    dispatch({ kind: "focus-region", id: COMPOSER_REGION });
  }, [gate]);

  const paletteQuery = useCallback(
    (query: string): void => {
      gate.note("input");
      dispatch({ kind: "palette-query", query });
    },
    [gate],
  );

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
