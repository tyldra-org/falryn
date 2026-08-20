/** React lifecycle around the shell's pure state and command boundaries. */

import type { TextareaRenderable } from "@opentui/core";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  admitComposerContext,
  digestBytes,
  enhancePrompt,
  type FileAttachmentProbe,
} from "../../application/index.ts";
import {
  type AttachmentDescriptor,
  MAX_EVIDENCE_INLINE_BYTES,
  parseMentions,
} from "../../domain/index.ts";
import type { TranscriptBlock } from "../../presentation/index.ts";
import type { CopyTextPort, CopyTextResult } from "../clipboard.ts";
import { type CommandState, commandById } from "../commands.ts";
import {
  type ComposerAction,
  parseComposerSlash,
  type SubmissionPort,
  UNAVAILABLE_SUBMISSION,
  workspacePanelForSlashCommand,
} from "../composer/index.ts";
import { createMemoryAttachmentPayloads } from "../composer/payload.ts";
import {
  applySecretEdit,
  type ConfirmationDecision,
  type ConfirmationPrompt,
  confirmationIsStale,
  type SecretEdit,
  secretGraphemeCount,
} from "../confirmation/index.ts";
import type { FocusRegion } from "../focus.ts";
import { classifyPaste, looksSecret } from "../paste.ts";
import {
  copyTranscriptBody,
  copyTranscriptIdentity,
  includeTranscriptInDraft,
  totalRowsOf,
} from "../transcript/index.ts";
import { EMPTY_GEOMETRY, type TranscriptGeometry } from "../transcript-model.ts";
import type { WorkspaceController, WorkspaceSetView } from "../workspace/index.ts";
import {
  describeWorkspaceControllerError,
  EMPTY_WORKSPACE_SET,
  workspaceOverlayRoute,
} from "../workspace/index.ts";
import { useRenderGate } from "./render-gate.tsx";
import { runAvailableCommand } from "./shell-command-runner.ts";
import {
  COMPOSER_REGION,
  commandStateFor,
  INITIAL_SHELL_STATE,
  type ShellState,
  shellReducer,
  TRANSCRIPT_REGION,
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
  TRANSCRIPT_REGION,
} from "./shell-state.ts";

export type ShellRuntime = {
  readonly state: ShellState;
  readonly commandState: CommandState;
  run(id: string): boolean;
  reseat(regions: readonly FocusRegion[]): void;
  reportTranscriptGeometry(geometry: TranscriptGeometry): void;
  registerTranscriptBody(renderable: TextareaRenderable | null): void;
  composer(action: ComposerAction): void;
  focusComposer(): void;
  paletteQuery(query: string): void;
  confirm(choice: "accept" | "deny"): boolean;
  editSecret(edit: SecretEdit): void;
  selectControl(field: "session" | "model", id: string): void;
  settleChanges(notice: string): void;
  workspaceDraft(draft: string): void;
  replaceWorkspace(set: WorkspaceSetView, notice: string): void;
  workspaceNotice(message: string): void;
  closeOverlay(): void;
};

export type ShellRuntimeOptions = {
  readonly onExit: () => void;
  readonly transcriptKeys: readonly string[];
  readonly transcriptBlocks?: readonly TranscriptBlock[];
  readonly submission?: SubmissionPort;
  readonly fileProbe?: FileAttachmentProbe | null;
  readonly confirmation?: ConfirmationPrompt | null;
  readonly onConfirmation?: (decision: ConfirmationDecision) => void;
  readonly onSecretSubmit?: (secret: string) => void;
  readonly copyPort?: CopyTextPort;
  /** Bound workspace set when the launch path attached one. */
  readonly workspace?: WorkspaceSetView;
  readonly workspaceController?: WorkspaceController | null;
};

const encoder = new TextEncoder();
const NO_BLOCKS: readonly TranscriptBlock[] = [];

