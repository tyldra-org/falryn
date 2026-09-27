/**
 * Structured question sheet (#1163).
 *
 * A view over the question the local presenter is showing. Keys become draft
 * actions; the shell runtime owns the draft and settles finished answers through
 * the presenter. Question text is untrusted producer data: it is sanitized for
 * the terminal and never logged. Escape is the shell's overlay close, which
 * leaves the question waiting rather than answering it.
 */

import type { KeyEvent, PasteEvent } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { type ReactNode, useCallback } from "react";
import { classifyPaste } from "../composer/paste.ts";
import type { DraftAction, ItemDraft, PresentedQuestion } from "../questions/index.ts";
import { textBytes } from "../questions/index.ts";
import { useFrame } from "../shell/context.tsx";
import type { QuestionSheetState } from "../shell/shell-runtime/questions.ts";
import { Line } from "../visual/primitives.tsx";

const PANEL_CHROME_COLUMNS = 4;

export type QuestionSheetProps = {
  readonly sheet: QuestionSheetState | null;
  readonly rows: number;
  /** Milliseconds since the epoch; the sheet uses it only to show time left. */
  readonly now: () => number;
  readonly onEdit?: (action: DraftAction) => void;
  readonly onRefuse?: () => void;
};

type SheetLine = {
  readonly key: string;
  readonly text: string;
  readonly color: "foreground" | "mutedForeground" | "warning" | "accent";
  readonly untrusted: boolean;
};

/** Map one key to what it means for the draft, or null when the sheet ignores it. */
export function questionKeyAction(key: KeyEvent): DraftAction | "refuse" | null {
  if (key.ctrl && key.name === "r") return "refuse";
  if (key.ctrl && key.name === "b") return { kind: "back" };
  if (key.ctrl || key.meta || key.super === true) return null;
  switch (key.name) {
    case "up":
      return { kind: "move", delta: -1 };
    case "down":
      return { kind: "move", delta: 1 };
    case "space":
      return { kind: "toggle" };
    case "return":
      return { kind: "commit" };
    case "backspace":
    case "delete":
      return { kind: "delete" };
    case "escape":
    case "tab":
    case "left":
    case "right":
      return null;
    default:
      return key.sequence.length > 0 ? { kind: "insert", text: key.sequence } : null;
  }
}

export function QuestionSheet(props: QuestionSheetProps): ReactNode {
  const { terminal } = useFrame();
  const columns = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);
  const { onEdit, onRefuse, sheet } = props;
  const item = sheet?.question.items[sheet.draft.index];
  const typingText = item?.kind === "free-text";

  useKeyboard(
    useCallback(
      (key: KeyEvent): void => {
        if (sheet === null || onEdit === undefined) return;
        const action = questionKeyAction(key);
        if (action === null) return;
        // A space is text in a free-text item and a toggle everywhere else.
        const resolved =
          action !== "refuse" && action.kind === "toggle" && typingText
            ? ({ kind: "insert", text: " " } as const)
            : action;
        if (resolved !== "refuse" && resolved.kind === "insert" && !typingText) return;
        key.preventDefault();
        if (resolved === "refuse") onRefuse?.();
        else onEdit(resolved);
      },
      [sheet, onEdit, onRefuse, typingText],
    ),
  );

  usePaste(
    useCallback(
      (event: PasteEvent): void => {
        if (!typingText || onEdit === undefined) return;
        event.preventDefault();
        const text = new TextDecoder().decode(event.bytes);
        // Held or oversized pastes are refused whole by the draft's byte limit or here.
        if (classifyPaste(text).verdict !== "inline") return;
        onEdit({ kind: "insert", text });
      },
      [typingText, onEdit],
    ),
  );

  if (props.rows < 1) return null;
  if (sheet === null) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={columns}>
        This question is no longer waiting.
      </Line>
    );
  }

  const { head, body, foot } = questionLines(sheet, props.now());
  // Header and footer stay; the body is windowed around the cursor when rows are short.
  const budget = Math.max(0, props.rows - head.length - foot.length);
  const cursor = body.findIndex((line) => line.key.startsWith("cursor-"));
  const start = Math.max(0, Math.min(Math.max(0, cursor - budget + 1), body.length - budget));
  const visible = [...head, ...body.slice(start, start + budget), ...foot].slice(0, props.rows);
  return (
    <box flexDirection="column">
      {visible.map((line) => (
        <Line
          key={line.key}
          color={line.color}
          typography={line.color === "mutedForeground" ? "muted" : "body"}
          maxColumns={columns}
          untrusted={line.untrusted}
        >
          {line.text}
        </Line>
      ))}
    </box>
  );
}

