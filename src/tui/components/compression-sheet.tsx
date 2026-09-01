/** Interactive Brief, Hush, and Loom controls in one bounded overlay. */

import type { SelectOption, SelectRenderable } from "@opentui/core";
import { type ReactNode, useMemo, useRef } from "react";
import type { CompressionControlAction, CompressionControlState } from "../compression.ts";
import { useFrame } from "./context.tsx";
import { useSelectNavigation } from "./select-navigation.ts";

const PANEL_CHROME_COLUMNS = 4;

export type CompressionSheetProps = {
  readonly state: CompressionControlState;
  readonly rows: number;
  readonly onSelect?: (action: CompressionControlAction) => void;
};

export function CompressionSheet(props: CompressionSheetProps): ReactNode {
  const { terminal, theme } = useFrame();
  const control = useRef<SelectRenderable | null>(null);
  const columns = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);
  const options = useMemo(() => compressionOptions(props.state), [props.state]);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === `brief.${props.state.brief}`),
  );
  useSelectNavigation(control, options.length, { enabled: props.onSelect !== undefined });

  if (props.rows < 1) return null;

  const textColor = theme.color("foreground");
  const mutedColor = theme.color("mutedForeground");
  const selectionColor = theme.color("selection");
  return (
    <select
      ref={control}
      options={options}
      height={props.rows}
      width={columns}
      focused={props.onSelect !== undefined}
      showScrollIndicator
      showDescription={props.rows >= 2}
      selectedIndex={selectedIndex}
      {...(textColor === null
        ? {}
        : { textColor, selectedTextColor: textColor, selectedDescriptionColor: textColor })}
      {...(mutedColor === null ? {} : { descriptionColor: mutedColor })}
      {...(selectionColor === null ? {} : { selectedBackgroundColor: selectionColor })}
      onSelect={(_index, option) => {
        if (typeof option?.value === "string") {
          props.onSelect?.(option.value as CompressionControlAction);
        }
      }}
    />
  );
}

function compressionOptions(state: CompressionControlState): SelectOption[] {
  const briefState = state.brief ?? "unavailable";
  const hushState = state.hush ?? "unavailable";
  const loomState = state.loom ?? "unavailable";
  const briefOptions: SelectOption[] =
    briefState === "unavailable"
      ? [option("brief.auto", "Brief · unavailable", "No Brief control is attached to this shell.")]
      : [
          option(
            "brief.auto",
            `Brief · auto${briefState === "auto" ? " (current)" : ""}`,
            "Choose response density from the task, interface, risk, and terminal facts.",
          ),
          option(
            "brief.compact",
            `Brief · compact${briefState === "compact" ? " (current)" : ""}`,
            "Smallest complete answer; preserves required facts and the model's voice.",
          ),
          option(
            "brief.balanced",
            `Brief · balanced${briefState === "balanced" ? " (current)" : ""}`,
            "Concise answer with enough explanation to act.",
          ),
          option(
            "brief.detailed",
            `Brief · detailed${briefState === "detailed" ? " (current)" : ""}`,
            "More reasoning and procedural detail when the task needs it.",
          ),
          option(
            "brief.off",
            `Brief · off${briefState === "off" ? " (current)" : ""}`,
            "Return the provider's raw response policy without Brief guidance.",
          ),
        ];
  return [
    ...briefOptions,
    option(
      "hush.toggle",
      `Hush · ${hushState}`,
      "Toggle command-output reduction; off uses raw mode.",
    ),
    option(
      "loom.toggle",
      `Loom · ${loomState}`,
      "Toggle large-read projection; off uses bounded raw mode.",
    ),
    option("all.on", "Enable all", "Restore Brief and enable Hush and Loom."),
    option("all.off", "Disable all", "Use the raw/off frontend mode for all three engines."),
  ];
}

function option(value: CompressionControlAction, name: string, description: string): SelectOption {
  return { name, description, value };
}
