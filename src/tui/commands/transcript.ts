import { AVAILABLE, type ShellCommand, unavailable } from "./contracts.ts";

/** Transcript, artifact viewer, and Git dashboard commands. */
export const TRANSCRIPT_COMMANDS: readonly ShellCommand[] = [
  {
    id: "transcript.search",
    title: "Search the transcript",
    description: "Find text in the projected conversation.",
    context: "transcript",
    defaultBinding: "ctrl+f",
    keywords: ["find", "filter"],
    availability: () => unavailable("there is no transcript search yet"),
  },
  {
    id: "transcript.expand",
    title: "Expand the selected entry",
    description: "Inspect a tool call or artifact in full, or collapse it again.",
    context: "transcript",
    defaultBinding: "return",
    keywords: ["inspect", "open", "detail", "collapse"],
    availability: (state) =>
      state.hasTranscript ? AVAILABLE : unavailable("there is no transcript yet"),
  },
  {
    id: "transcript.includeInDraft",
    title: "Include in draft",
    description: "Attach the selected transcript pick to the composer draft.",
    context: "transcript",
    defaultBinding: null,
    keywords: ["include", "attach", "pick", "draft", "chip"],
    availability: (state) =>
      state.hasTranscript ? AVAILABLE : unavailable("there is no transcript yet"),
  },
  {
    id: "transcript.copy",
    title: "Copy pick body",
    description: "Copy the selected transcript pick body to the clipboard.",
    context: "transcript",
    defaultBinding: null,
    keywords: ["copy", "clipboard", "pick", "body"],
    availability: (state) =>
      state.hasTranscript ? AVAILABLE : unavailable("there is no transcript yet"),
  },
  {
    id: "transcript.copyIdentity",
    title: "Copy pick identity",
    description: "Copy the selected entry's path or command line, not its body.",
    context: "transcript",
    defaultBinding: null,
    keywords: ["copy", "clipboard", "path", "command", "identity"],
    availability: (state) =>
      state.hasTranscript ? AVAILABLE : unavailable("there is no transcript yet"),
  },
  {
    id: "transcript.inspect",
    title: "Inspect the selected entry",
    description: "Inspect a tool, process, reasoning, or error block without submitting.",
    context: "transcript",
    defaultBinding: null,
    keywords: ["inspect", "detail", "tool", "process", "reasoning", "error"],
    availability: (state) =>
      state.hasInspectableSelection
        ? AVAILABLE
        : unavailable("this entry has no tool, process, reasoning, or error inspection"),
  },
  {
    id: "transcript.selectPrevious",
    title: "Select the previous entry",
    description: "Move the transcript selection one entry towards the start.",
    context: "transcript",
    defaultBinding: "up",
    keywords: ["previous", "move", "entry"],
    availability: (state) =>
      state.hasTranscript ? AVAILABLE : unavailable("there is no transcript yet"),
  },
  {
    id: "transcript.selectNext",
    title: "Select the next entry",
    description: "Move the transcript selection one entry towards the latest.",
    context: "transcript",
    defaultBinding: "down",
    keywords: ["next", "move", "entry"],
    availability: (state) =>
      state.hasTranscript ? AVAILABLE : unavailable("there is no transcript yet"),
  },
  {
    id: "transcript.jumpToLatest",
    title: "Jump to the latest entry",
    description: "Follow the transcript again after scrolling away from it.",
    context: "transcript",
    defaultBinding: "end",
    keywords: ["latest", "bottom", "follow", "unseen"],
    availability: (state) =>
      state.hasTranscript ? AVAILABLE : unavailable("there is no transcript yet"),
  },
  {
    id: "transcript.openArtifact",
    title: "Open the artifact",
    description: "Open the artifact an entry's content was clipped from.",
    context: "transcript",
    defaultBinding: null,
    keywords: ["artifact", "open", "export"],
    availability: (state) =>
      state.hasOpenableArtifact
        ? AVAILABLE
        : unavailable("there is no openable artifact to view for this entry"),
  },
  {
    id: "artifact.toggleDiffLayout",
    title: "Toggle diff layout",
    description: "Switch the diff viewer between unified and split layout.",
    context: "overlay",
    defaultBinding: "v",
    keywords: ["diff", "split", "unified", "layout"],
    availability: (state) =>
      state.hasDiffArtifactOverlay ? AVAILABLE : unavailable("no diff viewer is open"),
  },
  {
    id: "artifact.nextHunk",
    title: "Next diff hunk",
    description: "Move to the next hunk in the diff viewer.",
    context: "overlay",
    defaultBinding: "]",
    keywords: ["diff", "hunk", "next"],
    availability: (state) =>
      state.hasDiffArtifactOverlay ? AVAILABLE : unavailable("no diff viewer is open"),
  },
  {
    id: "artifact.previousHunk",
    title: "Previous diff hunk",
    description: "Move to the previous hunk in the diff viewer.",
    context: "overlay",
    defaultBinding: "[",
    keywords: ["diff", "hunk", "previous"],
    availability: (state) =>
      state.hasDiffArtifactOverlay ? AVAILABLE : unavailable("no diff viewer is open"),
  },
  {
    id: "changes.open",
    title: "Open Git dashboard",
    description: "Show changes, worktrees, and checkpoints for this workspace.",
    context: "global",
    defaultBinding: "ctrl+g",
    keywords: ["git", "changes", "diff", "worktree", "checkpoint", "status"],
    availability: () => AVAILABLE,
  },
  {
    id: "changes.nextTab",
    title: "Next Git dashboard tab",
    description: "Cycle files, worktrees, and checkpoints.",
    context: "overlay",
    defaultBinding: "t",
    keywords: ["git", "tab", "worktree", "checkpoint"],
    availability: (state) =>
      state.hasChangesOverlay ? AVAILABLE : unavailable("no Git dashboard is open"),
  },
  {
    id: "changes.previousTab",
    title: "Previous Git dashboard tab",
    description: "Cycle files, worktrees, and checkpoints backwards.",
    context: "overlay",
    defaultBinding: "shift+t",
    keywords: ["git", "tab"],
    availability: (state) =>
      state.hasChangesOverlay ? AVAILABLE : unavailable("no Git dashboard is open"),
  },
  {
    id: "changes.nextEntry",
    title: "Next Git dashboard row",
    description: "Move the cursor down in the Git dashboard.",
    context: "overlay",
    defaultBinding: "j",
    keywords: ["git", "next"],
    availability: (state) =>
      state.hasChangesOverlay ? AVAILABLE : unavailable("no Git dashboard is open"),
  },
  {
    id: "changes.previousEntry",
    title: "Previous Git dashboard row",
    description: "Move the cursor up in the Git dashboard.",
    context: "overlay",
    defaultBinding: "k",
    keywords: ["git", "previous"],
    availability: (state) =>
      state.hasChangesOverlay ? AVAILABLE : unavailable("no Git dashboard is open"),
  },
  {
    id: "changes.createCheckpoint",
    title: "Create a checkpoint",
    description: "Snapshot the current Git index and worktree.",
    context: "overlay",
    defaultBinding: "c",
    keywords: ["git", "checkpoint", "save"],
    availability: (state) =>
      state.hasChangesOverlay ? AVAILABLE : unavailable("no Git dashboard is open"),
  },
  {
    id: "changes.restoreCheckpoint",
    title: "Restore the selected checkpoint",
    description: "Restore the checkpoint under the cursor after a restore plan.",
    context: "overlay",
    defaultBinding: "r",
    keywords: ["git", "checkpoint", "restore"],
    availability: (state) =>
      state.hasChangesOverlay && state.changesTab === "checkpoints"
        ? AVAILABLE
        : unavailable("select a checkpoint first"),
  },
  {
    id: "transcript.showDiagnostics",
    title: "Show the diagnostics",
    description: "Show the diagnostics behind a failed entry.",
    context: "transcript",
    defaultBinding: null,
    keywords: ["diagnostics", "failure", "why"],
    availability: (state) =>
      state.hasDiagnosticSelection
        ? AVAILABLE
        : unavailable("this entry has no inspectable diagnostics"),
  },
];
