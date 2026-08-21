/**
 * Session resume, fork, rewind, and replay overlay facts (#722).
 *
 * Formats panel titles and route helpers. Persistence and navigation stay in
 * application ports; this module only names what the overlay is showing.
 */

export const SESSION_NAV_PANELS = ["resume", "fork", "rewind", "replay"] as const;
export type SessionNavPanel = (typeof SESSION_NAV_PANELS)[number];

export const SESSION_NAV_PANEL_TITLES: Readonly<Record<SessionNavPanel, string>> = {
  resume: "Resume session",
  fork: "Fork session",
  rewind: "Rewind session",
  replay: "Replay session",
};

export const REPLAY_ACTIONS = ["play", "pause", "step"] as const;
export type ReplayAction = (typeof REPLAY_ACTIONS)[number];

export const REPLAY_ACTION_LABELS: Readonly<Record<ReplayAction, string>> = {
  play: "Play",
  pause: "Pause",
  step: "Step",
};

export function sessionNavOverlayRoute(
  panel: SessionNavPanel,
  sessionId: string | null = null,
  draft = "",
): {
  readonly kind: "session-nav";
  readonly panel: SessionNavPanel;
  readonly sessionId: string | null;
  readonly draft: string;
} {
  return { kind: "session-nav", panel, sessionId, draft };
}

export function sessionNavPanelForCommand(id: string): SessionNavPanel | null {
  switch (id) {
    case "session.resume":
      return "resume";
    case "session.fork":
      return "fork";
    case "session.rewind":
      return "rewind";
    case "session.replay":
      return "replay";
    default:
      return null;
  }
}
