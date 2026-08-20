/**
 * The human and quiet projections of a `CommandResult`.
 *
 * One pure function from a result plus resolved terminal facts to text. It
 * opens nothing, reads nothing, holds no stream, and decides nothing about exit
 * status: it returns strings and `dispatch` writes them.
 *
 * Three rules it enforces rather than documents:
 *
 * - **stdout carries only the result.** Every function here returns two texts —
 *   the payload rendering, and everything that is a notice about it. Warnings,
 *   omissions, truncation notices, and rendered errors are the second one, in
 *   human mode too, because `falryn config show > file` must produce a file
 *   containing the configuration and nothing else.
 * - **Truncation is never silent, and never names a route this build does not
 *   honour.** Anything shortened reports what it dropped and how to see the
 *   rest. The only expansion route that exists in this build is `--verbose`; a
 *   run that is already verbose is told there is no wider form rather than
 *   being sent somewhere that does not answer.
 * - **Untrusted text is data.** Every value that came from a file, an
 *   environment variable, or a path goes through `sanitizeTerminalText` before
 *   it reaches a line. A configuration value carrying an escape sequence is
 *   rendered as those characters, never executed as terminal control.
 *
 * Plain text is not a second implementation: it is {@link renderPlainText},
 * which is this renderer with the colour level forced to `none`. Two answers to
 * what a result says drift, and then disagree in front of a user.
 */

// The label a source is named by, bounded by its own owner. Re-deriving it here
// would be a second answer to how long a path a diagnostic may print.
import { sourceLabel } from "../config/index.ts";
import {
  assertNever,
  type ColorLevel,
  type ConfigurationIssue,
  type ConfigurationValue,
  type EffectCertainty,
  type FalrynError,
  type InspectedValue,
  isUnreadSource,
  MAX_RELATED_ERRORS,
  recoveryForEffect,
  type SourceReport,
  type SymbolSupport,
  sanitizeTerminalText,
  type TerminalOutcome,
  type TerminalOutcomeKind,
  truncateToWidth,
  wrapToWidth,
} from "../domain/index.ts";
import type {
  ArtifactGetPayload,
  ArtifactListPayload,
  ArtifactShowPayload,
  DataRemovalPayload,
  DoctorPayload,
  ExportCommandPayload,
  RunCommandResult,
  SessionListPayload,
  SessionShowPayload,
} from "./commands.ts";
import type {
  CommandEffect,
  CommandOmission,
  CommandTruncation,
  CommandWarning,
} from "./result.ts";
import { MAX_WARNINGS } from "./result.ts";

/**
 * The layout width used when the handle reported none.
 *
 * This does not contradict the control that forbids `columns ?? 80` in
 * `domain/terminal.ts`: that control governs *deriving a fact* about a handle,
 * and a non-terminal treated as a narrow terminal is a fact that is wrong.
 * Choosing a width to lay text out in when nothing reported one is a rendering
 * decision, and this module is the one entitled to make it.
 */
export const DEFAULT_DISPLAY_COLUMNS = 80;

/** The narrowest width this renderer will lay out to. Narrower is clamped. */
export const MIN_DISPLAY_COLUMNS = 20;

/** The two texts one run produces, each destined for the handle that owns it. */
export type RenderedText = {
  /** The selected result format. Written to stdout. Empty when there is none. */
  readonly result: string;
  /** Status, warnings, notices, and errors. Written to stderr. */
  readonly diagnostics: string;
};

export type HumanRenderRequest = {
  readonly result: RunCommandResult;
  /** Already resolved against `--color` and the selected format by the caller. */
  readonly color: ColorLevel;
  readonly symbols: SymbolSupport;
  /** From `capabilities.stdout.columns`. `null` selects {@link DEFAULT_DISPLAY_COLUMNS}. */
  readonly columns: number | null;
  readonly verbose: boolean;
};

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How much of each list this renderer will show.
 *
 * Two sets rather than one scaled number, because `--verbose` is a real
 * expansion route and a route that only widened things a little would still
 * leave the reader without the answer they asked for.
 */
type DisplayBounds = {
  readonly values: number;
  readonly sources: number;
  readonly issues: number;
  readonly warnings: number;
  readonly omissions: number;
  readonly truncations: number;
  readonly errors: number;
  readonly related: number;
  /** Display width one rendered value may occupy before it is shortened. */
  readonly field: number;
};

const NORMAL_BOUNDS: DisplayBounds = {
  values: 40,
  sources: 20,
  issues: 10,
  warnings: 8,
  omissions: 8,
  truncations: 8,
  errors: 5,
  // Folded entirely when concise: a primary failure with its own detail is
  // what a reader needs first, and its companions are what `--verbose` is for.
  related: 0,
  field: 60,
};

const VERBOSE_BOUNDS: DisplayBounds = {
  values: 1_000,
  sources: 200,
  issues: 200,
  warnings: MAX_WARNINGS,
  omissions: 200,
  truncations: 200,
  errors: 100,
  related: MAX_RELATED_ERRORS,
  field: 400,
};

/* -------------------------------------------------------------------------- */
/* Style                                                                       */
/* -------------------------------------------------------------------------- */

/** Select Graphic Rendition sequences. Emitted only when colour is permitted. */
const SGR = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
} as const;

type Tone = "good" | "bad" | "warn" | "muted" | "plain";

const TONE_CODE: Readonly<Record<Tone, string>> = {
  good: SGR.green,
  bad: SGR.red,
  warn: SGR.yellow,
  muted: SGR.dim,
  plain: SGR.bold,
};

/**
 * The characters this renderer draws with.
 *
 * Every mark is paired with a word wherever it appears, so a terminal that
 * loses either the colour or the repertoire loses decoration rather than
 * meaning.
 */
type Glyphs = {
  readonly dash: string;
  readonly ellipsis: string;
  readonly completed: string;
  readonly failed: string;
  readonly cancelled: string;
  readonly timedOut: string;
  readonly uncertain: string;
  readonly warning: string;
  readonly omission: string;
  readonly note: string;
};

