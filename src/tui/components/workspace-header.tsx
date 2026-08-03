/**
 * `WorkspaceHeader` — where you are, and what is working on it.
 *
 * Four facts, each of which can be in any of the seven conditions `FactValue`
 * declares. Today three of them are `unavailable` on every real run, and that is
 * not a placeholder: no producer of sessions, models, or Git state exists yet.
 * The header says so in words rather than showing a dash, because a dash beside
 * "branch" tells a user their repository has no branch.
 *
 * Density is the compact layout's whole problem here. Four labelled facts do not
 * fit in 40 columns, so compact drops the labels and keeps the values — the
 * labels are the redundant half when there is one line and the user already
 * knows which interface they are in.
 */

import type { ReactNode } from "react";
import { displayWidth, sanitizeTerminalText } from "../../domain/index.ts";
import { shareRow } from "../layout.ts";
import type { FactValue, WorkspaceHeaderModel } from "../view-model.ts";
import { statusOfFact } from "../view-model.ts";
import { useFrame, useLayoutClass } from "./context.tsx";
import { Line, StatusMark } from "./primitives.tsx";

export type WorkspaceHeaderProps = {
  readonly model: WorkspaceHeaderModel;
};

/**
 * The label each fact carries, the order they are read in, and how much of the
 * row each may claim.
 *
 * Weighted rather than divided evenly. An even quarter each is the obvious
 * division and the wrong one: a workspace path is the longest and most variable
 * of the four and the one a user most needs to recognize, while a session
 * identity is short and a branch name is usually shorter still. An even split
 * truncates the field that carries the most information in order to leave room
 * the others do not use.
 */
const FIELDS = [
  { key: "workspace", label: "workspace", weight: 2 },
  { key: "branch", label: "branch", weight: 1 },
  { key: "session", label: "session", weight: 1 },
  { key: "model", label: "model", weight: 1 },
] as const;

/** Cells the gap between two fields costs, so the shares add up to the row. */
const FIELD_GAP = 2;

/** Narrow enough to be useless, but a field is never given less than this. */
const MINIMUM_FIELD_COLUMNS = 4;

/** What a field would take if nothing were competing for the row. */
function naturalWidth(label: string, value: FactValue, showLabel: boolean): number {
  return (showLabel ? displayWidth(`${label} `) : 0) + displayWidth(renderedText(value));
}

/**
 * The characters a fact draws, whichever condition it is in.
 *
 * Sanitized for the two conditions that carry a value, because that is what
 * `Line` draws: escaping a control character expands one cell into four, and
 * measuring the raw text would hand the field a width its own rendering
 * immediately overflows.
 */
function renderedText(value: FactValue): string {
  if (value.kind === "known") {
    return sanitizeTerminalText(value.text);
  }
  if (value.kind === "partial") {
    return `${sanitizeTerminalText(value.text)} ${value.note}`;
  }
  // A symbol, a space, and the words. The symbol is one cell in every
  // repertoire except ASCII's truncation mark, which never appears here.
  return `xx${reasonFor(value)}`;
}

export function WorkspaceHeader(props: WorkspaceHeaderProps): ReactNode {
  const { theme, terminal } = useFrame();
  const layoutClass = useLayoutClass();
  const showLabels = layoutClass !== "compact";

  // The row, less what the gaps between the fields take. Shared so a field that
  // fits keeps what it needs and only the ones that do not compete for the rest.
  const room = Math.max(FIELDS.length, terminal.columns - FIELD_GAP * (FIELDS.length - 1));
  const widths = shareRow(
    FIELDS.map((field) => ({
      natural: naturalWidth(field.label, props.model[field.key], showLabels),
      weight: field.weight,
    })),
    room,
    MINIMUM_FIELD_COLUMNS,
  );

  return (
    <box flexDirection="row" gap={theme.spacing("regular")}>
      {FIELDS.map((field, index) => (
        <Fact
          key={field.key}
          label={field.label}
          value={props.model[field.key]}
          showLabel={showLabels}
          maxColumns={widths[index] ?? MINIMUM_FIELD_COLUMNS}
        />
      ))}
    </box>
  );
}

export type FactProps = {
  readonly label: string;
  readonly value: FactValue;
  readonly showLabel: boolean;
  readonly maxColumns: number;
};

/**
 * One labelled fact.
 *
 * A `known` value is text. Every other condition renders as a status mark, which
 * carries a symbol and a word — so "this is unavailable" survives the loss of
 * colour, and cannot be mistaken for a value that happens to read "unavailable".
 */
export function Fact(props: FactProps): ReactNode {
  const label = props.showLabel ? `${props.label} ` : "";
  const labelWidth = displayWidth(label);
  const room = Math.max(1, props.maxColumns - labelWidth);

  return (
    <box flexDirection="row">
      {props.showLabel ? (
        <Line color="mutedForeground" typography="label">
          {label}
        </Line>
      ) : null}
      <FactBody value={props.value} maxColumns={room} />
    </box>
  );
}

function FactBody(props: { readonly value: FactValue; readonly maxColumns: number }): ReactNode {
  const { value } = props;

  if (value.kind === "known") {
    // Untrusted: a workspace path, a branch name, and a model identifier all
    // come from outside Falryn, and any of them can contain an escape sequence.
    return (
      <Line color="foreground" maxColumns={props.maxColumns} untrusted>
        {value.text}
      </Line>
    );
  }

  if (value.kind === "partial") {
    return (
      <box flexDirection="row">
        <Line color="foreground" maxColumns={Math.max(1, props.maxColumns - 2)} untrusted>
          {value.text}
        </Line>
        <StatusMark status="warning" label={value.note} maxColumns={props.maxColumns} />
      </box>
    );
  }

  return (
    <StatusMark
      status={statusOfFact(value)}
      label={reasonFor(value)}
      maxColumns={props.maxColumns}
    />
  );
}

/**
 * The words a non-value condition shows.
 *
 * Each says what happened rather than restating the condition's name, because
 * "unavailable" beside "branch" is a category and "no Git yet" is an answer.
 */
function reasonFor(value: FactValue): string {
  switch (value.kind) {
    case "loading":
      return "reading";
    case "empty":
      return "none";
    case "error":
      return value.reason;
    case "cancelled":
      return "cancelled";
    case "unavailable":
      return value.reason;
    // `known` and `partial` are answered by the caller and never reach here.
    case "known":
    case "partial":
      return value.text;
  }
}
