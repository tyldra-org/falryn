/** React lifecycle around the shell's pure state and command boundaries. */

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

import type { TextareaRenderable } from "@opentui/core";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  ProductBriefControls,
  ProductOutputControls,
} from "../../application/compression/index.ts";
import {
  digestBytes,
  enhancePrompt,
  resolveComposerAttachments,
} from "../../application/context/index.ts";
import type {
  ProductExecutionProfileControls,
  ProductModelSelectionControls,
} from "../../application/runtime/index.ts";
import {
  type AttachmentDescriptor,
  MAX_EVIDENCE_INLINE_BYTES,
  parseMentions,
} from "../../domain/context/index.ts";
import { isExecutionProfileId } from "../../domain/sessions/index.ts";
import type { TranscriptBlock } from "../../presentation/index.ts";
import { providerModelIdentityKey } from "../../providers/index.ts";
import { type CommandState, commandById } from "../commands/commands.ts";
import {
  type ComposerAction,
  parseComposerSlash,
  type SubmissionPort,
  UNAVAILABLE_SUBMISSION,
  workspacePanelForSlashCommand,
} from "../composer/index.ts";
import { requestFromComposer, submitWhileActive } from "../composer/mid-turn.ts";
import { classifyPaste, looksSecret } from "../composer/paste.ts";
import { createMemoryAttachmentPayloads } from "../composer/payload.ts";
import {
  applySecretEdit,
  confirmationIsStale,
  type SecretEdit,
  secretGraphemeCount,
} from "../confirmation/index.ts";
import type { CopyTextResult } from "../runtime/clipboard.ts";
import type { SessionNavigationController } from "../session-nav/index.ts";
import {
  copyTranscriptBody,
  copyTranscriptIdentity,
  includeTranscriptInDraft,
  totalRowsOf,
} from "../transcript/index.ts";
import { EMPTY_GEOMETRY, type TranscriptGeometry } from "../transcript/transcript-model.ts";
import { useRenderGate } from "../visual/render-gate.tsx";
import type { WorkspaceController, WorkspaceSetView } from "../workspace/index.ts";
import {
  describeWorkspaceControllerError,
  EMPTY_WORKSPACE_SET,
  workspaceOverlayRoute,
} from "../workspace/index.ts";
import { compressionControlState } from "./compression.ts";
import type { FocusRegion } from "./focus.ts";
import type { SessionCreationPort } from "./session-creation.ts";
import { runAvailableCommand } from "./shell-command-runner.ts";
import type { ShellRuntime, ShellRuntimeOptions } from "./shell-runtime/contracts.ts";
import { useShellControls } from "./shell-runtime/controls.ts";
import {
  COMPOSER_REGION,
  commandStateFor,
  INITIAL_SHELL_STATE,
  type ShellState,
  shellReducer,
  TRANSCRIPT_REGION,
} from "./shell-state.ts";

export type { ShellRuntime, ShellRuntimeOptions } from "./shell-runtime/contracts.ts";

const encoder = new TextEncoder();

const NO_BLOCKS: readonly TranscriptBlock[] = [];

function resolveCommandState(
  state: ShellState,
  blocks: readonly TranscriptBlock[],
  ports: {
    readonly workspaceController?: WorkspaceController | null;
    readonly sessionNavigationController?: SessionNavigationController | null;
    readonly sessionCreation?: SessionCreationPort | null;
    readonly peerPending?: boolean;
  },
): CommandState {
  const derived = commandStateFor(state, blocks);
  const base = { ...derived, hasRunningWork: derived.hasRunningWork || ports.peerPending === true };
  let next = base;
  if (ports.workspaceController == null) {
    next = {
      ...next,
      hasWorkspaceSet: false,
      hasRemovableWorkspaceRoot: false,
    };
  }
  if (ports.sessionNavigationController != null) {
    next = { ...next, hasSessionNavigation: true };
  }
  if (ports.sessionCreation != null) {
    next = { ...next, hasSessionCreation: true };
  }
  return next;
}

