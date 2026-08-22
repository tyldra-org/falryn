/**
 * Session, model, context, and resource controls.
 *
 * Session and model panels pick from the application port's lists. Context and
 * resource panels list labelled facts. Neither writes a session nor calls a
 * provider. Rows beyond the overlay host's budget are counted, not drawn over.
 */

import type { SelectOption, SelectRenderable } from "@opentui/core";
import { type ReactNode, useMemo, useRef } from "react";
import { displayWidth } from "../../domain/index.ts";
import {
  type ControlCatalog,
  type ControlFact,
  type ControlPanel,
  emptyReason,
  factsFor,
  optionsFor,
  sliceControlFacts,
} from "../controls/index.ts";
import { type FactValue, statusOfFact } from "../view-model.ts";
import { useFrame } from "./context.tsx";
import { Line, StatusMark } from "./primitives.tsx";
import { useSelectNavigation } from "./select-navigation.ts";

/** Cells the overlay panel's border and padding take from its content. */
const PANEL_CHROME_COLUMNS = 4;

export type ControlSheetProps = {
  readonly catalog: ControlCatalog;
  readonly panel: ControlPanel;
  readonly selectedId: string | null;
  /** Rows the host measured. Content beyond them is reported, never drawn over. */
  readonly rows: number;
  /**
   * Records a session or model choice.
   *
   * Optional, because a frame rendered from a value alone has nothing to pick.
   * Absent, the list is not focused and no selection is ever produced.
   */
  readonly onSelect?: (id: string) => void;
};

export function ControlSheet(props: ControlSheetProps): ReactNode {
  const { terminal } = useFrame();
  const columns = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  if (props.rows < 1) {
    return null;
  }

  if (props.panel === "session" || props.panel === "model") {
    return (
      <OptionList
        options={optionsFor(props.catalog, props.panel)}
        selectedId={props.selectedId}
        empty={emptyReason(props.panel)}
        columns={columns}
        rows={props.rows}
        {...(props.onSelect === undefined ? {} : { onSelect: props.onSelect })}
      />
    );
  }

  return (
    <FactList
      facts={factsFor(props.catalog, props.panel)}
      empty={emptyReason(props.panel)}
      columns={columns}
      rows={props.rows}
    />
  );
}

function OptionList(props: {
  readonly options: readonly {
    readonly id: string;
    readonly title: string;
    readonly detail: string;
  }[];
  readonly selectedId: string | null;
  readonly empty: string;
  readonly columns: number;
  readonly rows: number;
  readonly onSelect?: (id: string) => void;
}): ReactNode {
  const { theme } = useFrame();
  const results = useRef<SelectRenderable | null>(null);
  const options = useMemo(() => props.options.map((item) => optionOf(item)), [props.options]);
  const selectedIndex = Math.max(
    0,
    props.options.findIndex((item) => item.id === props.selectedId),
  );
  const textColor = theme.color("foreground");
  const mutedColor = theme.color("mutedForeground");
  const selectionColor = theme.color("selection");

  useSelectNavigation(results, options.length, { enabled: props.onSelect !== undefined });

  if (options.length === 0) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
        {props.empty}
      </Line>
    );
  }

  const select = (option: SelectOption | null): void => {
    if (option !== null && typeof option.value === "string") {
      props.onSelect?.(option.value);
    }
  };

  return (
    <select
      ref={results}
      options={options}
      height={props.rows}
      width={props.columns}
      focused={props.onSelect !== undefined}
      showScrollIndicator
      showDescription={props.rows >= 2}
      selectedIndex={selectedIndex}
      {...(textColor === null
        ? {}
        : { textColor, selectedTextColor: textColor, selectedDescriptionColor: textColor })}
      {...(mutedColor === null ? {} : { descriptionColor: mutedColor })}
      {...(selectionColor === null ? {} : { selectedBackgroundColor: selectionColor })}
      onSelect={(_index, option) => select(option)}
    />
  );
}

function FactList(props: {
  readonly facts: readonly ControlFact[];
  readonly empty: string;
  readonly columns: number;
  readonly rows: number;
}): ReactNode {
  if (props.facts.length === 0) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
        {props.empty}
      </Line>
    );
  }

  const sliced = sliceControlFacts(props.facts, props.rows);
  return (
    <box flexDirection="column">
      {sliced.facts.map((fact) => (
        <FactRow key={fact.label} fact={fact} columns={props.columns} />
      ))}
      {sliced.hidden > 0 && sliced.facts.length > 0 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
          {`${sliced.hidden} more ${sliced.hidden === 1 ? "fact" : "facts"} not shown`}
        </Line>
      ) : null}
    </box>
  );
}

function FactRow(props: { readonly fact: ControlFact; readonly columns: number }): ReactNode {
  const label = `${props.fact.label}  `;
  const labelWidth = displayWidth(label);
  return (
    <box flexDirection="row">
      <Line color="mutedForeground" typography="label" maxColumns={props.columns}>
        {label}
      </Line>
      <FactBody value={props.fact.value} maxColumns={Math.max(1, props.columns - labelWidth)} />
    </box>
  );
}

function FactBody(props: { readonly value: FactValue; readonly maxColumns: number }): ReactNode {
  const { value } = props;
  if (value.kind === "known") {
    return (
      <Line color="foreground" maxColumns={props.maxColumns} untrusted>
        {value.text}
      </Line>
    );
  }
  if (value.kind === "partial") {
    return (
      <Line color="foreground" maxColumns={props.maxColumns} untrusted>
        {`${value.text} ${value.note}`}
      </Line>
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
    case "known":
    case "partial":
      return value.text;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function optionOf(item: {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}): SelectOption {
  return {
    name: item.title,
    description: item.detail,
    value: item.id,
  };
}