const UNICODE_GLYPHS: Glyphs = {
  dash: "—",
  ellipsis: "…",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
  timedOut: "⧖",
  uncertain: "?",
  warning: "!",
  omission: "~",
  note: "·",
};

const ASCII_GLYPHS: Glyphs = {
  dash: "--",
  ellipsis: "...",
  completed: "[ok]",
  failed: "[x]",
  cancelled: "[-]",
  timedOut: "[~]",
  uncertain: "[?]",
  warning: "[!]",
  omission: "[~]",
  note: "-",
};

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One render in progress.
 *
 * `shortened` is the only mutable thing here: a value trimmed to fit cannot
 * carry a sentence explaining itself, so the count is collected while the
 * payload is laid out and reported once, afterwards, as a notice.
 */
type Session = {
  readonly color: ColorLevel;
  readonly glyphs: Glyphs;
  readonly columns: number;
  readonly verbose: boolean;
  readonly bounds: DisplayBounds;
  /** Values this renderer shortened, for any reason. */
  shortened: number;
  /**
   * Values the concise *bound* shortened rather than the terminal's width.
   *
   * The two have different escapes, and only one of them is `--verbose`. A
   * value cut because the terminal is narrow is not made whole by a flag, and
   * offering one there would name a route that does not answer.
   */
  boundedByField: number;
};

function sessionFor(request: HumanRenderRequest): Session {
  return {
    color: request.color,
    glyphs: request.symbols === "unicode" ? UNICODE_GLYPHS : ASCII_GLYPHS,
    columns: layoutWidth(request.columns),
    verbose: request.verbose,
    bounds: request.verbose ? VERBOSE_BOUNDS : NORMAL_BOUNDS,
    shortened: 0,
    boundedByField: 0,
  };
}

/**
 * The width to lay out in.
 *
 * A handle that reported nothing gets the declared default; one that reported
 * something unusably narrow is clamped rather than looped on, because this is a
 * pure function and a zero would otherwise be a wrap that never terminates.
 */
function layoutWidth(columns: number | null): number {
  if (columns === null || !Number.isFinite(columns)) {
    return DEFAULT_DISPLAY_COLUMNS;
  }
  return Math.max(MIN_DISPLAY_COLUMNS, Math.floor(columns));
}

function paint(session: Session, tone: Tone, text: string): string {
  if (session.color === "none" || tone === "plain") {
    return text;
  }
  return `${TONE_CODE[tone]}${text}${SGR.reset}`;
}

/** One sentence laid out as however many lines the width allows. */
function sentence(session: Session, text: string, indent = ""): readonly string[] {
  return wrapToWidth(text, session.columns - indent.length).map((line) => `${indent}${line}`);
}

/**
 * A label with its text wrapped underneath it, aligned to the label's width.
 *
 * For a list that has to fit rather than be shortened: a class name cut in half
 * names nothing, while the same list over two lines still reads.
 */
function hanging(session: Session, label: string, text: string): readonly string[] {
  const continuation = " ".repeat(label.length);
  return wrapToWidth(text, session.columns - label.length).map(
    (line, index) => `${index === 0 ? label : continuation}${line}`,
  );
}

/** A value shortened to a width, counted so the run can say that it was. */
function fit(session: Session, text: string, width: number): string {
  const limit = Math.max(4, Math.min(width, session.bounds.field));
  const shortened = truncateToWidth(text, limit, session.glyphs.ellipsis);
  if (shortened !== text) {
    session.shortened += 1;
    if (session.bounds.field < width) {
      session.boundedByField += 1;
    }
  }
  return shortened;
}

