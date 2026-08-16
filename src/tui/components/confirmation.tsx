/**
 * Confirmation sheet — exact intent, labelled choices, optional secret field.
 *
 * A view over a confirmation prompt. It does not execute tools, write
 * credentials, or occupy the wide layout's activity rail. Installed OpenTUI
 * Input has no password echo, so the secret field captures keys here and draws
 * a mask; the value never appears as a Line child.
 *
 * Labelled keys are bound on this sheet rather than in the command registry:
 * a reusable `y` that accepts anything is how someone confirms an action they
 * had not read.
 */

import type { KeyEvent, PasteEvent } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import { type ReactNode, useCallback } from "react";
import {
  type ConfirmationChoiceId,
  type ConfirmationView,
  maskSecret,
  type SecretEdit,
} from "../confirmation/index.ts";
import { classifyPaste } from "../paste.ts";
import { useFrame, useTheme } from "./context.tsx";
import { Line } from "./primitives.tsx";

const PANEL_CHROME_COLUMNS = 4;

export type ConfirmationSheetProps = {
  readonly confirmation: ConfirmationView | null;
  readonly rows: number;
  readonly onChoice?: (id: ConfirmationChoiceId) => void;
  readonly onSecretEdit?: (edit: SecretEdit) => void;
};

export function ConfirmationSheet(props: ConfirmationSheetProps): ReactNode {
  const { terminal } = useFrame();
  const theme = useTheme();
  const columns = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);
  const capturingSecret =
    props.confirmation !== null &&
    props.confirmation.prompt.secret !== null &&
    !props.confirmation.stale;

  const onChoice = props.onChoice;
  const onSecretEdit = props.onSecretEdit;

  const onKey = useCallback(
    (key: KeyEvent): void => {
      const view = props.confirmation;
      if (view === null || onChoice === undefined) {
        return;
      }
      if (capturingSecret && onSecretEdit !== undefined) {
        if (key.name === "return") {
          key.preventDefault();
          onChoice("accept");
          return;
        }
        if (key.name === "backspace" || key.name === "delete") {
          key.preventDefault();
          onSecretEdit({ kind: "delete" });
          return;
        }
        if (isCapturedText(key)) {
          key.preventDefault();
          onSecretEdit({ kind: "insert", text: key.sequence });
        }
        return;
      }
      if (view.prompt.secret !== null) {
        return;
      }
      if (key.name === "y" && !key.ctrl && !key.meta) {
        key.preventDefault();
        onChoice("accept");
        return;
      }
      if (key.name === "n" && !key.ctrl && !key.meta) {
        key.preventDefault();
        onChoice("deny");
      }
    },
    [capturingSecret, onChoice, onSecretEdit, props.confirmation],
  );

  useKeyboard(onKey);

  usePaste(
    useCallback(
      (event: PasteEvent): void => {
        if (!capturingSecret || onSecretEdit === undefined) {
          return;
        }
        event.preventDefault();
        const text = new TextDecoder().decode(event.bytes);
        if (classifyPaste(text).verdict !== "inline") {
          return;
        }
        onSecretEdit({ kind: "insert", text });
      },
      [capturingSecret, onSecretEdit],
    ),
  );

  if (props.rows < 1) {
    return null;
  }

  if (props.confirmation === null) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={columns}>
        This confirmation is gone.
      </Line>
    );
  }

  const entries = sheetLines(props.confirmation, theme.marks.bullet);
  const needsNotice = entries.length > props.rows;
  const budget = needsNotice && props.rows >= 2 ? props.rows - 1 : Math.max(0, props.rows);
  const visible = entries.slice(0, budget);
  const hidden = entries.length - visible.length;

  return (
    <box flexDirection="column">
      {visible.map((line) => (
        <Line
          key={line.key}
          color={line.color}
          typography={line.typography}
          maxColumns={columns}
          untrusted={line.untrusted}
        >
          {line.text}
        </Line>
      ))}
      {hidden > 0 && visible.length > 0 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={columns}>
          {`${hidden} more ${hidden === 1 ? "line" : "lines"} not shown`}
        </Line>
      ) : null}
    </box>
  );
}

type SheetLine = {
  readonly key: string;
  readonly text: string;
  readonly color: "foreground" | "mutedForeground" | "warning";
  readonly typography: "body" | "muted";
  readonly untrusted: boolean;
};

function sheetLines(view: ConfirmationView, maskChar: string): readonly SheetLine[] {
  const { prompt } = view;
  const lines: SheetLine[] = [
    {
      key: "expiry",
      text: view.stale
        ? "This confirmation is no longer valid."
        : "This confirmation expires if the target or input changes.",
      color: view.stale ? "warning" : "mutedForeground",
      typography: view.stale ? "body" : "muted",
      untrusted: false,
    },
    fact("operation", prompt.operation, false),
    fact("target", prompt.target, true),
    fact("why", prompt.reason, false),
    fact("effect", prompt.effect, false),
    fact("scope", "This decision applies once.", false),
  ];
  for (const [index, alternative] of prompt.alternatives.entries()) {
    lines.push(fact(`alternative-${index}`, alternative, false));
  }
  if (prompt.secret !== null) {
    const mask = maskSecret(view.secretGraphemes, maskChar);
    lines.push(fact("secret", prompt.secret.label, false));
    lines.push({
      key: "mask",
      text: mask === "" ? "(empty)" : mask,
      color: "foreground",
      typography: "body",
      untrusted: false,
    });
  }
  for (const choice of view.choices) {
    lines.push({
      key: `choice-${choice.id}`,
      text: `${displayChoiceKey(choice.key)}  ${choice.label}`,
      color: "foreground",
      typography: "body",
      untrusted: false,
    });
  }
  return lines;
}

function fact(key: string, text: string, untrusted: boolean): SheetLine {
  return {
    key,
    text,
    color: untrusted ? "foreground" : "mutedForeground",
    typography: untrusted ? "body" : "muted",
    untrusted,
  };
}

function displayChoiceKey(key: string): string {
  switch (key) {
    case "return":
      return "return";
    case "escape":
      return "esc";
    default:
      return key;
  }
}

function isCapturedText(key: KeyEvent): boolean {
  if (key.ctrl || key.meta || key.super === true) {
    return false;
  }
  switch (key.name) {
    case "return":
    case "escape":
    case "tab":
    case "backspace":
    case "delete":
    case "up":
    case "down":
    case "left":
    case "right":
      return false;
    default:
      return key.sequence.length > 0;
  }
}
