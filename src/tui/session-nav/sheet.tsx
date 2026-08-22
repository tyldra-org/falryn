/**
 * Session resume, fork, rewind, and replay overlays (#722).
 *
 * Collects session and turn choices, then hands them to the application-backed
 * controller. Replay surfaces effect-free cursor movement explicitly.
 */

import type { SelectOption, SelectRenderable } from "@opentui/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "../components/context.tsx";
import { Line } from "../components/primitives.tsx";
import { useSelectNavigation } from "../components/select-navigation.ts";
import {
  describeSessionNavigationControllerError,
  noticeForFork,
  noticeForReplay,
  noticeForResume,
  type SessionNavigationController,
  type SessionNavListEntry,
} from "./controller.ts";
import {
  REPLAY_ACTION_LABELS,
  REPLAY_ACTIONS,
  type ReplayAction,
  SESSION_NAV_PANEL_TITLES,
  type SessionNavPanel,
} from "./format.ts";

const PANEL_CHROME_COLUMNS = 4;

export type SessionNavSheetProps = {
  readonly panel: SessionNavPanel;
  readonly sessionId: string | null;
  readonly draft: string;
  readonly controller: SessionNavigationController;
  readonly rows: number;
  readonly onDraft?: (draft: string) => void;
  readonly onSession?: (sessionId: string) => void;
  readonly onNotice?: (message: string) => void;
  readonly onClose?: () => void;
};

export function SessionNavSheet(props: SessionNavSheetProps): ReactNode {
  const { terminal } = useFrame();
  const columns = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  if (props.rows < 1) {
    return null;
  }

  switch (props.panel) {
    case "resume":
    case "fork":
      return (
        <SessionListPanel
          controller={props.controller}
          columns={columns}
          rows={props.rows}
          onSelect={(sessionId) => {
            void applyResumeOrFork(props, sessionId);
          }}
        />
      );
    case "rewind":
      return (
        <RewindPanel
          controller={props.controller}
          sessionId={props.sessionId}
          draft={props.draft}
          columns={columns}
          rows={props.rows}
          {...(props.onDraft === undefined ? {} : { onDraft: props.onDraft })}
          {...(props.onSession === undefined ? {} : { onSession: props.onSession })}
          onSubmit={() => {
            void applyRewind(props);
          }}
        />
      );
    case "replay":
      return (
        <ReplayPanel
          controller={props.controller}
          sessionId={props.sessionId}
          columns={columns}
          rows={props.rows}
          {...(props.onSession === undefined ? {} : { onSession: props.onSession })}
          onSelect={(action) => {
            void applyReplay(props, action);
          }}
        />
      );
    default: {
      const exhaustive: never = props.panel;
      return exhaustive;
    }
  }
}

async function applyResumeOrFork(props: SessionNavSheetProps, sessionId: string): Promise<void> {
  if (props.panel === "resume") {
    const result = await props.controller.resume(sessionId);
    if (!result.ok) {
      props.onNotice?.(describeSessionNavigationControllerError(result.error));
      return;
    }
    props.onNotice?.(noticeForResume(result.value));
    props.onClose?.();
    return;
  }
  const result = await props.controller.fork(sessionId);
  if (!result.ok) {
    props.onNotice?.(describeSessionNavigationControllerError(result.error));
    return;
  }
  props.onNotice?.(noticeForFork(result.value));
  props.onClose?.();
}

async function applyRewind(props: SessionNavSheetProps): Promise<void> {
  const sessionId = props.sessionId;
  if (sessionId === null) {
    props.onNotice?.("Choose a session to rewind.");
    return;
  }
  const result = await props.controller.rewind(sessionId, props.draft);
  if (!result.ok) {
    props.onNotice?.(describeSessionNavigationControllerError(result.error));
    return;
  }
  props.onNotice?.(noticeForFork(result.value));
  props.onClose?.();
}

async function applyReplay(props: SessionNavSheetProps, action: ReplayAction): Promise<void> {
  const sessionId = props.sessionId;
  if (sessionId === null) {
    props.onNotice?.("Choose a session to replay.");
    return;
  }
  const result = await props.controller.replay(sessionId, action);
  if (!result.ok) {
    props.onNotice?.(describeSessionNavigationControllerError(result.error));
    return;
  }
  props.onNotice?.(noticeForReplay(result.value));
  props.onClose?.();
}