function joinLines(lines: readonly string[]): string {
  return lines.join("\n");
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/* -------------------------------------------------------------------------- */
/* Bounded lists                                                               */
/* -------------------------------------------------------------------------- */

type Bounded<Item> = { readonly shown: readonly Item[]; readonly dropped: number };

function bound<Item>(items: readonly Item[], limit: number): Bounded<Item> {
  if (items.length <= limit) {
    return { shown: items, dropped: 0 };
  }
  return { shown: items.slice(0, Math.max(0, limit)), dropped: items.length - Math.max(0, limit) };
}

/**
 * What a shortened list says about what it dropped.
 *
 * Always names a route, and only one this build honours: `--verbose` while it
 * is unset, and an explicit statement that nothing wider exists once it is.
 */
function droppedNotice(session: Session, dropped: number, noun: string, shown: number): string {
  const what = `${shown} of ${shown + dropped} ${plural(shown + dropped, noun)}`;
  return session.verbose
    ? `Showing ${what}; this build has no wider form.`
    : `Showing ${what}; run with --verbose to see the rest.`;
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/** Concise terminal text, with ANSI only when the caller resolved colour on. */
export function renderHuman(request: HumanRenderRequest): RenderedText {
  const session = sessionFor(request);
  const { result } = request;
  const payload = renderPayload(session, result);

  const diagnostics: string[] = [
    ...statusLines(session, result.outcome, result.effect),
    ...payload.diagnostics,
    ...warningLines(session, result.warnings),
    ...omissionLines(session, result.omissions),
    ...declaredTruncationLines(session, result.truncation),
    ...errorLines(session, result.errors),
    // Last, and after everything that could shorten a value.
    ...shortenedLines(session),
  ];

  return { result: joinLines(payload.lines), diagnostics: joinLines(diagnostics) };
}

/**
 * The same rendering with no ANSI at all.
 *
 * For a log a person reads later, where the escape sequences are noise rather
 * than emphasis. It takes no colour because there is no colour to take.
 */
export function renderPlainText(request: Omit<HumanRenderRequest, "color">): RenderedText {
  return renderHuman({ ...request, color: "none" });
}

/**
 * Only the requested primary result.
 *
 * No headings, no labels, no warnings, and no colour. A failure is still
 * reported — through the exit status the caller resolves, and through stderr —
 * so quiet is not silent about failure, only about everything else.
 *
 * Nothing here is bounded: quiet's contract is the primary result, and a
 * shortened primary result is a different answer rather than a concise one.
 */
export function renderQuiet(result: RunCommandResult): RenderedText {
  return {
    result: joinLines(quietResultLines(result)),
    diagnostics: joinLines([...quietFindingLines(result), ...quietErrorLines(result.errors)]),
  };
}

/* -------------------------------------------------------------------------- */
/* Status and effect                                                           */
/* -------------------------------------------------------------------------- */

type OutcomePresentation = { readonly word: string; readonly tone: Tone };

const OUTCOME_PRESENTATION: Readonly<Record<TerminalOutcomeKind, OutcomePresentation>> = {
  completed: { word: "Completed", tone: "good" },
  failed: { word: "Failed", tone: "bad" },
  cancelled: { word: "Cancelled", tone: "warn" },
  "timed-out": { word: "Timed out", tone: "warn" },
  uncertain: { word: "Uncertain", tone: "warn" },
};

function outcomeMark(session: Session, kind: TerminalOutcomeKind): string {
  switch (kind) {
    case "completed":
      return session.glyphs.completed;
    case "failed":
      return session.glyphs.failed;
    case "cancelled":
      return session.glyphs.cancelled;
    case "timed-out":
      return session.glyphs.timedOut;
    case "uncertain":
      return session.glyphs.uncertain;
    default:
      return assertNever(kind, "unhandled terminal outcome kind");
  }
}

/**
 * What was observed about the world outside Falryn.
 *
 * Rendered as its own clause rather than folded into the outcome word, because
 * "cancelled" and "cancelled, and something may have changed" are different
 * answers and a reader who acts on the first when the second was true retries
 * something that already happened.
 */
const OBSERVED_CLAUSE: Readonly<Record<EffectCertainty, string>> = {
  none: "nothing outside Falryn changed.",
  completed: "the change was applied.",
  partial: "part of the change was applied, so inspect before retrying.",
  uncertain: "whether anything changed could not be observed, so inspect before retrying.",
};

function effectSentence(effect: CommandEffect): string {
  const intent = effect.intent === "none" ? "Read-only" : "A change was requested";
  return `${intent}; ${OBSERVED_CLAUSE[effect.observed]}`;
}

/**
 * The one line that says how the command ended.
 *
 * Written on every run, including a clean one. A surface that says nothing when
 * it succeeded leaves "it worked" and "it produced nothing" looking alike.
 */
function statusLines(
  session: Session,
  outcome: TerminalOutcome,
  effect: CommandEffect,
): readonly string[] {
  const presentation = OUTCOME_PRESENTATION[outcome.kind];
  const mark = outcomeMark(session, outcome.kind);
  const head = paint(session, presentation.tone, `${mark} ${presentation.word}.`);
  return sentence(session, `${head} ${effectSentence(effect)}`);
}

/* -------------------------------------------------------------------------- */
/* Notices                                                                     */
/* -------------------------------------------------------------------------- */

function warningLines(session: Session, warnings: readonly CommandWarning[]): readonly string[] {
  if (warnings.length === 0) {
    return [];
  }
  const { shown, dropped } = bound(warnings, session.bounds.warnings);
  const lines = shown.flatMap((warning) =>
    sentence(
      session,
      `${paint(session, "warn", session.glyphs.warning)} ${safe(warning.message)} (${safe(warning.code)})`,
    ),
  );
  return dropped === 0
    ? lines
    : [...lines, ...sentence(session, droppedNotice(session, dropped, "warning", shown.length))];
}

/**
 * What the command itself declared it left out.
 *
 * Kept distinct from anything this renderer shortened: one is a statement about
 * the answer, the other is a statement about the display of it, and a reader
 * who confuses them either re-runs for nothing or trusts an incomplete answer.
 */
function omissionLines(session: Session, omissions: readonly CommandOmission[]): readonly string[] {
  if (omissions.length === 0) {
    return [];
  }
  const { shown, dropped } = bound(omissions, session.bounds.omissions);
  const lines = shown.flatMap((omission) => {
    const count =
      omission.count === null
        ? "an unknown number of items"
        : `${omission.count} item${omission.count === 1 ? "" : "s"}`;
    return sentence(
      session,
      `${session.glyphs.omission} The command left out ${count}: ${safe(omission.message)} (${safe(omission.code)})`,
    );
  });
  return dropped === 0
    ? lines
    : [...lines, ...sentence(session, droppedNotice(session, dropped, "omission", shown.length))];
}

function declaredTruncationLines(
  session: Session,
  truncation: readonly CommandTruncation[],
): readonly string[] {
  if (truncation.length === 0) {
    return [];
  }
  const { shown, dropped } = bound(truncation, session.bounds.truncations);
  const lines = shown.flatMap((entry) => {
    const route =
      entry.expansion === null
        ? "This build offers no way to see the rest."
        : `Run '${safe(entry.expansion)}' to see the rest.`;
    return sentence(
      session,
      `${session.glyphs.omission} The command summarized ${safe(entry.of)}: ${entry.shown} of ${entry.total} shown. ${route}`,
    );
  });
  return dropped === 0
    ? lines
    : [...lines, ...sentence(session, droppedNotice(session, dropped, "summary", shown.length))];
}

/** What this renderer shortened to fit, said once rather than per value. */
function shortenedLines(session: Session): readonly string[] {
  if (session.shortened === 0) {
    return [];
  }
  const what = `${session.shortened} ${plural(session.shortened, "value")}`;
  const shortenedVerb = plural(session.shortened, "was", "were");
  const route =
    !session.verbose && session.boundedByField > 0
      ? `run with --verbose to see ${plural(session.shortened, "it", "them")} in full.`
      : `a wider terminal shows more of ${plural(session.shortened, "it", "them")}.`;
  return sentence(
    session,
    `${session.glyphs.note} ${what} did not fit and ${shortenedVerb} shortened; ${route}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

function errorLines(session: Session, errors: readonly FalrynError[]): readonly string[] {
  if (errors.length === 0) {
    return [];
  }
  const { shown, dropped } = bound(errors, session.bounds.errors);
  const lines = shown.flatMap((error) => renderError(session, error, ""));
  return dropped === 0
    ? lines
    : [...lines, ...sentence(session, droppedNotice(session, dropped, "failure", shown.length))];
}

function renderError(session: Session, error: FalrynError, indent: string): readonly string[] {
  const detail = `${indent}  `;
  const lines: string[] = [
    ...sentence(
      session,
      `${paint(session, "bad", session.glyphs.failed)} ${safe(error.message)}`,
      indent,
    ),
    ...sentence(
      session,
      `${safe(error.code)} ${session.glyphs.dash} ${safe(error.category)} ${session.glyphs.dash} ${OBSERVED_CLAUSE[error.effect]}`,
      detail,
    ),
  ];

  // The error's own actions when it declared any, and the effect's documented
  // recovery when it did not. Neither is rewritten here: this module consumes
  // the runtime's recovery table rather than writing a second one.
  const recovery = error.recovery.length > 0 ? error.recovery : recoveryForEffect(error.effect);
  if (recovery.length > 0) {
    lines.push(...sentence(session, `Recovery: ${recovery.join(", ")}`, detail));
  }

  if (!error.recognized) {
    lines.push(
      ...sentence(
        session,
        "This build did not recognize this failure; it is reported exactly as observed.",
        detail,
      ),
    );
  }

  if (error.related.length > 0) {
    const { shown, dropped } = bound(error.related, session.bounds.related);
    for (const related of shown) {
      lines.push(...renderError(session, related, detail));
    }
    if (dropped > 0) {
      lines.push(
        ...sentence(
          session,
          session.verbose
            ? `${dropped} further ${plural(dropped, "failure")} accompanied this one; this build has no wider form.`
            : `${dropped} further ${plural(dropped, "failure")} accompanied this one; run with --verbose to see ${plural(dropped, "it", "them")}.`,
          detail,
        ),
      );
    }
  }

  if (error.relatedDropped > 0) {
    lines.push(
      ...sentence(
        session,
        `${error.relatedDropped} accompanying ${plural(error.relatedDropped, "failure")} ${plural(error.relatedDropped, "was", "were")} not kept.`,
        detail,
      ),
    );
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/* Payloads                                                                    */
/* -------------------------------------------------------------------------- */

type RenderedPayload = {
  /** The result text, destined for stdout. */
  readonly lines: readonly string[];
  /** What this command found that a reader needs and stdout must not carry. */
  readonly diagnostics: readonly string[];
};

function renderPayload(session: Session, result: RunCommandResult): RenderedPayload {
  switch (result.command) {
    case "config.show":
      return renderConfigShow(session, result.payload);
    case "config.validate":
      return renderConfigValidate(session, result.payload);
    case "config.path":
      return renderConfigPath(session, result.payload);
    case "data.reset":
    case "data.uninstall":
      return renderDataRemoval(session, result.payload);
    case "doctor":
      return renderDoctor(session, result.payload);
    case "export":
      return renderExport(session, result.payload);
    case "session.list":
      return renderSessionList(session, result.payload);
    case "session.show":
      return renderSessionShow(session, result.payload);
    case "artifact.list":
      return renderArtifactList(session, result.payload);
    case "artifact.show":
      return renderArtifactShow(session, result.payload);
    case "artifact.get":
      return renderArtifactGet(session, result.payload);
    default:
      return assertNever(result, "unhandled command result");
  }
}

function renderExport(session: Session, payload: ExportCommandPayload | null): RenderedPayload {
  if (payload === null) {
    return { lines: ["No export inventory is available."], diagnostics: [] };
  }

  const lines = [
    paint(session, "plain", payload.mode === "preview" ? "Export preview" : "Export written"),
    `  Selection     ${safe(payload.selection.kind)}  ${payload.selection.sessions} sessions` +
      (payload.selection.includesSensitive ? "  includes-sensitive" : ""),
    `  Sessions      ${payload.sessionIds.map(safe).join(", ") || "(none)"}`,
    `  Counts        sessions=${payload.counts.sessions} turns=${payload.counts.turns} events=${payload.counts.events} artifacts=${payload.counts.artifacts}`,
    `  Artifact bytes ${payload.artifactBytes}`,
  ];
  if (payload.omissions.length > 0) {
    lines.push("  Omissions");
    for (const omission of payload.omissions) {
      lines.push(`    ${safe(omission.artifactId)}  ${safe(omission.reason)}`);
    }
  }
  if (payload.redactions.length > 0) {
    lines.push("  Redactions");
    for (const redaction of payload.redactions) {
      lines.push(`    ${safe(redaction.path)}  ${safe(redaction.kind)}`);
    }
  }
  if (payload.bundle !== null) {
    lines.push(`  Bundle        ${safe(payload.bundle.name)}`);
    lines.push(`  Path          ${safe(payload.bundle.path)}`);
    lines.push(`  Bytes         ${payload.bundle.byteLength}`);
    if (payload.bundle.cancelledAfterFinalize) {
      lines.push("  Note          cancelled after the package was published");
    }
  }

  const diagnostics =
    payload.mode === "preview"
      ? ["Preview only. Re-run with --write --name <name> to create this package."]
      : [];
  return { lines, diagnostics };
}

function renderSessionList(session: Session, payload: SessionListPayload | null): RenderedPayload {
  if (payload === null) {
    return { lines: ["No session catalog is available."], diagnostics: [] };
  }
  if (payload.sessions.length === 0) {
    return { lines: ["No sessions."], diagnostics: [] };
  }
  const lines = [
    paint(session, "plain", `Sessions (${payload.filter})`),
    ...payload.sessions.map((entry) => {
      const title = entry.title === null ? "(untitled)" : safe(entry.title);
      const pin = entry.pinned ? "  pinned" : "";
      const closed = entry.closedAt === null ? "open" : "closed";
      return `  ${safe(entry.sessionId)}  ${closed}${pin}  ${title}`;
    }),
  ];
  return { lines, diagnostics: [] };
}

function renderSessionShow(session: Session, payload: SessionShowPayload | null): RenderedPayload {
  if (payload === null) {
    return { lines: ["No session is available."], diagnostics: [] };
  }
  const entry = payload.session;
  const title = entry.title === null ? "(untitled)" : safe(entry.title);
  return {
    lines: [
      paint(session, "plain", "Session"),
      `  Identity     ${safe(entry.sessionId)}`,
      `  Workspace    ${safe(payload.workspaceId)}`,
      `  Title        ${title}`,
      `  Pinned       ${entry.pinned ? "yes" : "no"}`,
      `  Started      ${safe(entry.startedAt)}`,
      `  Closed       ${entry.closedAt === null ? "(open)" : safe(entry.closedAt)}`,
    ],
    diagnostics: [],
  };
}

function renderArtifactList(
  session: Session,
  payload: ArtifactListPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No artifact catalog is available."], diagnostics: [] };
  }
  if (payload.artifacts.length === 0) {
    return { lines: ["No artifacts."], diagnostics: [] };
  }
  const lines = [
    paint(session, "plain", "Artifacts"),
    ...payload.artifacts.map(
      (entry) =>
        `  ${safe(entry.artifactId)}  ${safe(entry.availability)}  ${safe(entry.mediaType)}  ${entry.byteLength} bytes`,
    ),
  ];
  return { lines, diagnostics: [] };
}

function renderArtifactShow(
  session: Session,
  payload: ArtifactShowPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No artifact is available."], diagnostics: [] };
  }
  const record = payload.lineage.record;
  return {
    lines: [
      paint(session, "plain", "Artifact"),
      `  Identity     ${safe(record.artifactId)}`,
      `  Media type   ${safe(record.mediaType)}`,
      `  Bytes        ${record.byteLength}`,
      `  Availability ${safe(record.availability)}`,
      `  Sensitivity  ${safe(record.sensitivity)}`,
      `  Parents      ${payload.lineage.parents.length}`,
      `  Children     ${payload.lineage.children.length}`,
    ],
    diagnostics: [],
  };
}

function renderArtifactGet(session: Session, payload: ArtifactGetPayload | null): RenderedPayload {
  if (payload === null) {
    return { lines: ["No artifact retrieval is available."], diagnostics: [] };
  }
  const destination =
    payload.destination === "stdout"
      ? "stdout"
      : payload.path === null
        ? "file"
        : safe(payload.path);
  return {
    lines: [
      paint(session, "plain", "Artifact retrieved"),
      `  Identity     ${safe(payload.artifactId)}`,
      `  Destination  ${destination}`,
      `  Bytes        ${payload.bytesWritten}`,
    ],
    diagnostics:
      payload.destination === "stdout"
        ? ["Artifact bytes were written to stdout; this summary is on stderr."]
        : [],
  };
}

function renderDataRemoval(session: Session, payload: DataRemovalPayload | null): RenderedPayload {
  if (payload === null) {
    return { lines: ["No local-data plan is available."], diagnostics: [] };
  }

  const lines = [
    paint(session, "plain", `Local data ${payload.plan.kind} plan`),
    `  Plan identity  ${safe(payload.plan.planId)}`,
    `  Total          ${payload.plan.totalBytes} bytes in ${payload.plan.totalItems} items (${payload.plan.completeness})`,
    "  Classes",
  ];
  for (const entry of payload.plan.classes) {
    const owner = entry.owner === null ? "unregistered" : safe(entry.owner);
    lines.push(
      `    ${safe(entry.ownershipClass)}  ${entry.action}  ${owner}  ${entry.byteCount} bytes  ${entry.itemCount} items`,
    );
    for (const path of entry.paths) {
      // A removal preview must retain every exact path; an over-wide terminal
      // line is more honest than a truncated path that looks executable.
      lines.push(`      ${safe(path)}`);
    }
  }
  lines.push(`  Out of scope  ${payload.plan.outOfScope.map(safe).join(", ")}`);

  if (payload.execution !== null) {
    lines.push(`  Execution     ${payload.confirmation}; ${payload.execution.completeness}`);
    for (const path of payload.execution.deleted) {
      lines.push(`    deleted  ${safe(path)}`);
    }
    for (const retained of payload.execution.retained) {
      lines.push(`    retained ${safe(retained.reason)}  ${safe(retained.path)}`);
    }
    for (const failed of payload.execution.failed) {
      lines.push(`    failed   ${safe(failed.code)}  ${safe(failed.path)}`);
    }
  }

  const diagnostics =
    payload.confirmation === "not-requested"
      ? [
          `Preview only. Re-run with --confirm ${safe(payload.plan.planId)} to apply this exact plan.`,
        ]
      : [];
  return { lines, diagnostics };
}

/** Text from outside Falryn, rendered as data rather than as terminal control. */
function safe(text: string): string {
  return sanitizeTerminalText(text);
}

/** One configuration value as a person reads it. */
function displayValue(value: ConfigurationValue): string {
  return typeof value === "string" ? safe(value) : safe(JSON.stringify(value) ?? "null");
}

function renderConfigShow(
  session: Session,
  payload: Extract<RunCommandResult, { command: "config.show" }>["payload"],
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No configuration to show."], diagnostics: [] };
  }

  const diagnostics: string[] = [
    // Advisory here, and blocking in `config validate`. The values below did
    // load and displaying them is this command's purpose, so it still exits
    // `0` — but a reader must not be left thinking they are the whole story.
    ...unreadSourceFindings(payload.inspection.sources).flatMap((finding) =>
      sentence(session, `${paint(session, "warn", session.glyphs.warning)} ${finding}`),
    ),
  ];
  if (!payload.usable) {
    diagnostics.push(
      ...sentence(
        session,
        `${session.glyphs.warning} These values are the last configuration that loaded; this run's sources were refused.`,
      ),
    );
  }

  const values = payload.inspection.values;
  if (values.length === 0) {
    return { lines: ["No configuration values are set."], diagnostics };
  }

  const { shown, dropped } = bound(values, session.bounds.values);
  const pathWidth = Math.max(...shown.map((value) => value.path.length));
  const lines = [
    paint(session, "plain", `Configuration (generation ${payload.inspection.generation})`),
    ...shown.map((value) => valueLine(session, value, pathWidth)),
  ];
  if (dropped > 0) {
    diagnostics.push(...sentence(session, droppedNotice(session, dropped, "value", shown.length)));
  }
  return { lines, diagnostics };
}

