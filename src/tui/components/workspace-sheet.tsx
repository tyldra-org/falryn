/**
 * Workspace-set inspect and mutate overlays (#607).
 *
 * Collects path or layout-name text and root/layout choices, then hands them to
 * the application-backed controller. The sheet never binds paths or writes
 * layout files itself.
 */

import type { SelectOption, SelectRenderable } from "@opentui/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { displayWidth } from "../../domain/index.ts";
import { type FactValue, statusOfFact } from "../view-model.ts";
import {
  describeWorkspaceControllerError,
  WORKSPACE_PANEL_TITLES,
  type WorkspaceController,
  type WorkspaceLayoutListEntry,
  type WorkspacePanel,
  type WorkspaceSetView,
  workspaceRootFacts,
} from "../workspace/index.ts";
import { useFrame } from "./context.tsx";
import { Line, StatusMark } from "./primitives.tsx";
import { useSelectNavigation } from "./select-navigation.ts";

const PANEL_CHROME_COLUMNS = 4;

export type WorkspaceSheetProps = {
  readonly panel: WorkspacePanel;
  readonly draft: string;
  readonly workspace: WorkspaceSetView;
  readonly controller: WorkspaceController;
  readonly rows: number;
  readonly onDraft?: (draft: string) => void;
  readonly onWorkspace?: (set: WorkspaceSetView, notice: string) => void;
  readonly onNotice?: (message: string) => void;
  readonly onClose?: () => void;
};

export function WorkspaceSheet(props: WorkspaceSheetProps): ReactNode {
  const { terminal } = useFrame();
  const columns = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  if (props.rows < 1) {
    return null;
  }

  switch (props.panel) {
    case "show":
      return <ShowPanel workspace={props.workspace} columns={columns} rows={props.rows} />;
    case "add":
    case "save":
      return (
        <DraftPanel
          panel={props.panel}
          draft={props.draft}
          columns={columns}
          rows={props.rows}
          {...(props.onDraft === undefined ? {} : { onDraft: props.onDraft })}
          onSubmit={() => {
            void submitDraft(props);
          }}
        />
      );
    case "remove":
      return (
        <RemovePanel
          workspace={props.workspace}
          columns={columns}
          rows={props.rows}
          onSelect={(rootId) => {
            applyRemove(props, rootId);
          }}
        />
      );
    case "load":
      return (
        <LoadPanel
          controller={props.controller}
          columns={columns}
          rows={props.rows}
          onSelect={(name) => {
            void applyLoad(props, name);
          }}
        />
      );
    default: {
      const exhaustive: never = props.panel;
      return exhaustive;
    }
  }
}

async function submitDraft(props: WorkspaceSheetProps): Promise<void> {
  if (props.panel === "add") {
    const result = await props.controller.addRoot(props.workspace, props.draft);
    if (!result.ok) {
      props.onNotice?.(describeWorkspaceControllerError(result.error));
      return;
    }
    props.onWorkspace?.(result.value, "Workspace root added.");
    props.onClose?.();
    return;
  }
  if (props.panel === "save") {
    const result = await props.controller.save(props.workspace, props.draft.trim());
    if (!result.ok) {
      props.onNotice?.(describeWorkspaceControllerError(result.error));
      return;
    }
    props.onWorkspace?.(result.value, `Saved layout “${props.draft.trim()}”.`);
    props.onClose?.();
  }
}

function applyRemove(props: WorkspaceSheetProps, rootId: string): void {
  const result = props.controller.removeRoot(props.workspace, rootId);
  if (!result.ok) {
    props.onNotice?.(describeWorkspaceControllerError(result.error));
    return;
  }
  props.onWorkspace?.(result.value, "Workspace root removed.");
  props.onClose?.();
}

async function applyLoad(props: WorkspaceSheetProps, name: string): Promise<void> {
  const result = await props.controller.load(name);
  if (!result.ok) {
    props.onNotice?.(describeWorkspaceControllerError(result.error));
    return;
  }
  props.onWorkspace?.(result.value, `Loaded layout “${name}”.`);
  props.onClose?.();
}

function ShowPanel(props: {
  readonly workspace: WorkspaceSetView;
  readonly columns: number;
  readonly rows: number;
}): ReactNode {
  const facts = workspaceRootFacts(props.workspace);
  if (facts.length === 0) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
        No workspace roots are bound.
      </Line>
    );
  }
  const shown = facts.slice(0, props.rows);
  const hidden = Math.max(0, facts.length - shown.length);
  return (
    <box flexDirection="column">
      {shown.map((fact) => (
        <FactRow key={fact.label} label={fact.label} value={fact.value} columns={props.columns} />
      ))}
      {hidden > 0 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
          {`${hidden} more ${hidden === 1 ? "root" : "roots"} not shown`}
        </Line>
      ) : null}
    </box>
  );
}

