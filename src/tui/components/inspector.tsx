/**
 * Inspection of a tool, process, reasoning, or error block.
 *
 * A view over facts the block already carries. It does not scroll a second
 * transcript, fetch a canonical source, or occupy the wide layout's activity
 * rail — that panel is already spent. Rows beyond the overlay host's budget are
 * counted, not drawn over the panel.
 */

import type { ReactNode } from "react";
import type { TerminalOutcome } from "../../domain/index.ts";
import type { StatusToken } from "../theme/index.ts";
import { type BlockInspection, sliceInspection } from "../transcript/index.ts";
import { useFrame } from "./context.tsx";
import { Line, StatusMark } from "./primitives.tsx";

/** Cells the overlay panel's border and padding take from its content. */
const PANEL_CHROME_COLUMNS = 4;

export type InspectorProps = {
  readonly inspection: BlockInspection | null;
  /** Rows the host measured. Content beyond them is reported, never drawn over. */
  readonly rows: number;
};

export function Inspector(props: InspectorProps): ReactNode {
  const { terminal } = useFrame();
  const columns = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  if (props.rows < 1) {
    return null;
  }

  if (props.inspection === null) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={columns}>
        This entry is gone.
      </Line>
    );
  }

  const sliced = sliceInspection(props.inspection, props.rows);
  const status = statusOfOutcome(props.inspection.outcome);

  return (
    <box flexDirection="column">
      {sliced.showSummary ? (
        <StatusMark status={status} label={props.inspection.summary} maxColumns={columns} />
      ) : null}
      {sliced.facts.map((fact) => (
        <Line
          key={`${fact.label}:${fact.value}`}
          color={fact.untrusted ? "foreground" : "mutedForeground"}
          typography={fact.untrusted ? "body" : "muted"}
          maxColumns={columns}
          untrusted={fact.untrusted}
        >
          {`${fact.label}  ${fact.value}`}
        </Line>
      ))}
      {sliced.hidden > 0 && sliced.facts.length > 0 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={columns}>
          {`${sliced.hidden} more ${sliced.hidden === 1 ? "fact" : "facts"} not shown`}
        </Line>
      ) : null}
    </box>
  );
}

function statusOfOutcome(outcome: TerminalOutcome | null): StatusToken {
  if (outcome === null) {
    return "informational";
  }
  switch (outcome.kind) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    case "timed-out":
      return "warning";
    case "uncertain":
      return "uncertain";
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