function valueLine(session: Session, value: InspectedValue, pathWidth: number): string {
  const prefix = `  ${value.path.padEnd(pathWidth)} = `;
  const suffix = `  ${paint(session, "muted", `[${value.source.kind}]`)}`;
  // The source annotation is dropped rather than shortened when the width
  // cannot hold both: a truncated source kind names a layer that does not
  // exist, and the value is what was asked for.
  const room = session.columns - prefix.length - (value.source.kind.length + 4);
  if (room < 8) {
    return `${prefix}${fit(session, displayValue(value.value), Math.max(4, session.columns - prefix.length))}`;
  }
  return `${prefix}${fit(session, displayValue(value.value), room)}${suffix}`;
}

function renderConfigPath(
  session: Session,
  payload: Extract<RunCommandResult, { command: "config.path" }>["payload"],
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No configuration sources to report."], diagnostics: [] };
  }
  if (payload.sources.length === 0) {
    return { lines: ["No configuration sources resolve for this invocation."], diagnostics: [] };
  }

  const { shown, dropped } = bound(payload.sources, session.bounds.sources);
  const kindWidth = Math.max(...shown.map((source) => source.kind.length));
  const lines = [
    paint(session, "plain", "Configuration sources, in precedence order:"),
    ...shown.map((source) => {
      const prefix = `  ${safe(source.kind).padEnd(kindWidth)}  `;
      return `${prefix}${fit(session, safe(source.path), session.columns - prefix.length)}`;
    }),
  ];
  const diagnostics =
    dropped === 0 ? [] : sentence(session, droppedNotice(session, dropped, "source", shown.length));
  return { lines, diagnostics };
}

