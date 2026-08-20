/**
 * Git changes, worktree, and checkpoint overlay (#268).
 *
 * Loads a dashboard snapshot through the application port. Mutations stay on
 * that port; this module only draws and asks.
 */

import { type ReactNode, useEffect, useState } from "react";
import { describeGitError, type GitDashboard } from "../../application/index.ts";
import {
  type ChangesDashboardModel,
  type ChangesTab,
  changesDashboardFrom,
  rowsForTab,
} from "../../presentation/git/dashboard.ts";
import { useFrame } from "../components/context.tsx";
import { Line } from "../components/primitives.tsx";

const PANEL_CHROME_COLUMNS = 4;

export type ChangesPending = "none" | "create-checkpoint" | "restore";

export type GitDashboardOverlayProps = {
  readonly dashboard: GitDashboard;
  readonly tab: ChangesTab;
  readonly cursor: number;
  readonly pending: ChangesPending;
  readonly rows: number;
  readonly onSettled: (notice: string) => void;
};

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly model: ChangesDashboardModel }
  | { readonly kind: "error"; readonly message: string };

export function GitDashboardOverlay(props: GitDashboardOverlayProps): ReactNode {
  const { dashboard, pending, cursor, onSettled, tab, rows } = props;
  const { terminal } = useFrame();
  const width = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void (async () => {
      const result = await dashboard.snapshot();
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setState({ kind: "error", message: describeGitError(result.error) });
        return;
      }
      setState({ kind: "ready", model: changesDashboardFrom(result.value) });
    })();
    return () => {
      cancelled = true;
    };
  }, [dashboard]);

  useEffect(() => {
    if (pending === "none" || state.kind !== "ready") {
      return;
    }
    const model = state.model;
    let cancelled = false;
    void (async () => {
      const notice = await runPending(pending, dashboard, cursor, model);
      if (!cancelled) {
        onSettled(notice);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pending, state, dashboard, cursor, onSettled]);

  if (state.kind === "loading") {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        Loading Git dashboard…
      </Line>
    );
  }
  if (state.kind === "error") {
    return (
      <Line color="error" typography="body" maxColumns={width}>
        {state.message}
      </Line>
    );
  }

  const { model } = state;
  const labels = rowsForTab(model, tab);
  const selected = labels.length === 0 ? 0 : Math.min(cursor, labels.length - 1);
  const chrome = 2;
  const contentHeight = Math.max(1, rows - chrome);

  return (
    <box flexDirection="column" height={rows}>
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        {`${model.branch} · ${model.worktreeRoot} · ${model.operation}`}
      </Line>
      <Line color="accent" typography="label" maxColumns={width}>
        {`files · worktrees · checkpoints  (${tab})`}
      </Line>
      <scrollbox focused height={contentHeight} width={width}>
        <box flexDirection="column">
          {noteLines(model, tab).map((note) => (
            <Line key={note} color="warning" typography="muted" maxColumns={width}>
              {note}
            </Line>
          ))}
          {labels.length === 0 ? (
            <Line color="mutedForeground" typography="muted" maxColumns={width}>
              Nothing in this tab.
            </Line>
          ) : (
            labels.map((label, index) => (
              <Line
                key={label}
                color={index === selected ? "accent" : "foreground"}
                typography={index === selected ? "emphasis" : "body"}
                maxColumns={width}
              >
                {`${index === selected ? "▸ " : "  "}${label}`}
              </Line>
            ))
          )}
        </box>
      </scrollbox>
    </box>
  );
}

function noteLines(model: ChangesDashboardModel, tab: ChangesTab): readonly string[] {
  switch (tab) {
    case "files":
      return model.entriesNote === null ? [] : [model.entriesNote];
    case "worktrees":
      return model.worktreesNote === null ? [] : [model.worktreesNote];
    case "checkpoints":
      return model.checkpointsNote === null ? [] : [model.checkpointsNote];
    default: {
      const exhaustive: never = tab;
      return exhaustive;
    }
  }
}

async function runPending(
  pending: ChangesPending,
  dashboard: GitDashboard,
  cursor: number,
  model: ChangesDashboardModel,
): Promise<string> {
  if (pending === "create-checkpoint") {
    const result = await dashboard.createCheckpoint();
    return result.ok
      ? `Checkpoint ${result.value.checkpoint.id.slice(0, 12)} created.`
      : `Checkpoint failed: ${describeGitError(result.error)}`;
  }
  if (pending === "restore") {
    const selected = model.checkpoints[Math.min(cursor, Math.max(0, model.checkpoints.length - 1))];
    if (selected === undefined) {
      return "Select a checkpoint to restore.";
    }
    const result = await dashboard.restoreCheckpoint(selected.id);
    return result.ok
      ? `Restored checkpoint ${selected.label}.`
      : `Restore failed: ${describeGitError(result.error)}`;
  }
  return "";
}