function DraftPanel(props: {
  readonly panel: "add" | "save";
  readonly draft: string;
  readonly columns: number;
  readonly rows: number;
  readonly onDraft?: (draft: string) => void;
  readonly onSubmit: () => void;
}): ReactNode {
  const { theme } = useFrame();
  const textColor = theme.color("foreground");
  const mutedColor = theme.color("mutedForeground");
  const placeholder =
    props.panel === "add" ? "Path to add as a workspace root." : "Name for this saved layout.";

  return (
    <box flexDirection="column">
      <input
        value={props.draft}
        focused={props.onDraft !== undefined}
        width={props.columns}
        placeholder={placeholder}
        {...(textColor === null ? {} : { textColor })}
        {...(mutedColor === null ? {} : { placeholderColor: mutedColor })}
        onInput={(value) => props.onDraft?.(value)}
        onSubmit={() => props.onSubmit()}
      />
      {props.rows > 1 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
          {props.panel === "add"
            ? "Enter adds the path through the workspace port."
            : "Enter saves the current set under that name."}
        </Line>
      ) : null}
    </box>
  );
}

function RemovePanel(props: {
  readonly workspace: WorkspaceSetView;
  readonly columns: number;
  readonly rows: number;
  readonly onSelect: (rootId: string) => void;
}): ReactNode {
  const removable = props.workspace.roots.slice(1);
  const options = removable.map((root) => ({
    id: root.rootId,
    title: root.name,
    detail: root.path,
  }));
  return (
    <OptionList
      options={options}
      empty="No additional roots to remove. The primary root stays."
      columns={props.columns}
      rows={props.rows}
      onSelect={props.onSelect}
    />
  );
}

function LoadPanel(props: {
  readonly controller: WorkspaceController;
  readonly columns: number;
  readonly rows: number;
  readonly onSelect: (name: string) => void;
}): ReactNode {
  const [layouts, setLayouts] = useState<readonly WorkspaceLayoutListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLayouts(null);
    setError(null);
    void (async () => {
      const listed = await props.controller.listLayouts();
      if (cancelled) {
        return;
      }
      if (!listed.ok) {
        setError(describeWorkspaceControllerError(listed.error));
        setLayouts([]);
        return;
      }
      setLayouts(listed.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.controller]);

  if (layouts === null) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
        Loading saved layouts…
      </Line>
    );
  }
  if (error !== null) {
    return (
      <Line color="error" typography="body" maxColumns={props.columns}>
        {error}
      </Line>
    );
  }

  return (
    <OptionList
      options={layouts.map((entry) => ({
        id: entry.name,
        title: entry.name,
        detail: `${entry.rootCount} ${entry.rootCount === 1 ? "root" : "roots"}`,
      }))}
      empty="No saved layouts yet."
      columns={props.columns}
      rows={props.rows}
      onSelect={props.onSelect}
    />
  );
}

function OptionList(props: {
  readonly options: readonly {
    readonly id: string;
    readonly title: string;
    readonly detail: string;
  }[];
  readonly empty: string;
  readonly columns: number;
  readonly rows: number;
  readonly onSelect: (id: string) => void;
}): ReactNode {
  const { theme } = useFrame();
  const results = useRef<SelectRenderable | null>(null);
  const options = useMemo(() => props.options.map((item) => optionOf(item)), [props.options]);
  const textColor = theme.color("foreground");
  const mutedColor = theme.color("mutedForeground");
  const selectionColor = theme.color("selection");

  useSelectNavigation(results, options.length);

  if (options.length === 0) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
        {props.empty}
      </Line>
    );
  }

  const select = (option: SelectOption | null): void => {
    if (option !== null && typeof option.value === "string") {
      props.onSelect(option.value);
    }
  };

  return (
    <select
      ref={results}
      options={options}
      height={props.rows}
      width={props.columns}
      focused
      showScrollIndicator
      showDescription={props.rows >= 2}
      selectedIndex={0}
      {...(textColor === null
        ? {}
        : { textColor, selectedTextColor: textColor, selectedDescriptionColor: textColor })}
      {...(mutedColor === null ? {} : { descriptionColor: mutedColor })}
      {...(selectionColor === null ? {} : { selectedBackgroundColor: selectionColor })}
      onSelect={(_index, option) => select(option)}
    />
  );
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

function FactRow(props: {
  readonly label: string;
  readonly value: FactValue;
  readonly columns: number;
}): ReactNode {
  const label = `${props.label}  `;
  const labelWidth = displayWidth(label);
  return (
    <box flexDirection="row">
      <Line color="mutedForeground" typography="label" maxColumns={props.columns}>
        {label}
      </Line>
      <FactBody value={props.value} maxColumns={Math.max(1, props.columns - labelWidth)} />
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
      label={value.kind === "unavailable" || value.kind === "error" ? value.reason : value.kind}
      maxColumns={props.maxColumns}
    />
  );
}

/** Title for the overlay host; kept here so app-shell need not import the map alone. */
export function workspacePanelTitle(panel: WorkspacePanel): string {
  return WORKSPACE_PANEL_TITLES[panel];
}