function renderConfigValidate(
  session: Session,
  payload: Extract<RunCommandResult, { command: "config.validate" }>["payload"],
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No validation verdict is available."], diagnostics: [] };
  }

  const count = payload.issues.length;
  const unread = payload.unreadSources.length;
  const lines = !payload.valid
    ? [
        paint(
          session,
          "bad",
          `${session.glyphs.failed} Configuration is not usable: ${count} ${plural(count, "issue")}.`,
        ),
      ]
    : unread > 0
      ? // Never "valid" here. The values that loaded are usable, and they are
        // not the ones the user wrote — which is the question this command was
        // asked, so it answers it rather than the easier one.
        [
          paint(
            session,
            "bad",
            `${session.glyphs.failed} Configuration loaded without ${unread} ${plural(unread, "source")} that could not be read.`,
          ),
        ]
      : [paint(session, "good", `${session.glyphs.completed} Configuration is valid.`)];

  const { shown, dropped } = bound(payload.issues, session.bounds.issues);
  const diagnostics = [
    ...unreadSourceFindings(payload.unreadSources).flatMap((finding) =>
      sentence(session, `${paint(session, "bad", session.glyphs.failed)} ${finding}`),
    ),
    ...shown.flatMap((issue) => issueLines(session, issue)),
  ];
  if (dropped > 0) {
    diagnostics.push(...sentence(session, droppedNotice(session, dropped, "issue", shown.length)));
  }
  return { lines, diagnostics };
}

