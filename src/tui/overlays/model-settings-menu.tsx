import type { SelectOption, SelectRenderable } from "@opentui/core";
import { type ReactNode, useRef } from "react";
import { useSelectNavigation } from "./select-navigation.ts";
export type MenuItem = {
  readonly title: string;
  readonly detail: string;
  readonly run: () => void;
};

export function SettingsMenu({
  items,
  rows,
  enabled,
}: {
  readonly items: readonly MenuItem[];
  readonly rows: number;
  readonly enabled: boolean;
}): ReactNode {
  const control = useRef<SelectRenderable | null>(null);
  const options: SelectOption[] = items.map((item, index) => ({
    name: item.title,
    description: item.detail,
    value: index,
  }));
  useSelectNavigation(control, items.length, { enabled });
  if (rows === 0) return null;
  return (
    <select
      ref={control}
      options={options}
      height={rows}
      focused={enabled}
      showScrollIndicator
      showDescription={rows >= 4}
      onSelect={(_index, option) => {
        if (typeof option?.value === "number") items[option.value]?.run();
      }}
    />
  );
}