export function useShellRuntime(options: ShellRuntimeOptions): ShellRuntime {
  const [state, dispatch] = useReducer(shellReducer, INITIAL_SHELL_STATE, (base) => ({
    ...base,
    workspace: options.workspace ?? EMPTY_WORKSPACE_SET,
  }));
  const blocks = options.transcriptBlocks ?? NO_BLOCKS;
  const commandState = useMemo(() => {
    const base = commandStateFor(state, blocks);
    if (options.workspaceController == null) {
      return {
        ...base,
        hasWorkspaceSet: false,
        hasRemovableWorkspaceRoot: false,
      };
    }
    return base;
  }, [state, blocks, options.workspaceController]);
  const geometry = useRef<TranscriptGeometry>(EMPTY_GEOMETRY);
  const gate = useRenderGate();
  const stateRef = useRef(state);
  stateRef.current = state;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const heldPaste = useRef<{
    readonly text: string;
    readonly characters: number;
    readonly lines: number;
  } | null>(null);
  const payloads = useRef(createMemoryAttachmentPayloads());
  const transcriptBody = useRef<TextareaRenderable | null>(null);
  const fileProbe = options.fileProbe ?? null;
  const secretRef = useRef("");
  const onConfirmation = options.onConfirmation;
  const onSecretSubmit = options.onSecretSubmit;
  const copyPort = options.copyPort ?? null;

  const editSecret = useCallback((edit: SecretEdit): void => {
    secretRef.current = applySecretEdit(secretRef.current, edit);
    dispatch({ kind: "secret-mask", graphemes: secretGraphemeCount(secretRef.current) });
  }, []);

  const confirm = useCallback(
    (choice: "accept" | "deny"): boolean => {
      const current = stateRef.current;
      const bound = current.boundConfirmation;
      const pending = current.pendingConfirmation;
      if (bound === null && pending === null) {
        return false;
      }
      if (choice === "deny") {
        const id = bound?.id ?? pending?.id ?? "";
        secretRef.current = "";
        dispatch({ kind: "resolve-confirmation", decision: "refused" });
        onConfirmation?.({ status: "refused", id });
        return true;
      }
      if (bound === null || confirmationIsStale(bound, pending)) {
        dispatch({
          kind: "notice",
          message: "Accept is unavailable: this confirmation is no longer valid.",
        });
        return false;
      }
      if (bound.secret !== null && secretRef.current === "") {
        dispatch({
          kind: "notice",
          message: "Accept is unavailable: the secret field is empty.",
        });
        return false;
      }
      if (bound.secret !== null) {
        onSecretSubmit?.(secretRef.current);
      }
      secretRef.current = "";
      dispatch({ kind: "resolve-confirmation", decision: "accepted" });
      onConfirmation?.({
        status: "accepted",
        id: bound.id,
        fingerprint: bound.fingerprint,
      });
      return true;
    },
    [onConfirmation, onSecretSubmit],
  );

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

  const registerTranscriptBody = useCallback((renderable: TextareaRenderable | null): void => {
    transcriptBody.current = renderable;
  }, []);

  const includeTranscriptPick = useCallback((): boolean => {
    const current = stateRef.current;
    const selection = transcriptBody.current?.getSelection() ?? null;
    const nativeRange = selection !== null && selection.start !== selection.end ? selection : null;
    const result = includeTranscriptInDraft({
      selected: current.transcript.selected,
      expanded: current.transcript.expanded,
      blocks: blocksRef.current,
      attachments: current.composer.attachments,
      nextId: `att-${current.composer.attachmentSeq + 1}`,
      nativeRange,
    });
    if (!result.ok) {
      dispatch({ kind: "notice", message: result.reason });
      if (current.overlay.kind === "palette") {
        dispatch({ kind: "close-overlay" });
      }
      dispatch({ kind: "focus-region", id: TRANSCRIPT_REGION });
      return false;
    }
    payloads.current.put(result.attachment.id, result.bytes);
    dispatch({ kind: "composer", action: { kind: "attach", attachment: result.attachment } });
    if (current.overlay.kind === "palette") {
      dispatch({ kind: "close-overlay" });
    }
    dispatch({ kind: "focus-region", id: TRANSCRIPT_REGION });
    return true;
  }, []);

  const digestRange = useCallback((text: string): string => {
    return digestBytes(encoder.encode(text));
  }, []);

  const reportCopy = useCallback((result: CopyTextResult): boolean => {
    if (!result.ok) {
      dispatch({ kind: "notice", message: result.reason });
      dispatch({ kind: "focus-region", id: TRANSCRIPT_REGION });
      return false;
    }
    const message =
      result.delivery === "clipboard"
        ? "Copied to the clipboard."
        : "Clipboard unavailable; copied to plain output.";
    dispatch({ kind: "notice", message });
    dispatch({ kind: "focus-region", id: TRANSCRIPT_REGION });
    return true;
  }, []);

  const copyTranscriptPick = useCallback((): boolean => {
    if (copyPort === null) {
      dispatch({ kind: "notice", message: "Copy is unavailable in this frame." });
      return false;
    }
    const current = stateRef.current;
    const selection = transcriptBody.current?.getSelection() ?? null;
    const nativeRange = selection !== null && selection.start !== selection.end ? selection : null;
    return reportCopy(
      copyTranscriptBody({
        selected: current.transcript.selected,
        expanded: current.transcript.expanded,
        blocks: blocksRef.current,
        nativeRange,
        port: copyPort,
        digestRange,
      }),
    );
  }, [copyPort, digestRange, reportCopy]);

  const copyTranscriptIdentityPick = useCallback((): boolean => {
    if (copyPort === null) {
      dispatch({ kind: "notice", message: "Copy is unavailable in this frame." });
      return false;
    }
    const current = stateRef.current;
    return reportCopy(
      copyTranscriptIdentity({
        selected: current.transcript.selected,
        blocks: blocksRef.current,
        port: copyPort,
      }),
    );
  }, [copyPort, reportCopy]);

  const submitComposer = useCallback((): void => {
    const current = stateRef.current.composer;
    const slash = parseComposerSlash(current.text);
    if (slash !== null) {
      if (slash.kind === "unresolved") {
        dispatch({ kind: "notice", message: slash.reason });
        return;
      }

      const command = commandById(slash.commandId);
      if (command === undefined) {
        dispatch({ kind: "notice", message: `No command named ${slash.commandId}.` });
        return;
      }
      const availability = command.availability(
        commandStateFor(stateRef.current, blocksRef.current),
      );
      if (availability.kind === "unavailable") {
        dispatch({
          kind: "notice",
          message: `${command.title} is unavailable: ${availability.reason}.`,
        });
        return;
      }

      if (slash.commandId === "workspace.load" && slash.argument !== null) {
        const layoutName = slash.argument;
        const controller = options.workspaceController ?? null;
        if (controller === null) {
          dispatch({
            kind: "notice",
            message: `${command.title} is unavailable: no workspace set yet.`,
          });
          return;
        }
        void (async () => {
          const result = await controller.load(layoutName);
          if (!result.ok) {
            dispatch({
              kind: "notice",
              message: describeWorkspaceControllerError(result.error),
            });
            return;
          }
          dispatch({ kind: "workspace-set", workspace: result.value });
          dispatch({
            kind: "notice",
            message: `Loaded layout “${layoutName.trim()}”.`,
          });
          dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
        })();
        return;
      }

      const panel = workspacePanelForSlashCommand(slash.commandId);
      if (panel === null) {
        dispatch({ kind: "notice", message: `No workspace panel for ${slash.commandId}.` });
        return;
      }
      const draft = panel === "add" || panel === "save" ? (slash.argument ?? "") : "";
      dispatch({
        kind: "open-overlay",
        route: workspaceOverlayRoute(panel, draft),
      });
      dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
      return;
    }

    void (async () => {
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
  }, [fileProbe, options.workspaceController]);

  const run = useCallback(
    (id: string): boolean => {
      gate.note("input");
      const command = commandById(id);
      if (command === undefined) {
        dispatch({ kind: "notice", message: `No command named ${id}.` });
        return false;
      }

      const availability = command.availability(
        commandStateFor(stateRef.current, blocksRef.current),
      );
      if (availability.kind === "unavailable") {
        dispatch({
          kind: "notice",
          message: `${command.title} is unavailable: ${availability.reason}.`,
        });
        return false;
      }

      switch (id) {
        case "confirmation.accept":
          return confirm("accept");
        case "confirmation.deny":
          return confirm("deny");
        case "overlay.close":
          if (stateRef.current.overlay.kind === "confirm") {
            return confirm("deny");
          }
          dispatch({ kind: "close-overlay" });
          return true;
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
        case "transcript.includeInDraft":
          return includeTranscriptPick();
        case "transcript.copy":
          return copyTranscriptPick();
        case "transcript.copyIdentity":
          return copyTranscriptIdentityPick();
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
        case "composer.enhancePrompt": {
          const current = stateRef.current.composer;
          const outcome = enhancePrompt({
            text: current.text,
            revision: current.draftRevision,
            path: "local",
            attachments: current.attachments.map((item) => item.identity),
          });
          dispatch({ kind: "composer", action: { kind: "enhance", outcome } });
          dispatch({ kind: "close-overlay" });
          return true;
        }
        case "composer.acceptEnhancement":
          dispatch({ kind: "composer", action: { kind: "accept-enhancement" } });
          dispatch({ kind: "close-overlay" });
          return true;
        case "composer.rejectEnhancement":
          dispatch({ kind: "composer", action: { kind: "reject-enhancement" } });
          dispatch({ kind: "close-overlay" });
          return true;
        default:
          break;
      }

      return runAvailableCommand(command, dispatch, options.onExit, {
        geometry: geometry.current,
        anchor: stateRef.current.transcript.anchor,
        selected: stateRef.current.transcript.selected,
        keys: options.transcriptKeys,
        blocks: blocksRef.current,
      });
    },
    [
      options.onExit,
      options.transcriptKeys,
      gate,
      includeHeldPaste,
      includeTranscriptPick,
      copyTranscriptPick,
      copyTranscriptIdentityPick,
      submitComposer,
      confirm,
    ],
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

  const confirmation = options.confirmation ?? null;
  useEffect(() => {
    if (confirmation === null) {
      dispatch({ kind: "withdraw-confirmation" });
      return;
    }
    dispatch({ kind: "offer-confirmation", prompt: confirmation });
  }, [confirmation]);

  const port = options.submission ?? UNAVAILABLE_SUBMISSION;
  const inFlight = state.composer.inFlight;
  useEffect(() => {
    if (inFlight !== null) {
      dispatch({ kind: "composer", action: { kind: "resolve", outcome: port.submit(inFlight) } });
    }
  }, [inFlight, port]);

  const selectControl = useCallback((field: "session" | "model", id: string): void => {
    dispatch({ kind: "select-control", field, id });
  }, []);

  const settleChanges = useCallback((notice: string): void => {
    dispatch({ kind: "changes-settled", notice });
  }, []);

  const workspaceDraft = useCallback(
    (draft: string): void => {
      gate.note("input");
      dispatch({ kind: "workspace-draft", draft });
    },
    [gate],
  );

  const replaceWorkspace = useCallback((set: WorkspaceSetView, notice: string): void => {
    dispatch({ kind: "workspace-set", workspace: set });
    dispatch({ kind: "notice", message: notice });
  }, []);

  const workspaceNotice = useCallback((message: string): void => {
    dispatch({ kind: "notice", message });
  }, []);

  const closeOverlay = useCallback((): void => {
    dispatch({ kind: "close-overlay" });
  }, []);

  return {
    state,
    commandState,
    run,
    reseat,
    reportTranscriptGeometry,
    registerTranscriptBody,
    composer,
    focusComposer,
    paletteQuery,
    confirm,
    editSecret,
    selectControl,
    settleChanges,
    workspaceDraft,
    replaceWorkspace,
    workspaceNotice,
    closeOverlay,
  };
}