/**
 * What each skipped source says, in one sentence.
 *
 * The path and the outcome, and nothing else. No byte of the document appears:
 * `unreadable` and `oversized` produced none, and `malformed-encoding` produced
 * exactly the bytes a diagnostic must not echo. The list is bounded by the
 * session's own source bound rather than by how many files happened to fail.
 */
function unreadSourceFindings(sources: readonly SourceReport[]): readonly string[] {
  const unread = sources.filter(isUnreadSource);
  // The concise bound, in every projection including quiet: there are six
  // layers and at most four of them read a file, so this never truncates a real
  // run — it bounds a payload that arrived from somewhere else.
  const { shown, dropped } = bound(unread, NORMAL_BOUNDS.sources);
  const findings = shown.map(
    (report) => `The ${report.source.kind} configuration source ${skipSentence(report)}`,
  );
  if (dropped > 0) {
    findings.push(
      `${dropped} further unread ${plural(dropped, "source")} ${plural(dropped, "was", "were")} not listed.`,
    );
  }
  return findings;
}

function skipSentence(report: SourceReport): string {
  const where = safe(sourceLabel(report.source));
  switch (report.outcome) {
    case "oversized":
      return `is larger than this build reads and was skipped: ${where}.`;
    case "malformed-encoding":
      return `is not valid UTF-8 text and was skipped: ${where}.`;
    default:
      return `could not be read and was skipped: ${where}.`;
  }
}

function issueLines(session: Session, issue: ConfigurationIssue): readonly string[] {
  const mark =
    issue.severity === "error"
      ? paint(session, "bad", session.glyphs.failed)
      : paint(session, "warn", session.glyphs.warning);
  return sentence(session, `${mark} ${safe(issue.path)}: ${issueSentence(issue)}`);
}

/**
 * What one configuration issue says.
 *
 * Exhaustive over the vocabulary, so an issue kind added later fails to compile
 * here rather than rendering as a bare code a reader cannot act on. None of
 * these quotes the rejected value: the issue never carries it, which is what
 * makes a malformed configuration safe to paste into a bug report.
 */