function SessionListPanel(props: {
  readonly controller: SessionNavigationController;
  readonly columns: number;
  readonly rows: number;
  readonly onSelect: (sessionId: string) => void;
}): ReactNode {
  const [sessions, setSessions] = useState<readonly SessionNavListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSessions(null);
    setError(null);
    void (async () => {
      const listed = await props.controller.listSessions();
      if (cancelled) {
        return;
      }
      if (!listed.ok) {
        setError(describeSessionNavigationControllerError(listed.error));
        setSessions([]);
        return;
      }
      setSessions(listed.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.controller]);

  if (sessions === null) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
        Loading sessions…
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
      options={sessions.map((entry) => ({
        id: entry.sessionId,
        title: entry.title,
        detail: entry.detail,
      }))}
      empty="No sessions yet."
      columns={props.columns}
      rows={props.rows}
      onSelect={props.onSelect}
    />
  );
}

function RewindPanel(props: {
  readonly controller: SessionNavigationController;
  readonly sessionId: string | null;
  readonly draft: string;
  readonly columns: number;
  readonly rows: number;
  readonly onDraft?: (draft: string) => void;
  readonly onSession?: (sessionId: string) => void;
  readonly onSubmit: () => void;
}): ReactNode {
  const listRows = props.rows >= 3 ? props.rows - 2 : Math.max(1, props.rows - 1);

  return (
    <box flexDirection="column">
      <SessionListPanel
        controller={props.controller}
        columns={props.columns}
        rows={listRows}
        onSelect={(sessionId) => props.onSession?.(sessionId)}
      />
      {props.rows >= 2 ? (
        <DraftInput
          value={props.draft}
          placeholder="Turn id to rewind at (--at-turn)."
          columns={props.columns}
          {...(props.onDraft === undefined ? {} : { onDraft: props.onDraft })}
          onSubmit={props.onSubmit}
        />
      ) : null}
      {props.sessionId !== null && props.rows >= 3 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
          {`Selected ${props.sessionId}. Enter submits rewind.`}
        </Line>
      ) : null}
    </box>
  );
}

function ReplayPanel(props: {
  readonly controller: SessionNavigationController;
  readonly sessionId: string | null;
  readonly columns: number;
  readonly rows: number;
  readonly onSession?: (sessionId: string) => void;
  readonly onSelect: (action: ReplayAction) => void;
}): ReactNode {
  if (props.sessionId === null) {
    return (
      <box flexDirection="column">
        {props.rows >= 2 ? (
          <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
            Effect-free: moves the replay cursor only; does not repeat tools or providers.
          </Line>
        ) : null}
        <SessionListPanel
          controller={props.controller}
          columns={props.columns}
          rows={Math.max(1, props.rows - 1)}
          onSelect={(sessionId) => props.onSession?.(sessionId)}
        />
      </box>
    );
  }

  const actionRows = Math.max(1, props.rows - 1);
  return (
    <box flexDirection="column">
      <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
        {`Effect-free replay for ${props.sessionId}. No tool or provider effects repeat.`}
      </Line>
      <OptionList
        options={REPLAY_ACTIONS.map((action) => ({
          id: action,
          title: REPLAY_ACTION_LABELS[action],
          detail: "Cursor-only replay control",
        }))}
        empty="No replay actions."
        columns={props.columns}
        rows={actionRows}
        onSelect={(id) => {
          if ((REPLAY_ACTIONS as readonly string[]).includes(id)) {
            props.onSelect(id as ReplayAction);
          }
        }}
      />
    </box>
  );
}

function DraftInput(props: {
  readonly value: string;
  readonly placeholder: string;
  readonly columns: number;
  readonly onDraft?: (draft: string) => void;
  readonly onSubmit: () => void;
}): ReactNode {
  const { theme } = useFrame();
  const textColor = theme.color("foreground");
  const mutedColor = theme.color("mutedForeground");

  return (
    <input
      value={props.value}
      focused={props.onDraft !== undefined}
      width={props.columns}
      placeholder={props.placeholder}
      {...(textColor === null ? {} : { textColor })}
      {...(mutedColor === null ? {} : { placeholderColor: mutedColor })}
      onInput={(value) => props.onDraft?.(value)}
      onSubmit={() => props.onSubmit()}
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

/** Title for the overlay host. */
export function sessionNavPanelTitle(panel: SessionNavPanel): string {
  return SESSION_NAV_PANEL_TITLES[panel];
}
