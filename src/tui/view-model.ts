/**
 * What the frame is given, and what it may say.
 *
 * Every composite in this area renders a value from this module and nothing
 * else. It holds no renderer, no clock, no port, and no OpenTUI type — so a view
 * model can be built, compared, and asserted on without a terminal, and a
 * component's contract is a data shape rather than a description of one.
 *
 * The state unions here are the reason the interface can be honest. Falryn's
 * runtime distinguishes a failure from an effect nobody observed, and a cancelled
 * operation from one that never started; a view model that flattened those into
 * a nullable string would force every view to invent the distinction back, badly
 * and differently each time. Today most of these states are reachable for a
 * plain reason: no producer of sessions, models, or Git state exists yet, so
 * `unavailable` is not a placeholder, it is the truth.
 */

import type { ActivityModel } from "./activity-model.ts";
import type { ComposerModel } from "./composer-model.ts";
import type { StatusToken } from "./theme/index.ts";
import type { TranscriptModel } from "./transcript-model.ts";

/**
 * One labelled fact, in whatever condition it is actually in.
 *
 * `empty` and `unavailable` are different and the difference is load-bearing:
 * a workspace with no branch is on a detached head, and a build that cannot
 * read Git at all knows nothing about branches. Rendering both as a dash would
 * tell a user their repository has no branch.
 */
export type FactValue =
  | { readonly kind: "known"; readonly text: string }
  /** Known, but not all of it. Carries why, so the gap is nameable. */
  | { readonly kind: "partial"; readonly text: string; readonly note: string }
  | { readonly kind: "loading" }
  /** Known to be nothing. A repository with no commits, a session with no model. */
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "cancelled" }
  /** Nothing could look. No producer, no permission, no such capability. */
  | { readonly kind: "unavailable"; readonly reason: string };

export function known(text: string): FactValue {
  return { kind: "known", text };
}

export function unavailable(reason: string): FactValue {
  return { kind: "unavailable", reason };
}

/**
 * The status a fact's condition implies.
 *
 * One mapping, here, so a header and a status line cannot disagree about what
 * colour and symbol an error wears.
 */
export function statusOfFact(value: FactValue): StatusToken {
  switch (value.kind) {
    case "known":
      return "success";
    case "partial":
      return "warning";
    case "loading":
      return "pending";
    case "empty":
      return "informational";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    case "unavailable":
      return "uncertain";
  }
}

export type WorkspaceHeaderModel = {
  readonly workspace: FactValue;
  readonly branch: FactValue;
  readonly session: FactValue;
  readonly model: FactValue;
};

/** A key and the named command it runs. The command name is the durable half. */
export type KeyHint = {
  readonly keys: string;
  readonly command: string;
};

export type StatusLineModel = {
  readonly status: StatusToken;
  /** One short sentence. Never the only carrier of the status — the word is. */
  readonly message: string;
  readonly hints: readonly KeyHint[];
};

/**
 * An entry in the palette and in help.
 *
 * Resolves a stable identity, never display text — `id` is what a dispatch and
 * an override reference, and the title is only what a person reads.
 *
 * `unavailableReason` is present and nullable rather than optional, and the
 * distinction is the whole honesty mechanism: `null` means the command runs,
 * and a string means it exists, is listed, is discoverable, and will tell you
 * what is missing instead of doing nothing when you press its key.
 */
export type CommandEntry = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** The key that runs it right now, or `null` when it has no default. */
  readonly binding: string | null;
  readonly unavailableReason: string | null;
};

export type HelpSection = {
  readonly title: string;
  readonly body: string;
};

/**
 * Which overlay is open.
 *
 * A closed union rather than a stack of arbitrary nodes: an overlay is a route,
 * and routes are named. Closing replaces the route, so a dismissed search or
 * inspection has nowhere to linger.
 */
export type OverlayRoute =
  | { readonly kind: "none" }
  | { readonly kind: "help" }
  /**
   * The palette, and what has been typed into it.
   *
   * The query lives on the route rather than beside it, which is what makes
   * "closing the palette clears the search" true by construction: closing
   * replaces the route, and there is nowhere left for a stale query to be.
   * State held alongside would have to be cleared by whoever remembered to,
   * and reopening onto somebody's last search is the failure that produces.
   *
   * A string because OpenTUI's `InputRenderable` owns the cursor, selection,
   * undo history, and editing actions. Falryn stores only the value needed to
   * filter commands; keeping a second editor state here would duplicate the
   * built-in control.
   */
  | { readonly kind: "palette"; readonly query: string }
  /**
   * Inspection of a selected transcript block.
   *
   * The key is the block's identity. Closing replaces the route, so there is
   * nowhere for a stale inspection to outlive the entry it named.
   */
  | { readonly kind: "inspect"; readonly key: string }
  /**
   * A focused confirmation over one immutable intent.
   *
   * The id is the bound confirmation's identity. Closing this route refuses;
   * a nested help or palette keeps the pending prompt and restores this route
   * when they close.
   */
  | { readonly kind: "confirm"; readonly id: string }
  /**
   * Session, model, context, or resource controls.
   *
   * The panel is which catalog is showing. Closing replaces the route, so a
   * dismissed picker has nowhere to linger. A nested help or palette over a
   * pending confirmation still restores that confirmation; this route is the
   * same class of transient overlay.
   */
  | {
      readonly kind: "controls";
      readonly panel: "session" | "model" | "context" | "resource";
    }
  /**
   * A code or diff artifact viewer.
   *
   * The id is the artifact being viewed. Layout and hunk index apply to diff
   * presentation only. Closing replaces the route, so a dismissed viewer has
   * nowhere to linger.
   */
  | {
      readonly kind: "artifact";
      readonly artifactId: string;
      readonly presentation: "code" | "diff";
      readonly layout: "unified" | "split";
      readonly hunkIndex: number;
    };

export function artifactOverlayRoute(
  artifactId: string,
  presentation: "code" | "diff",
): Extract<OverlayRoute, { readonly kind: "artifact" }> {
  return {
    kind: "artifact",
    artifactId,
    presentation,
    layout: "unified",
    hunkIndex: 0,
  };
}

export type ShellModel = {
  readonly header: WorkspaceHeaderModel;
  readonly status: StatusLineModel;
  readonly overlay: OverlayRoute;
  readonly commands: readonly CommandEntry[];
  readonly help: readonly HelpSection[];
  /**
   * The primary region's content.
   *
   * Required rather than optional, and a projection rather than a node. Since
   * #355 the transcript *is* the primary region: a shell with nothing in it
   * renders an empty transcript that names a command, which is a different and
   * better thing than a placeholder line saying nothing is running.
   */
  readonly transcript: TranscriptModel;
  /**
   * The composer's draft, phase, and declared gaps.
   *
   * Required rather than optional, like the transcript and for the same reason:
   * a shell always has a composer now, and a frame that could render without one
   * would be a frame with two arrangements to keep working.
   */
  readonly composer: ComposerModel;
  /**
   * What the runtime is doing.
   *
   * Required rather than optional, like the transcript and the composer. A shell
   * always has a runtime to describe — even when the honest description is that
   * nothing is attached, which is a different statement from nothing running.
   */
  readonly activity: ActivityModel;
};