function issueSentence(issue: ConfigurationIssue): string {
  switch (issue.kind) {
    case "unknown-key":
      return "no setting by this name exists.";
    case "invalid-type":
      return `expected ${issue.expected}.`;
    case "out-of-range": {
      const unit = issue.unit === null ? "" : ` ${issue.unit}`;
      const low = issue.minimum === null ? "" : `at least ${issue.minimum}${unit}`;
      const high = issue.maximum === null ? "" : `at most ${issue.maximum}${unit}`;
      const bounds = [low, high].filter((part) => part !== "").join(" and ");
      return bounds === "" ? "out of range." : `must be ${bounds}.`;
    }
    case "invalid-value":
      return `must be one of ${issue.allowed.map(safe).join(", ")}.`;
    case "scope-unavailable":
      return `cannot be set from ${issue.scope}; it may be set from ${issue.availableScopes.join(", ")}.`;
    case "duplicate-identity":
      return `two entries share the same ${safe(issue.identityField)}.`;
    case "cross-field-conflict":
      return `conflicts with ${issue.relatedPaths.map(safe).join(", ")} (${safe(issue.rule)}).`;
    case "plaintext-credential":
      return `holds a secret directly; use a reference to ${issue.expectedStoreKinds.join(" or ")} instead.`;
    case "invalid-schema-version":
      return "the schema version is not a version this build can read.";
    case "unsupported-schema-version":
      return `was written for schema ${issue.observedSchemaVersion}; this build reads ${issue.minimumCompatibleVersion} through ${issue.readerSchemaVersion}.`;
    case "retired-schema-version":
      return `was written for schema ${issue.observedSchemaVersion}; this build no longer reads anything below ${issue.minimumSupportedVersion}.`;
    case "alias-resolved":
      return `is an old spelling of ${safe(issue.canonical)} and was read as it.`;
    case "deprecated-key": {
      const removal =
        issue.removedInSchemaVersion === null
          ? ""
          : ` It is removed in schema ${issue.removedInSchemaVersion}.`;
      return issue.replacement === null
        ? `is deprecated.${removal}`
        : `is deprecated; use ${safe(issue.replacement)}.${removal}`;
    }
    case "ignored-forward-key":
      return `comes from schema ${issue.observedSchemaVersion} and was ignored, because this build reads schema ${issue.readerSchemaVersion}.`;
    default:
      return assertNever(issue, "unhandled configuration issue");
  }
}

function storageSentence(storage: DoctorPayload["storage"]): string {
  switch (storage.kind) {
    case "undetermined":
      // Never "no database yet". That sentence is exactly the false comfort
      // this state exists to withhold when the state root cannot be reached.
      return "not determined, because the state root cannot hold data";
    case "absent":
      return "no database has been created yet";
    case "present":
      return `schema ${storage.schemaVersion} of ${storage.expectedVersion}, ${storage.current ? "current" : "not current"}`;
    case "unreadable":
      return `unreadable (${safe(storage.code)})`;
    default:
      return assertNever(storage, "unhandled storage probe");
  }
}

function renderDoctor(
  session: Session,
  payload: Extract<RunCommandResult, { command: "doctor" }>["payload"],
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No diagnostics could be collected."], diagnostics: [] };
  }

  const rootWidth = Math.max(...payload.roots.map((entry) => entry.root.length));
  const lines = [
    paint(session, "plain", "Falryn diagnostics"),
    `  Build      ${safe(payload.build.platform)} ${safe(payload.build.architecture)}`,
    "  Data roots",
    ...payload.roots.map((entry) => {
      const prefix = `    ${entry.root.padEnd(rootWidth)}  `;
      const where = entry.path === null ? "unresolved" : safe(entry.path);
      // The viability word is always shown, so `ready` and `absent` are told
      // apart at a glance rather than by the absence of a complaint.
      const note =
        entry.code === null ? entry.viability : `${entry.viability}: ${safe(entry.code)}`;
      const state = `${where}  [${note}]`;
      return `${prefix}${fit(session, state, session.columns - prefix.length)}`;
    }),
    `  Database   ${fit(session, payload.databasePath === null ? "no path could be resolved" : safe(payload.databasePath), session.columns - 13)}`,
    `             ${storageSentence(payload.storage)}`,
    ...hanging(
      session,
      "  Ownership  ",
      `registered: ${payload.registeredClasses.length === 0 ? "none" : payload.registeredClasses.join(", ")}`,
    ),
    ...hanging(
      session,
      "             ",
      `unregistered: ${payload.unregisteredClasses.length === 0 ? "none" : payload.unregisteredClasses.join(", ")}`,
    ),
  ];

  return {
    lines,
    diagnostics: doctorFindings(payload).flatMap((finding) =>
      sentence(session, `${paint(session, "warn", session.glyphs.warning)} ${finding}`),
    ),
  };
}

/**
 * What `doctor` found that is worth a reader's attention.
 *
 * Separated from the report so quiet mode can emit exactly these and nothing
 * else: under `--format quiet` the verdict is the exit status and the findings
 * are what stderr carries.
 */