function remaining(expiresAt: number, now: number): string {
  const minutes = Math.ceil(Math.max(0, expiresAt - now) / 60_000);
  return minutes <= 1 ? "expires within a minute" : `expires in ${minutes} minutes`;
}

export function questionLines(
  sheet: QuestionSheetState,
  now: number,
): { readonly head: SheetLine[]; readonly body: SheetLine[]; readonly foot: SheetLine[] } {
  const { question, draft } = sheet;
  const item = question.items[draft.index];
  const current = draft.items[draft.index];
  const position =
    question.items.length > 1 ? `Part ${draft.index + 1} of ${question.items.length} · ` : "";
  const waiting = sheet.queued > 0 ? ` · ${sheet.queued} more waiting` : "";
  const head: SheetLine[] = [
    { key: "source", text: `From ${question.source}`, color: "mutedForeground", untrusted: true },
    {
      key: "status",
      text: `${position}${remaining(question.expiresAt, now)}${waiting}`,
      color: "mutedForeground",
      untrusted: false,
    },
  ];
  const foot: SheetLine[] = [];
  if (question.sensitivity === "protected") {
    return {
      head,
      body: [
        {
          key: "protected",
          text: "This question asks for protected input, which this terminal cannot collect.",
          color: "warning",
          untrusted: false,
        },
      ],
      foot: [hint("ctrl+r refuse")],
    };
  }
  const body: SheetLine[] = item
    ? [
        { key: "prompt", text: item.prompt, color: "foreground", untrusted: true },
        ...itemLines(item, current),
      ]
    : [];
  if (draft.problem !== null)
    foot.push({ key: "problem", text: draft.problem, color: "warning", untrusted: false });
  if (sheet.settling)
    foot.push({ key: "settling", text: "Sending…", color: "mutedForeground", untrusted: false });
  foot.push(hint(hintFor(item, draft.index)));
  return { head, body, foot };
}

function itemLines(
  item: PresentedQuestion["items"][number],
  draft: ItemDraft | undefined,
): SheetLine[] {
  if (item.kind === "review")
    return [
      { key: "review", text: "Review the text above.", color: "mutedForeground", untrusted: false },
    ];
  if (item.kind === "free-text") {
    const text = draft?.kind === "text" ? draft.text : "";
    return [
      { key: "cursor-text", text: `› ${text}▏`, color: "foreground", untrusted: true },
      {
        key: "bytes",
        text: `${textBytes(text)} of ${item.maxBytes} bytes`,
        color: "mutedForeground",
        untrusted: false,
      },
    ];
  }
  const chosen = draft?.kind === "choice" ? draft.chosen : [];
  const cursor = draft?.kind === "choice" ? draft.cursor : 0;
  const lines: SheetLine[] = item.options.map((option, index) => {
    const selected = chosen.includes(option.id);
    const mark =
      item.kind === "single-select" ? (selected ? "(•)" : "( )") : selected ? "[x]" : "[ ]";
    return {
      key: index === cursor ? `cursor-${option.id}` : `option-${option.id}`,
      text: `${index === cursor ? "›" : " "} ${mark} ${option.label}`,
      color: index === cursor ? "accent" : "foreground",
      untrusted: true,
    };
  });
  if (item.kind === "multi-select")
    lines.push({
      key: "bounds",
      text: `Choose ${item.minimum === item.maximum ? item.minimum : `${item.minimum}–${item.maximum}`}; ${chosen.length} chosen`,
      color: "mutedForeground",
      untrusted: false,
    });
  return lines;
}

function hintFor(item: PresentedQuestion["items"][number] | undefined, index: number): string {
  const back = index > 0 ? " · ctrl+b back" : "";
  const tail = `${back} · ctrl+r refuse`;
  switch (item?.kind) {
    case "single-select":
      return `↑/↓ move · return choose${tail}`;
    case "multi-select":
      return `↑/↓ move · space toggle · return continue${tail}`;
    case "free-text":
      return `type your answer · return continue${tail}`;
    default:
      return `return acknowledge${tail}`;
  }
}

function hint(text: string): SheetLine {
  return { key: "hint", text, color: "mutedForeground", untrusted: false };
}
