import { AVAILABLE, type ShellCommand, unavailable } from "./contracts.ts";

/** Session, model, context, workspace, and task-intelligence commands. */
export const NAVIGATION_COMMANDS: readonly ShellCommand[] = [
  {
    id: "session.switch",
    title: "Switch session",
    description: "Choose among sessions the application has supplied.",
    context: "global",
    defaultBinding: null,
    keywords: ["session", "switch", "resume"],
    availability: () => AVAILABLE,
  },
  {
    id: "session.new",
    title: "New session",
    description: "Start a durable session for this workspace.",
    context: "global",
    defaultBinding: null,
    keywords: ["session", "new", "create"],
    availability: (state) => {
      if (!state.hasSessionCreation) {
        return unavailable("no durable session factory yet");
      }
      if (state.hasInFlightSubmission || state.hasRunningWork) {
        return unavailable("the current session still has active work");
      }
      if (state.hasConfirmation) {
        return unavailable("resolve the pending confirmation first");
      }
      return AVAILABLE;
    },
  },
  {
    id: "model.select",
    title: "Select model",
    description: "Choose among models the application has supplied.",
    context: "global",
    defaultBinding: null,
    keywords: ["model", "provider", "route"],
    availability: () => AVAILABLE,
  },
  {
    id: "mode.select",
    title: "Select execution mode",
    description: "Inspect or select Ask, Plan, Debug, or Agent for upcoming turns.",
    context: "global",
    defaultBinding: null,
    keywords: ["mode", "profile", "ask", "plan", "debug", "agent"],
    availability: () => AVAILABLE,
  },
  {
    id: "context.show",
    title: "Show context",
    description: "Inspect token, byte, and item budget facts.",
    context: "global",
    defaultBinding: null,
    keywords: ["context", "budget", "tokens"],
    availability: () => AVAILABLE,
  },
  {
    id: "resource.show",
    title: "Show resources",
    description: "Inspect runtime resource facts.",
    context: "global",
    defaultBinding: null,
    keywords: ["resource", "memory", "usage"],
    availability: () => AVAILABLE,
  },
  {
    id: "workspace.addRoot",
    title: "Add workspace root",
    description: "Append another named root to this session's workspace set.",
    context: "global",
    defaultBinding: null,
    keywords: ["workspace", "add", "root", "directory"],
    availability: (state) =>
      state.hasWorkspaceSet ? AVAILABLE : unavailable("no workspace set yet"),
  },
  {
    id: "workspace.removeRoot",
    title: "Remove workspace root",
    description: "Drop an additional root from this session's workspace set.",
    context: "global",
    defaultBinding: null,
    keywords: ["workspace", "remove", "root"],
    availability: (state) => {
      if (state.hasRemovableWorkspaceRoot) {
        return AVAILABLE;
      }
      return unavailable(
        state.hasWorkspaceSet ? "only the primary root is bound" : "no workspace set yet",
      );
    },
  },
  {
    id: "workspace.save",
    title: "Save workspace layout",
    description: "Persist the current root set under a layout name.",
    context: "global",
    defaultBinding: null,
    keywords: ["workspace", "save", "layout"],
    availability: (state) =>
      state.hasWorkspaceSet ? AVAILABLE : unavailable("no workspace set yet"),
  },
  {
    id: "workspace.load",
    title: "Load workspace layout",
    description: "Replace this session's root set from a saved layout.",
    context: "global",
    defaultBinding: null,
    keywords: ["workspace", "load", "layout"],
    availability: (state) =>
      state.hasWorkspaceSet ? AVAILABLE : unavailable("no workspace set yet"),
  },
  {
    id: "workspace.show",
    title: "Show workspace set",
    description: "List every bound root id, name, and path.",
    context: "global",
    defaultBinding: null,
    keywords: ["workspace", "show", "roots"],
    availability: (state) =>
      state.hasWorkspaceSet ? AVAILABLE : unavailable("no workspace set yet"),
  },
  {
    id: "session.resume",
    title: "Resume session",
    description: "Continue a session from its durable cursor without forking.",
    context: "global",
    defaultBinding: null,
    keywords: ["session", "resume", "continue", "cursor"],
    availability: (state) =>
      state.hasSessionNavigation ? AVAILABLE : unavailable("no session store yet"),
  },
  {
    id: "session.fork",
    title: "Fork session",
    description: "Copy a session into new identities without rewriting the source.",
    context: "global",
    defaultBinding: null,
    keywords: ["session", "fork", "branch", "copy"],
    availability: (state) =>
      state.hasSessionNavigation ? AVAILABLE : unavailable("no session store yet"),
  },
  {
    id: "session.rewind",
    title: "Rewind session",
    description: "Fork a session as new history ending at a chosen turn.",
    context: "global",
    defaultBinding: null,
    keywords: ["session", "rewind", "turn", "history"],
    availability: (state) =>
      state.hasSessionNavigation ? AVAILABLE : unavailable("no session store yet"),
  },
  {
    id: "session.replay",
    title: "Replay session",
    description: "Move a replay cursor over recorded events without repeating effects.",
    context: "global",
    defaultBinding: null,
    keywords: ["session", "replay", "cursor", "effect-free"],
    availability: (state) =>
      state.hasSessionNavigation ? AVAILABLE : unavailable("no session store yet"),
  },
  {
    id: "task.decompose",
    title: "Decompose outcome",
    description: "Turn a declared outcome into bounded tasks.",
    context: "global",
    defaultBinding: null,
    keywords: ["task", "decompose", "goals", "outcome"],
    availability: () => AVAILABLE,
  },
  {
    id: "task.validate",
    title: "Validation advice",
    description: "Recommend focused validation from declared criteria.",
    context: "global",
    defaultBinding: null,
    keywords: ["task", "validate", "criteria", "advice"],
    availability: () => AVAILABLE,
  },
  {
    id: "task.progress",
    title: "Task progress",
    description: "Project next actions from a task graph and observations.",
    context: "global",
    defaultBinding: null,
    keywords: ["task", "progress", "next", "actions"],
    availability: () => AVAILABLE,
  },
  {
    id: "task.commit-plan",
    title: "Commit plan",
    description: "Preview or confirm a commit plan from actual changes.",
    context: "global",
    defaultBinding: null,
    keywords: ["task", "commit", "plan", "git"],
    availability: () => AVAILABLE,
  },
];