function doctorFindings(payload: DoctorPayload): readonly string[] {
  const findings: string[] = [];
  for (const entry of payload.roots) {
    if (!entry.resolved) {
      findings.push(`The ${entry.root} data root did not resolve to a path.`);
      continue;
    }
    // `absent` is deliberately not a finding: the first run that needs the
    // root creates it, and reporting a fresh machine as faulty would train a
    // reader to ignore the findings that matter.
    if (entry.viability === "blocked") {
      findings.push(
        `The ${entry.root} data root cannot hold data (${safe(entry.code ?? "blocked")}).`,
      );
    }
    if (entry.viability === "unknown") {
      findings.push(
        `The ${entry.root} data root could not be checked (${safe(entry.code ?? "unknown")}).`,
      );
    }
    if (entry.viability === "ready" && entry.code === "insecure-permissions") {
      findings.push(`The ${entry.root} data root is readable by other users on this machine.`);
    }
  }
  for (const issue of payload.rootIssues) {
    findings.push(`A data-root override was refused (${safe(issue)}).`);
  }
  if (payload.storage.kind === "undetermined") {
    findings.push(
      "Whether a database exists could not be determined, because the state root cannot hold data.",
    );
  }
  if (payload.storage.kind === "unreadable") {
    findings.push(`The database could not be read (${safe(payload.storage.code)}).`);
  }
  if (payload.storage.kind === "present" && !payload.storage.current) {
    findings.push(
      `The database is at schema ${payload.storage.schemaVersion}; this build expects ${payload.storage.expectedVersion}.`,
    );
  }
  if (payload.unregisteredClasses.length > 0) {
    findings.push(
      `${payload.unregisteredClasses.length} ownership ${plural(payload.unregisteredClasses.length, "class", "classes")} ${plural(payload.unregisteredClasses.length, "has", "have")} no owner: ${payload.unregisteredClasses.join(", ")}.`,
    );
  }
  return findings;
}

/* -------------------------------------------------------------------------- */
/* Quiet                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The primary result of each command, and nothing else.
 *
 * `config.validate` and `doctor` have no primary result to print: their verdict
 * is the exit status. Emitting a word there would make quiet a third human
 * format instead of the machine-adjacent one it is.
 */
function quietResultLines(result: RunCommandResult): readonly string[] {
  switch (result.command) {
    case "config.show":
      return result.payload === null
        ? []
        : result.payload.inspection.values
            .filter((value) => value.value !== null)
            .map((value) => `${value.path}=${displayValue(value.value)}`);
    case "config.path":
      return result.payload === null
        ? []
        : result.payload.sources.map((source) => safe(source.path));
    case "data.reset":
    case "data.uninstall":
      return quietDataLines(result.payload);
    case "config.validate":
    case "doctor":
      return [];
    case "export":
      return quietExportLines(result.payload);
    case "session.list":
      return result.payload === null
        ? []
        : result.payload.sessions.map((entry) => safe(entry.sessionId));
    case "session.show":
      return result.payload === null ? [] : [safe(result.payload.session.sessionId)];
    case "artifact.list":
      return result.payload === null
        ? []
        : result.payload.artifacts.map((entry) => safe(entry.artifactId));
    case "artifact.show":
      return result.payload === null ? [] : [safe(result.payload.lineage.record.artifactId)];
    case "artifact.get":
      return result.payload === null
        ? []
        : [
            [
              safe(result.payload.artifactId),
              result.payload.destination,
              result.payload.path === null ? "" : safe(result.payload.path),
              String(result.payload.bytesWritten),
            ].join("\t"),
          ];
    default:
      return assertNever(result, "unhandled command result");
  }
}

function quietExportLines(payload: ExportCommandPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  if (payload.bundle !== null) {
    return [
      [
        payload.mode,
        safe(payload.bundle.name),
        safe(payload.bundle.path),
        String(payload.bundle.byteLength),
      ].join("\t"),
    ];
  }
  return payload.sessionIds.map((id) => safe(id));
}

function quietDataLines(payload: DataRemovalPayload | null): readonly string[] {
  if (payload === null) {
    return [];
  }
  const plan = payload.plan.classes.flatMap((entry) =>
    entry.paths.length === 0
      ? [
          [
            safe(payload.plan.planId),
            safe(entry.ownershipClass),
            entry.action,
            String(entry.byteCount),
            String(entry.itemCount),
            "",
          ].join("\t"),
        ]
      : entry.paths.map((path) =>
          [
            safe(payload.plan.planId),
            safe(entry.ownershipClass),
            entry.action,
            String(entry.byteCount),
            String(entry.itemCount),
            safe(path),
          ].join("\t"),
        ),
  );
  if (payload.execution === null) {
    return plan;
  }
  return [
    ...plan,
    ...payload.execution.deleted.map((path) => `deleted\t${safe(path)}`),
    ...payload.execution.retained.map(
      (entry) => `retained\t${safe(entry.reason)}\t${safe(entry.path)}`,
    ),
    ...payload.execution.failed.map((entry) => `failed\t${safe(entry.code)}\t${safe(entry.path)}`),
  ];
}

/** What quiet mode still reports on stderr: the findings behind the verdict. */
function quietFindingLines(result: RunCommandResult): readonly string[] {
  switch (result.command) {
    case "config.validate":
      return result.payload === null
        ? []
        : [
            ...unreadSourceFindings(result.payload.unreadSources),
            ...result.payload.issues.map(
              (issue) => `${issue.severity}: ${safe(issue.path)}: ${issueSentence(issue)}`,
            ),
          ];
    case "doctor":
      return result.payload === null ? [] : doctorFindings(result.payload);
    case "data.reset":
    case "data.uninstall":
      return [];
    case "config.show":
      // Quiet still reports a source that was skipped. `config show` prints the
      // values it has; stderr is where the reader is told those values are not
      // the whole of what they wrote.
      return result.payload === null ? [] : unreadSourceFindings(result.payload.inspection.sources);
    case "config.path":
      return [];
    case "export":
      return [];
    case "session.list":
      return result.payload === null || result.payload.omitted === 0
        ? []
        : [`omitted ${result.payload.omitted} sessions`];
    case "session.show":
      return [];
    case "artifact.list":
      return result.payload === null || result.payload.omitted === 0
        ? []
        : [`omitted ${result.payload.omitted} artifacts`];
    case "artifact.show":
    case "artifact.get":
      return [];
    default:
      return assertNever(result, "unhandled command result");
  }
}

function quietErrorLines(errors: readonly FalrynError[]): readonly string[] {
  return errors.map((error) => `error: ${safe(error.code)}: ${safe(error.message)}`);
}
