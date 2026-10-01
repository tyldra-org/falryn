import { modelSettingsLines } from "../../application/providers/model-settings-format.ts";
import { useSessionOperation } from "./session-operation.ts";

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
  admitCommand,
  resolveCommandArgument,
  type SlashInvocation,
} from "../../domain/commands/index.ts";
import {
  detectMentionTrigger,
  withTokenPlaceholders,
} from "../../domain/context/composer-mentions.ts";
import {
  type AttachmentDescriptor,
  MAX_EVIDENCE_INLINE_BYTES,
  parseMentions,
} from "../../domain/context/index.ts";
import { completeSkillCommand, parseSkillsCommand } from "../../domain/context/skill-invocation.ts";
import { isExecutionProfileId } from "../../domain/sessions/index.ts";
import type { TranscriptBlock } from "../../presentation/index.ts";
import { providerModelIdentityKey } from "../../providers/index.ts";
import { type CommandState, commandById, type ShellCommand } from "../commands/commands.ts";
import {
  type ComposerAction,
  isBuiltinComposerSlash,
  parseComposerSlash,
  type SubmissionPort,
  UNAVAILABLE_SUBMISSION,
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
import { useShellPromptTemplates } from "./shell-runtime/prompt-templates.ts";
import { useShellQuestions } from "./shell-runtime/questions.ts";
import { useComposerSuggestions } from "./shell-runtime/suggestions.ts";
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

/**
 * Leaving with the keyboard takes two Ctrl+C presses within this window (#1184). Raw
 * mode delivers Ctrl+C as key input on every platform, so this one rule covers macOS,
 * Linux and Windows alike.
 */
export const EXIT_CONFIRMATION = Object.freeze({
  windowMs: 2_000,
  notice: "Press Ctrl+C again to exit.",
});

/**
 * The arming notice, naming what leaving would end (#790). `/quit` and Ctrl+C run
 * the same command, so both say what happens to a running turn, a waiting
 * confirmation, background work and an unsent draft before the second press.
 */
export function exitConfirmationNotice(pending: {
  readonly turn: boolean;
  readonly confirmation: boolean;
  readonly background: boolean;
  readonly draft: boolean;
}): string {
  const effects = [
    pending.turn ? "cancels the running turn" : null,
    pending.confirmation ? "declines the waiting confirmation" : null,
    pending.background && !pending.turn ? "stops waiting for running work" : null,
    pending.draft ? "discards the unsent draft" : null,
  ].filter((effect): effect is string => effect !== null);
  if (effects.length === 0) return EXIT_CONFIRMATION.notice;
  const listed =
    effects.length === 1 ? effects[0] : `${effects.slice(0, -1).join(", ")} and ${effects.at(-1)}`;
  return `${EXIT_CONFIRMATION.notice} Leaving ${listed}.`;
}

/** Invocations whose result arrives later; their slash text is cleared only on success. */
function settlesAsynchronously(invocation: SlashInvocation<ShellCommand>): boolean {
  return (
    invocation.argument !== null &&
    (invocation.entry.id === "mode.select" || invocation.entry.id === "workspace.load")
  );
}

/** Whether a planned command's name belongs to a skill or prompt template the user can run. */
function yieldsToSkillOrTemplate(
  parsed: ReturnType<typeof parseComposerSlash>,
  submission: ShellRuntimeOptions["submission"],
): boolean {
  if (parsed.kind !== "command" && parsed.kind !== "invalid") return false;
  if (parsed.entry?.status.kind !== "planned") return false;
  const catalog = submission?.skillCandidates?.() ?? null;
  const name = parsed.form.split(" ")[0]?.slice(1) ?? "";
  return catalog !== null && (catalog.invocable.has(name) || catalog.templates.has(name));
}

export function useShellRuntime(options: ShellRuntimeOptions): ShellRuntime {
  const peerAction = useRef<AbortController | null>(null);
  const localControlKind = useRef<"peer" | "schedule">("peer");
  /** Pending disarm of a keyboard exit awaiting its second press (#1184); null when unarmed. */
  const exitArmed = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The notice the armed exit showed, so disarming clears only that notice. */
  const exitNotice = useRef("");
  useEffect(
    () => () => {
      if (exitArmed.current !== null) clearTimeout(exitArmed.current);
    },
    [],
  );
  const [peerPending, setPeerPending] = useState(false);
  const [templatePending, setTemplatePending] = useState(false);
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
  const processingControl = useCallback(
    async (action: string | null, signal: AbortSignal) => {
      if (action === null || action === "inspect") {
        dispatch({ kind: "open-overlay", route: { kind: "model-settings", processing: true } });
        return { message: "Processing speed; inspection does not submit a request." };
      }
      const service =
        options.submission && "modelSettings" in options.submission
          ? (
              options.submission as import("../composer/product-submission.ts").ProductSubmissionPort
            ).modelSettings
          : null;
      if (!service) return { message: "Processing session host unavailable." };
      const binding = options.submission?.binding?.();
      const result = await service.execute(
        action === "reset"
          ? { kind: "processing-reset", scope: { kind: "session" } }
          : { kind: "processing-set", scope: { kind: "session" }, preference: { mode: action } },
        signal,
      );
      return {
        message:
          binding === options.submission?.binding?.()
            ? result.kind === "processing-changed"
              ? "Processing preference pending."
              : modelSettingsLines(result).join(" ")
            : "Processing change settled in the previous session.",
      };
    },
    [options.submission],
  );
  const { run: runProcessing, cancel: cancelProcessing } = useSessionOperation(
    processingControl,
    dispatch,
    "Processing speed",
  );
  const sessionExport = useSessionOperation(
    options.submission?.exportSession,
    dispatch,
    "Session export",
  );
  const profileControl = useCallback(
    async (argument: string | null, signal: AbortSignal) => {
      const control = options.submission?.workingProfile;
      if (!control) return { message: "Working profile controls are unavailable." };
      const binding = options.submission?.binding?.();
      const result = await control(argument, signal);
      if (options.submission?.binding?.() !== binding)
        return {
          message:
            "Profile action settled in the previous session; inspect that session's receipt.",
        };
      dispatch({
        kind: "open-overlay",
        route: { kind: "profile-result", text: JSON.stringify(result, null, 2) },
      });
      return { message: "Working profile result. Scroll to inspect; Escape closes." };
    },
    [options.submission],
  );
  const profile = useSessionOperation(profileControl, dispatch, "Working profile");
  const environmentControl = useCallback(
    async (argument: string | null, signal: AbortSignal) => {
      const action = argument?.trim() || "inspect";
      if (action !== "inspect" && action !== "reload")
        return { message: "Use /env inspect, /env reload, or /env cancel." };
      const control = options.submission?.environment;
      if (!control) return { message: "Environment controls are unavailable." };
      const binding = options.submission?.binding?.();
      const result = await control.execute(action, signal);
      if (binding !== options.submission?.binding?.())
        return { message: "Environment action settled in the previous session." };
      dispatch({
        kind: "open-overlay",
        route: {
          kind: "profile-result",
          title: "Scoped environment",
          text: JSON.stringify(result, null, 2),
        },
      });
      return { message: "Environment result. Scroll to inspect; Escape closes." };
    },
    [options.submission],
  );
  const environment = useSessionOperation(environmentControl, dispatch, "Environment");
  const cancelEnvironment = environment.cancel;
  const compact = useSessionOperation(options.submission?.compact, dispatch, "Compaction");
  const cancelProfile = profile.cancel;
  const cancelCompact = compact.cancel;
  const cancelSessionExport = sessionExport.cancel;
  const blocks = options.transcriptBlocks ?? NO_BLOCKS;
  const commandState = useMemo(
    () =>
      resolveCommandState(state, blocks, {
        workspaceController: options.workspaceController ?? null,
        sessionNavigationController: options.sessionNavigationController ?? null,
        sessionCreation: options.sessionCreation ?? null,
        peerPending:
          peerPending ||
          templatePending ||
          sessionExport.pending ||
          compact.pending ||
          profile.pending ||
          environment.pending,
      }),
    [
      state,
      blocks,
      options.workspaceController,
      options.sessionNavigationController,
      options.sessionCreation,
      peerPending,
      templatePending,
      sessionExport.pending,
      compact.pending,
      profile.pending,
      environment.pending,
    ],
  );
  const commandStateRef = useRef(commandState);
  commandStateRef.current = commandState;
  const geometry = useRef<TranscriptGeometry>(EMPTY_GEOMETRY);
  const gate = useRenderGate();
  const stateRef = useRef(state);
  stateRef.current = state;
  const questions = useShellQuestions({ dispatch, presenter: options.questions ?? null });
  const { leave: leaveQuestion, reopen: reopenQuestion } = questions;
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
  const replaceDraft = useCallback((text: string): void => {
    absorbDraftEcho.current = true;
    dispatch({ kind: "composer", action: { kind: "draft", text } });
    // Cleared after paint, so a stale textarea echo cannot restore the old draft.
    setTimeout(() => {
      absorbDraftEcho.current = false;
    }, 0);
  }, []);
  const readDraft = useCallback(() => stateRef.current.composer.text, []);
  const {
    answer: answerTemplate,
    expand: expandTemplate,
    cancel: cancelTemplate,
  } = useShellPromptTemplates({
    dispatch,
    expand: options.submission?.expandTemplate,
    draft: readDraft,
    replaceDraft,
    onPending: setTemplatePending,
  });
  const payloads = useRef(createMemoryAttachmentPayloads());
  useComposerSuggestions({
    dispatch,
    sources: options.submission?.mentionSources,
    open: state.composer.suggestions,
  });
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

  // The dispatcher is declared after the composer's submit, which it also runs; slash
  // text reaches it through this ref so both use the one path.
  const invokeRef = useRef<
    (invocation: SlashInvocation<ShellCommand>, settle?: () => void) => boolean
  >(() => false);

  const submitComposer = useCallback((): void => {
    const current = stateRef.current.composer;
    // While the suggestion list shows rows, Return picks one and never sends (#1206).
    if ((current.suggestions?.rows.length ?? 0) > 0) {
      // The textarea echoes this Return as a line break; that echo is not an edit.
      absorbDraftEcho.current = true;
      dispatch({ kind: "composer", action: { kind: "suggestion-accept" } });
      setTimeout(() => {
        absorbDraftEcho.current = false;
      }, 0);
      return;
    }
    // A value being asked for by a prompt template is taken before any other reading.
    if (answerTemplate(current.text)) return;
    // Built-in commands win (#790): one registry parse, then the one dispatcher the
    // palette and keys use. A refused command keeps the draft so it can be fixed.
    const slash = parseComposerSlash(current.text);
    // A planned command never hides a skill or prompt template of the same name; it
    // yields to them and is refused only when nothing else answers.
    const yields = yieldsToSkillOrTemplate(slash, options.submission);
    if (slash.kind === "invalid" && !yields) {
      dispatch({ kind: "notice", message: slash.message });
      return;
    }
    if (slash.kind === "command" && !yields) {
      // Clear the command text once it has done its work, and only if the user has
      // not typed something else meanwhile. Asynchronous actions settle on success.
      const settle = (): void => {
        if (stateRef.current.composer.text === current.text) replaceDraft("");
      };
      if (invokeRef.current(slash, settle) && !settlesAsynchronously(slash)) settle();
      return;
    }

    // A skill command is sent as a turn with the skill loaded; a name that is both a
    // skill and a template must be qualified, and the draft stays for editing.
    const skill = options.submission?.skillCommand?.(current.text) ?? null;
    if (skill?.kind === "ambiguous") {
      dispatch({
        kind: "notice",
        message: `A skill and a prompt template are both named ${skill.name}. Use /skill:${skill.name} for the skill or the template's /<package>:${skill.name}.`,
      });
      return;
    }
    // Package prompt templates expand into the draft for review; nothing is sent.
    if (skill === null && expandTemplate(current.text)) return;

    const midTurn = options.midTurn ?? null;
    if (midTurn !== null && midTurn.view().active !== null) {
      // A queued follow-up does not carry mentions yet (#954); sending it without
      // them would silently drop the user's picks.
      if (current.tokens.length > 0) {
        dispatch({
          kind: "notice",
          message:
            "Mentions cannot be queued while a turn is running yet (#954). Send this prompt after the current turn finishes.",
        });
        return;
      }
      // Documented default while a turn is active: queue a follow-up.
      submitMidTurn("follow-up");
      return;
    }

    const binding = options.submission?.binding?.();
    void (async () => {
      const resolved = await resolveComposerAttachments(
        current.attachments,
        parseMentions(current.text),
        fileProbe,
      );
      dispatch({
        kind: "composer",
        action: {
          kind: "submit",
          attachments: resolved,
          ...(binding === undefined ? {} : { binding }),
        },
      });
    })();
  }, [
    fileProbe,
    options.midTurn,
    options.submission,
    replaceDraft,
    submitMidTurn,
    answerTemplate,
    expandTemplate,
  ]);

  /** One bounded JSON action at a time for `/schedule` and `/peer`; Escape abandons the wait. */
  const runJsonAction = useCallback(
    (kind: "schedule" | "peer", argument: string | null): boolean => {
      const port = kind === "schedule" ? options.submission?.schedule : options.submission?.peer;
      const label = kind === "schedule" ? "Schedule" : "Peer";
      if (!port) {
        dispatch({
          kind: "notice",
          message:
            kind === "schedule"
              ? "Schedule controls are unavailable for this session."
              : "Peer messaging is unavailable for this session.",
        });
        return false;
      }
      const fallback = kind === "schedule" ? '{"operation":"list"}' : '{"operation":"endpoint"}';
      let action: unknown;
      try {
        action = JSON.parse(argument ?? fallback);
      } catch {
        dispatch({
          kind: "notice",
          message:
            kind === "schedule"
              ? 'Use /schedule followed by a bounded JSON action, for example {"operation":"list"}.'
              : 'Use /peer followed by a bounded JSON action, for example {"operation":"discover"}.',
        });
        return false;
      }
      peerAction.current?.abort();
      const controller = new AbortController();
      peerAction.current = controller;
      setPeerPending(true);
      localControlKind.current = kind;
      dispatch({ kind: "close-overlay" });
      void port(action, controller.signal)
        .then(
          (result) => {
            if (controller.signal.aborted) return;
            const text = JSON.stringify(result);
            dispatch({
              kind: "notice",
              message:
                encoder.encode(text).byteLength <= 262_144
                  ? text
                  : `${label} result exceeds 256 KiB. Request a smaller history page or inspect one receipt.`,
            });
          },
          () => {
            if (!controller.signal.aborted)
              dispatch({ kind: "notice", message: `${label} action unavailable.` });
          },
        )
        .finally(() => {
          if (peerAction.current === controller) {
            peerAction.current = null;
            setPeerPending(false);
          }
        });
      return true;
    },
    [options.submission?.schedule, options.submission?.peer],
  );

  /** `/skills [filter] [after N]` lists the catalog; it never reads a skill body or sends anything. */
  const listSkills = useCallback(
    (argument: string | null): boolean => {
      const page = parseSkillsCommand(argument === null ? "/skills" : `/skills ${argument}`) ?? {
        filter: null,
        offset: 0,
      };
      const list = options.submission?.listSkills;
      dispatch({ kind: "close-overlay" });
      if (!list) {
        dispatch({ kind: "notice", message: "Skills are unavailable in this session." });
        return false;
      }
      void list(page, new AbortController().signal).then(
        (lines) => dispatch({ kind: "notice", message: lines.join("\n") }),
        () => dispatch({ kind: "notice", message: "The skill catalog is unavailable." }),
      );
      return true;
    },
    [options.submission?.listSkills],
  );

  /** Bare reports the current Brief mode; a mode sets it for upcoming turns. */
  const setBrief = useCallback(
    (argument: string | null): boolean => {
      const brief = briefControls;
      if (brief === null) {
        dispatch({ kind: "notice", message: "Brief controls are not attached to this shell." });
        return false;
      }
      dispatch({ kind: "close-overlay" });
      if (argument === null) {
        dispatch({
          kind: "notice",
          message: `Brief is ${brief.getFrontendMode()} (use /brief compact|balanced|detailed|auto|on|off).`,
        });
        return true;
      }
      const set = brief.setFrontendMode(argument);
      if (!set.ok) {
        dispatch({
          kind: "notice",
          message: `Unsupported Brief mode “${argument}”. Use compact|balanced|detailed|auto|on|off.`,
        });
        return false;
      }
      dispatch({ kind: "notice", message: `Brief set to ${brief.getFrontendMode()}.` });
      return true;
    },
    [briefControls],
  );

  /** Bare reports Hush or Loom; `on|off` sets it for upcoming tool calls. */
  const setOutputEngine = useCallback(
    (engine: "Hush" | "Loom", argument: string | null): boolean => {
      const output = outputControls;
      if (output === null) {
        dispatch({
          kind: "notice",
          message: `${engine} controls are not attached to this shell.`,
        });
        return false;
      }
      dispatch({ kind: "close-overlay" });
      const current = engine === "Hush" ? output.getHushState() : output.getLoomState();
      if (argument === null) {
        dispatch({
          kind: "notice",
          message: `${engine} is ${current} (use /${engine.toLowerCase()} on|off).`,
        });
        return true;
      }
      const set = engine === "Hush" ? output.setHushState(argument) : output.setLoomState(argument);
      if (!set.ok) {
        dispatch({
          kind: "notice",
          message: `Unsupported ${engine} state “${argument}”. Use on|off.`,
        });
        return false;
      }
      dispatch({ kind: "notice", message: `${engine} set to ${set.value}.` });
      return true;
    },
    [outputControls],
  );

  /** Bare opens the mode picker; a mode changes it for the next turn. */
  const selectMode = useCallback(
    (argument: string | null, settle?: () => void): boolean => {
      if (argument === null) {
        // Bare opens the picker from slash text and palette alike; the status line
        // already names the current mode.
        dispatch({ kind: "open-overlay", route: { kind: "controls", panel: "profile" } });
        return true;
      }
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
        return false;
      }
      dispatch({ kind: "close-overlay" });
      if (!isExecutionProfileId(argument)) {
        dispatch({
          kind: "notice",
          message: `Unsupported execution mode “${argument}”. Use ask|plan|debug|agent.`,
        });
        return false;
      }
      void (async () => {
        const selected = await executionProfile.select(argument);
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
        settle?.();
      })();
      return true;
    },
    [options.submission],
  );

  /** Load a named layout; the panel is the bare form. */
  const loadWorkspace = useCallback(
    (layoutName: string, settle?: () => void): boolean => {
      const controller = options.workspaceController ?? null;
      if (controller === null) {
        dispatch({
          kind: "notice",
          message: "Load workspace layout is unavailable: no workspace set yet.",
        });
        return false;
      }
      dispatch({ kind: "close-overlay" });
      void (async () => {
        const result = await controller.load(layoutName);
        if (!result.ok) {
          dispatch({ kind: "notice", message: describeWorkspaceControllerError(result.error) });
          return;
        }
        dispatch({ kind: "workspace-set", workspace: result.value });
        dispatch({ kind: "notice", message: `Loaded layout “${layoutName.trim()}”.` });
        settle?.();
      })();
      return true;
    },
    [options.workspaceController],
  );

  /**
   * The one command dispatcher (#790). Slash text, the palette and keys all arrive
   * here with a resolved invocation, so admission, availability, timing and the
   * action itself cannot differ between them.
   */
  const runInvocation = useCallback(
    (invocation: SlashInvocation<ShellCommand>, settle?: () => void): boolean => {
      gate.note("input");
      const command = invocation.entry;
      const id = command.id;
      const argument = invocation.argument;
      const activeTurn = options.midTurn?.view().active ?? null;
      const admission = admitCommand(command, {
        caller: "interactive",
        timing: invocation.timing,
        turnActive: activeTurn !== null || commandStateRef.current.hasInFlightSubmission,
      });
      if (!admission.ok) {
        dispatch({ kind: "notice", message: admission.message });
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

      if (id.startsWith("model.processing."))
        return runProcessing(id.slice("model.processing.".length));
      switch (id) {
        case "schedule.controls":
        case "peer.action":
          return runJsonAction(id === "schedule.controls" ? "schedule" : "peer", argument);
        case "skills.list":
          return listSkills(argument);
        case "brief.set":
          return setBrief(argument);
        case "hush.set":
        case "loom.set":
          return setOutputEngine(id === "hush.set" ? "Hush" : "Loom", argument);
        case "mode.select":
          return selectMode(argument, settle);
        case "workspace.load":
          if (argument !== null) return loadWorkspace(argument, settle);
          break;
        case "workspace.addRoot":
        case "workspace.save":
          // An argument prefills the panel; adding or saving still happens there.
          if (argument !== null) {
            dispatch({
              kind: "open-overlay",
              route: workspaceOverlayRoute(id === "workspace.addRoot" ? "add" : "save", argument),
            });
            return true;
          }
          break;
        case "composer.suggestions.reopen": {
          const composer = stateRef.current.composer;
          if (
            detectMentionTrigger(
              composer.text,
              composer.cursor,
              composer.mentionTriggers,
              composer.tokens,
            ) !== null
          ) {
            dispatch({ kind: "composer", action: { kind: "suggestion-reopen" } });
            return true;
          }
          const catalog = options.submission?.skillCandidates?.() ?? null;
          const draft = stateRef.current.composer.text;
          const completion =
            catalog === null ? null : completeSkillCommand(draft, catalog, isBuiltinComposerSlash);
          if (completion === null) return false;
          if (completion.text !== draft)
            dispatch({ kind: "composer", action: { kind: "draft", text: completion.text } });
          if (completion.matches.length > 1)
            dispatch({
              kind: "notice",
              message: `Skills: ${completion.matches.slice(0, 20).join(", ")}${completion.matches.length > 20 ? `, and ${completion.matches.length - 20} more (/skills lists them)` : ""}`,
            });
          return true;
        }
        case "composer.suggestions.accept":
          dispatch({ kind: "composer", action: { kind: "suggestion-accept" } });
          return true;
        case "composer.suggestions.next":
          dispatch({ kind: "composer", action: { kind: "suggestion-move", delta: 1 } });
          return true;
        case "composer.suggestions.previous":
          dispatch({ kind: "composer", action: { kind: "suggestion-move", delta: -1 } });
          return true;
        case "composer.suggestions.dismiss":
          dispatch({ kind: "composer", action: { kind: "suggestion-dismiss" } });
          return true;
        case "environment.inspect":
          return argument === "cancel" ? cancelEnvironment() : environment.run(argument);
        case "profile.inspect":
          return argument === "cancel" ? cancelProfile() : profile.run(argument);
        case "session.export":
          return sessionExport.run(argument);
        case "compact.preview":
          return compact.run(argument);
        case "compact.apply":
          return compact.run("apply");
        case "confirmation.accept":
          return confirm("accept");
        case "confirmation.deny":
          return confirm("deny");
        case "app.exit":
          // One stray Ctrl+C must not end the session: the first press arms and a second
          // within the window leaves (#1184). An external SIGINT is a separate path.
          if (exitArmed.current === null) {
            const state = commandStateRef.current;
            const draft = stateRef.current.composer.text;
            const draftResolved = parseComposerSlash(draft);
            const notice = exitConfirmationNotice({
              turn: activeTurn !== null || state.hasInFlightSubmission,
              confirmation: state.hasConfirmation,
              background: state.hasRunningWork,
              // The `/quit` being run is not a draft worth warning about.
              draft:
                draft.trim() !== "" &&
                !(draftResolved.kind === "command" && draftResolved.entry.id === "app.exit"),
            });
            exitNotice.current = notice;
            dispatch({ kind: "notice", message: notice });
            exitArmed.current = setTimeout(() => {
              exitArmed.current = null;
              if (stateRef.current.notice === exitNotice.current)
                dispatch({ kind: "notice", message: "" });
            }, EXIT_CONFIRMATION.windowMs);
            return true;
          }
          clearTimeout(exitArmed.current);
          exitArmed.current = null;
          break;
        case "overlay.close":
          if (stateRef.current.overlay.kind === "confirm") {
            return confirm("deny");
          }
          if (stateRef.current.overlay.kind === "question") {
            leaveQuestion();
            return true;
          }
          dispatch({ kind: "close-overlay" });
          return true;
        case "questions.reopen":
          // Close the palette or help that ran it so the reopened question can take the sheet.
          dispatch({ kind: "close-overlay" });
          return reopenQuestion();
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
            // Mentions travel as opaque placeholders; the reducer rebinds them (#1206).
            text: withTokenPlaceholders(current.text, current.tokens),
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
          if (cancelTemplate()) return true;
          if (cancelProcessing()) return true;
          if (cancelSessionExport()) return true;
          if (cancelCompact()) return true;
          if (cancelProfile()) return true;
          if (cancelEnvironment()) return true;
          if (peerAction.current) {
            peerAction.current.abort();
            peerAction.current = null;
            setPeerPending(false);
            dispatch({
              kind: "notice",
              message:
                localControlKind.current === "peer"
                  ? "Local peer wait cancelled. Remote work continues independently."
                  : "Local schedule wait cancelled. Use exact run cancellation to stop admitted work.",
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
      runProcessing,
      cancelProcessing,
      cancelTemplate,
      sessionExport.run,
      environment.run,
      compact.run,
      profile.run,
      cancelProfile,
      cancelEnvironment,
      cancelCompact,
      cancelSessionExport,
      options.onExit,
      options.submission?.skillCandidates,
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
      leaveQuestion,
      reopenQuestion,
      runJsonAction,
      listSkills,
      setBrief,
      setOutputEngine,
      selectMode,
      loadWorkspace,
    ],
  );
  invokeRef.current = runInvocation;

  /** Palette and key entry: the bare invocation of a command, through the same dispatcher. */
  const run = useCallback(
    (id: string): boolean => {
      const command = commandById(id);
      if (command === undefined) {
        gate.note("input");
        dispatch({ kind: "notice", message: `No command named ${id}.` });
        return false;
      }
      const invocation = resolveCommandArgument(command, null);
      if (invocation.kind === "invalid") {
        gate.note("input");
        dispatch({ kind: "notice", message: invocation.message });
        return false;
      }
      return runInvocation(invocation);
    },
    [gate, runInvocation],
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

  // A picker's change is a safe-point invocation of its command (#790).
  const admitPickerChange = useCallback(
    (commandId: string): boolean => {
      const entry = commandById(commandId);
      if (entry === undefined) return true;
      const admission = admitCommand(entry, {
        caller: "interactive",
        timing: "safe-point",
        turnActive:
          (options.midTurn?.view().active ?? null) !== null ||
          commandStateRef.current.hasInFlightSubmission,
      });
      if (admission.ok) return true;
      dispatch({ kind: "close-overlay" });
      dispatch({ kind: "notice", message: admission.message });
      return false;
    },
    [options.midTurn],
  );

  const { selectControl, selectCompression, selectProfile } = useShellControls({
    dispatch,
    modelSelection,
    briefControls,
    outputControls,
    submission: options.submission,
    admitChange: admitPickerChange,
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
    questions,
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