export function useShellRuntime(options: ShellRuntimeOptions): ShellRuntime {
  const peerAction = useRef<AbortController | null>(null);
  const [peerPending, setPeerPending] = useState(false);
  const modelSelection =
    options.submission !== undefined && "modelSelection" in options.submission
      ? (
          options.submission as SubmissionPort & {
            readonly modelSelection: ProductModelSelectionControls;
          }
        ).modelSelection
      : null;
  const [state, dispatch] = useReducer(shellReducer, INITIAL_SHELL_STATE, (base) => {
    const selectedModel = modelSelection?.get() ?? null;
    return {
      ...base,
      workspace: options.workspace ?? EMPTY_WORKSPACE_SET,
      selectedModelKey:
        selectedModel === null ? base.selectedModelKey : providerModelIdentityKey(selectedModel),
    };
  });
  const blocks = options.transcriptBlocks ?? NO_BLOCKS;
  const commandState = useMemo(
    () =>
      resolveCommandState(state, blocks, {
        workspaceController: options.workspaceController ?? null,
        sessionNavigationController: options.sessionNavigationController ?? null,
        sessionCreation: options.sessionCreation ?? null,
        peerPending,
      }),
    [
      state,
      blocks,
      options.workspaceController,
      options.sessionNavigationController,
      options.sessionCreation,
      peerPending,
    ],
  );
  const commandStateRef = useRef(commandState);
  commandStateRef.current = commandState;
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
  /**
   * After a mid-turn clear, the textarea can echo its still-uncleared buffer
   * through `onContentChange` in the same turn. Absorb non-empty drafts until
   * the model `setText("")` effect has had a chance to run.
   */
  const absorbDraftEcho = useRef(false);
  const payloads = useRef(createMemoryAttachmentPayloads());
  const transcriptBody = useRef<TextareaRenderable | null>(null);
  const fileProbe = options.fileProbe ?? null;
  const secretRef = useRef("");
  const onConfirmation = options.onConfirmation;
  const onSecretSubmit = options.onSecretSubmit;
  const copyPort = options.copyPort ?? null;
  const submissionBrief =
    options.submission !== undefined && options.submission !== null && "brief" in options.submission
      ? (options.submission as { brief: ProductBriefControls }).brief
      : null;
  const briefControls = options.brief ?? submissionBrief;
  const submissionOutput =
    options.submission !== undefined &&
    options.submission !== null &&
    "output" in options.submission
      ? (options.submission as { output: ProductOutputControls }).output
      : null;
  const outputControls = options.output ?? submissionOutput;
  const compression = compressionControlState(briefControls, outputControls);

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

  const submitMidTurn = useCallback(
    (intent: "steer" | "follow-up" | "interrupt"): boolean => {
      const midTurn = options.midTurn ?? null;
      if (midTurn === null) {
        dispatch({ kind: "notice", message: "No mid-turn runtime is attached." });
        return false;
      }
      const current = stateRef.current.composer;
      const result = submitWhileActive(
        midTurn,
        intent,
        requestFromComposer(
          current.text,
          current.attachments.map((item) => item.id),
        ),
      );
      dispatch({ kind: "notice", message: result.notice });
      dispatch({
        kind: "running-work",
        running: midTurn.view().active !== null,
      });
      if (result.ok && result.clearDraft) {
        absorbDraftEcho.current = true;
        dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
        // Cleared after paint — a microtask runs before the textarea sync and
        // is too early to unblock; a stale content-change would restore the draft.
        setTimeout(() => {
          absorbDraftEcho.current = false;
        }, 0);
      }
      return result.ok;
    },
    [options.midTurn],
  );

  const submitComposer = useCallback((): void => {
    const current = stateRef.current.composer;
    if (/^\/peer(?:\s|$)/u.test(current.text.trim())) {
      const peer = options.submission?.peer;
      if (!peer) {
        dispatch({ kind: "notice", message: "Peer messaging is unavailable for this session." });
        return;
      }
      if (encoder.encode(current.text).byteLength > 65_536) {
        dispatch({ kind: "notice", message: "Peer action exceeds 64 KiB." });
        return;
      }
      let action: unknown;
      try {
        action = JSON.parse(current.text.trim().slice(5).trim() || '{"operation":"endpoint"}');
      } catch {
        dispatch({
          kind: "notice",
          message:
            'Use /peer followed by a bounded JSON action, for example {"operation":"discover"}.',
        });
        return;
      }
      peerAction.current?.abort();
      const controller = new AbortController();
      peerAction.current = controller;
      setPeerPending(true);
      void peer(action, controller.signal)
        .then(
          (result) => {
            if (controller.signal.aborted) return;
            const text = JSON.stringify(result);
            dispatch({
              kind: "notice",
              message:
                encoder.encode(text).byteLength <= 262_144
                  ? text
                  : "Peer result exceeds 256 KiB. Request a smaller history page or inspect one receipt.",
            });
          },
          () => {
            if (!controller.signal.aborted)
              dispatch({ kind: "notice", message: "Peer action unavailable." });
          },
        )
        .finally(() => {
          if (peerAction.current === controller) {
            peerAction.current = null;
            setPeerPending(false);
          }
        });
      return;
    }
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
      const availability = command.availability(commandStateRef.current);
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

      if (slash.commandId === "brief.set") {
        const brief = briefControls;
        if (brief === null) {
          dispatch({
            kind: "notice",
            message: "Brief controls are not attached to this shell.",
          });
          return;
        }
        const mode = slash.argument?.trim() ?? "";
        if (mode === "") {
          dispatch({
            kind: "notice",
            message: `Brief is ${brief.getFrontendMode()} (use /brief compact|balanced|detailed|auto|on|off).`,
          });
          dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
          return;
        }
        const set = brief.setFrontendMode(mode);
        if (!set.ok) {
          dispatch({
            kind: "notice",
            message: `Unsupported Brief mode “${mode}”. Use compact|balanced|detailed|auto|on|off.`,
          });
          return;
        }
        dispatch({
          kind: "notice",
          message: `Brief set to ${brief.getFrontendMode()}.`,
        });
        dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
        return;
      }

      if (slash.commandId === "hush.set" || slash.commandId === "loom.set") {
        const output = outputControls;
        const engine = slash.commandId === "hush.set" ? "Hush" : "Loom";
        if (output === null) {
          dispatch({
            kind: "notice",
            message: `${engine} controls are not attached to this shell.`,
          });
          return;
        }
        const state = slash.argument?.trim().toLowerCase() ?? "";
        const current =
          slash.commandId === "hush.set" ? output.getHushState() : output.getLoomState();
        if (state === "") {
          dispatch({
            kind: "notice",
            message: `${engine} is ${current} (use /${engine.toLowerCase()} on|off).`,
          });
          dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
          return;
        }
        const set =
          slash.commandId === "hush.set" ? output.setHushState(state) : output.setLoomState(state);
        if (!set.ok) {
          dispatch({
            kind: "notice",
            message: `Unsupported ${engine} state “${state}”. Use on|off.`,
          });
          return;
        }
        dispatch({ kind: "notice", message: `${engine} set to ${set.value}.` });
        dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
        return;
      }

      if (slash.commandId === "mode.select") {
        const executionProfile =
          options.submission !== undefined &&
          options.submission !== null &&
          "executionProfile" in options.submission
            ? (options.submission as { executionProfile: ProductExecutionProfileControls })
                .executionProfile
            : null;
        if (executionProfile === null) {
          dispatch({
            kind: "notice",
            message: "Execution profile controls are not attached to this shell.",
          });
          return;
        }
        const profileId = slash.argument?.trim().toLowerCase() ?? "";
        if (profileId === "") {
          dispatch({
            kind: "notice",
            message: `Execution mode is ${executionProfile.get()} (use /mode ask|plan|debug|agent).`,
          });
          dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
          return;
        }
        if (!isExecutionProfileId(profileId)) {
          dispatch({
            kind: "notice",
            message: `Unsupported execution mode “${profileId}”. Use ask|plan|debug|agent.`,
          });
          return;
        }
        void (async () => {
          const selected = await executionProfile.select(profileId);
          if (!selected.ok) {
            dispatch({ kind: "notice", message: selected.message });
            return;
          }
          dispatch({
            kind: "notice",
            message: selected.changed
              ? `Execution mode set to ${selected.profileId}; active work keeps its bound policy.`
              : `Execution mode is already ${selected.profileId}.`,
          });
          dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
        })();
        return;
      }

      if (slash.commandId === "model.settings") {
        dispatch({ kind: "open-overlay", route: { kind: "model-settings" } });
        dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
        return;
      }
      if (slash.commandId === "compression.show") {
        dispatch({ kind: "open-overlay", route: { kind: "compression" } });
        dispatch({ kind: "composer", action: { kind: "draft", text: "" } });
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

    const midTurn = options.midTurn ?? null;
    if (midTurn !== null && midTurn.view().active !== null) {
      // Documented default while a turn is active: queue a follow-up.
      submitMidTurn("follow-up");
      return;
    }

    void (async () => {
      const resolved = await resolveComposerAttachments(
        current.attachments,
        parseMentions(current.text),
        fileProbe,
      );
      dispatch({
        kind: "composer",
        action: { kind: "submit", attachments: resolved },
      });
    })();
  }, [
    fileProbe,
    briefControls,
    options.midTurn,
    outputControls,
    options.submission,
    options.workspaceController,
    submitMidTurn,
  ]);

  const run = useCallback(
    (id: string): boolean => {
      gate.note("input");
      const command = commandById(id);
      if (command === undefined) {
        dispatch({ kind: "notice", message: `No command named ${id}.` });
        return false;
      }

      const availability = command.availability(commandStateRef.current);
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
        case "composer.submitAsSteer":
          return submitMidTurn("steer");
        case "composer.submitAsFollowUp":
          return submitMidTurn("follow-up");
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
        case "app.cancel": {
          if (peerAction.current) {
            peerAction.current.abort();
            peerAction.current = null;
            setPeerPending(false);
            dispatch({
              kind: "notice",
              message: "Local peer wait cancelled. Remote work continues independently.",
            });
            return true;
          }
          const midTurn = options.midTurn ?? null;
          if (midTurn !== null && midTurn.view().active !== null) {
            return submitMidTurn("interrupt");
          }
          break;
        }
        case "session.new": {
          const sessionCreation = options.sessionCreation ?? null;
          if (sessionCreation === null) {
            break;
          }
          dispatch({ kind: "close-overlay" });
          dispatch({ kind: "notice", message: "Starting a new durable session…" });
          void sessionCreation.create().then((created) => {
            dispatch({
              kind: "notice",
              message: created.ok
                ? `Started session ${created.sessionId}.`
                : `Could not start a new session: ${created.reason}`,
            });
          });
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
        blocks: blocksRef.current,
      });
    },
    [
      options.onExit,
      options.transcriptKeys,
      options.midTurn,
      options.sessionCreation,
      gate,
      includeHeldPaste,
      includeTranscriptPick,
      copyTranscriptPick,
      copyTranscriptIdentityPick,
      submitComposer,
      submitMidTurn,
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
      if (action.kind === "draft" && absorbDraftEcho.current && action.text !== "") {
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
    const unsubscribe = options.submission?.subscribePeer?.((notice) => {
      const identity =
        notice.reason === "arrival" ? notice.receipt.recipient : notice.receipt.sender;
      const action = JSON.stringify({ operation: "inspect", key: notice.key, as: identity });
      dispatch({
        kind: "notice",
        message: `Peer ${notice.reason}: ${notice.key}. Use /peer ${action} to retrieve the receipt.`,
      });
    });
    return () => {
      unsubscribe?.();
      const current = peerAction.current;
      peerAction.current = null;
      current?.abort();
    };
  }, [options.submission]);

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
    if (inFlight === null) {
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const selectedPayloads = new Map(
      inFlight.attachments.map((item) => [item.id, payloads.current.get(item.id)?.slice() ?? null]),
    );
    void Promise.resolve(
      port.submit(inFlight, {
        payloads: { get: (id) => selectedPayloads.get(id) ?? null },
        signal: controller.signal,
      }),
    ).then((outcome) => {
      if (!cancelled) {
        dispatch({ kind: "composer", action: { kind: "resolve", outcome } });
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [inFlight, port]);

  const midTurn = options.midTurn ?? null;
  useEffect(() => {
    dispatch({
      kind: "running-work",
      running: midTurn !== null && midTurn.view().active !== null,
    });
  }, [midTurn]);

  const { selectControl, selectCompression, selectProfile } = useShellControls({
    dispatch,
    modelSelection,
    briefControls,
    outputControls,
    submission: options.submission,
  });

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

  const sessionNavDraft = useCallback(
    (draft: string): void => {
      gate.note("input");
      dispatch({ kind: "session-nav-draft", draft });
    },
    [gate],
  );

  const sessionNavSession = useCallback((sessionId: string): void => {
    dispatch({ kind: "session-nav-session", sessionId });
  }, []);

  const sessionNavNotice = useCallback((message: string): void => {
    dispatch({ kind: "notice", message });
  }, []);

  const taskIntelligenceDraft = useCallback(
    (draft: string): void => {
      gate.note("input");
      dispatch({ kind: "task-intelligence-draft", draft });
    },
    [gate],
  );

  const taskIntelligenceNotice = useCallback((message: string): void => {
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
    compression,
    modelSettings:
      options.submission !== undefined && "modelSettings" in options.submission
        ? ((options.submission as import("../composer/product-submission.ts").ProductSubmissionPort)
            .modelSettings ?? null)
        : null,
    selectCompression,
    selectControl,
    selectProfile,
    settleChanges,
    workspaceDraft,
    replaceWorkspace,
    workspaceNotice,
    sessionNavDraft,
    sessionNavSession,
    sessionNavNotice,
    taskIntelligenceDraft,
    taskIntelligenceNotice,
    closeOverlay,
  };
}
