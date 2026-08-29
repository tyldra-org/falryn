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

import {
  assertNever,
  type EffectCertainty,
  type FalrynError,
  recoveryForEffect,
  type TerminalOutcome,
  type TerminalOutcomeKind,
} from "../domain/index.ts";
import type { RunCommandResult } from "./commands.ts";
import {
  doctorFindings,
  issueSentence,
  renderConfigPath,
  renderConfigSet,
  renderConfigShow,
  renderConfigValidate,
  renderDoctor,
  unreadSourceFindings,
} from "./render-human/configuration.ts";
import {
  renderDataBackup,
  renderDataDiagnostics,
  renderDataGc,
  renderDataInspect,
  renderDataRemoval,
  renderDataRestore,
  renderDataRetention,
} from "./render-human/data.ts";
import {
  renderArtifactGet,
  renderArtifactList,
  renderArtifactShow,
  renderExport,
  renderImport,
  renderReplay,
  renderSessionFork,
  renderSessionList,
  renderSessionReplay,
  renderSessionResume,
  renderSessionShow,
} from "./render-human/history.ts";
import type { RenderedPayload } from "./render-human/payload.ts";
import { renderCodingRun, renderProviderConnections } from "./render-human/product.ts";
import { quietResultLines } from "./render-human/quiet.ts";
import {
  bound,
  droppedNotice,
  type HumanRenderRequest,
  joinLines,
  paint,
  plural,
  type RenderedText,
  type Session,
  sentence,
  sessionFor,
  type Tone,
} from "./render-human/session.ts";
import {
  renderTaskCommitPlan,
  renderTaskDecompose,
  renderTaskProgress,
  renderTaskValidate,
} from "./render-human/tasks.ts";
import { safe } from "./render-human/text.ts";
import {
  renderWorkspaceList,
  renderWorkspaceSave,
  renderWorkspaceSet,
} from "./render-human/workspace.ts";
import type {
  CommandEffect,
  CommandOmission,
  CommandTruncation,
  CommandWarning,
} from "./result.ts";

export {
  DEFAULT_DISPLAY_COLUMNS,
  type HumanRenderRequest,
  MIN_DISPLAY_COLUMNS,
  type RenderedText,
} from "./render-human/session.ts";

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

function renderPayload(session: Session, result: RunCommandResult): RenderedPayload {
  switch (result.command) {
    case "config.show":
      return renderConfigShow(session, result.payload);
    case "config.validate":
      return renderConfigValidate(session, result.payload);
    case "config.path":
      return renderConfigPath(session, result.payload);
    case "config.set":
      return renderConfigSet(session, result.payload);
    case "data.reset":
    case "data.uninstall":
      return renderDataRemoval(session, result.payload);
    case "data.backup":
      return renderDataBackup(session, result.payload);
    case "data.restore":
      return renderDataRestore(session, result.payload);
    case "data.inspect":
      return renderDataInspect(session, result.payload);
    case "data.diagnostics":
      return renderDataDiagnostics(session, result.payload);
    case "data.retention":
      return renderDataRetention(session, result.payload);
    case "data.gc":
      return renderDataGc(session, result.payload);
    case "doctor":
      return renderDoctor(session, result.payload);
    case "export":
      return renderExport(session, result.payload);
    case "import":
      return renderImport(session, result.payload);
    case "replay":
      return renderReplay(session, result.payload);
    case "task.decompose":
      return renderTaskDecompose(session, result.payload);
    case "task.validate":
      return renderTaskValidate(session, result.payload);
    case "task.progress":
      return renderTaskProgress(session, result.payload);
    case "task.commit-plan":
      return renderTaskCommitPlan(session, result.payload);
    case "session.list":
      return renderSessionList(session, result.payload);
    case "session.show":
      return renderSessionShow(session, result.payload);
    case "session.resume":
      return renderSessionResume(session, result.payload);
    case "session.fork":
    case "session.rewind":
      return renderSessionFork(session, result.payload, result.command);
    case "session.replay":
      return renderSessionReplay(session, result.payload);
    case "artifact.list":
      return renderArtifactList(session, result.payload);
    case "artifact.show":
      return renderArtifactShow(session, result.payload);
    case "artifact.get":
      return renderArtifactGet(session, result.payload);
    case "workspace.list":
      return renderWorkspaceList(session, result.payload);
    case "workspace.show":
    case "workspace.load":
      return renderWorkspaceSet(session, result.payload, result.command);
    case "workspace.save":
      return renderWorkspaceSave(session, result.payload);
    case "provider":
      return renderProviderConnections(session, result.payload);
    case "run":
      return renderCodingRun(session, result.payload);
    default:
      return assertNever(result, "unhandled command result");
  }
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
    case "data.backup":
    case "data.restore":
    case "data.inspect":
    case "data.diagnostics":
    case "data.retention":
    case "data.gc":
      return [];
    case "config.show":
      // Quiet still reports a source that was skipped. `config show` prints the
      // values it has; stderr is where the reader is told those values are not
      // the whole of what they wrote.
      return result.payload === null ? [] : unreadSourceFindings(result.payload.inspection.sources);
    case "config.path":
      return [];
    case "config.set":
      return [];
    case "export":
      return [];
    case "import":
    case "replay":
    case "task.decompose":
    case "task.validate":
    case "task.progress":
    case "task.commit-plan":
      return [];
    case "session.list":
      return result.payload === null || result.payload.omitted === 0
        ? []
        : [`omitted ${result.payload.omitted} sessions`];
    case "session.show":
    case "session.resume":
    case "session.fork":
    case "session.rewind":
    case "session.replay":
      return [];
    case "artifact.list":
      return result.payload === null || result.payload.omitted === 0
        ? []
        : [`omitted ${result.payload.omitted} artifacts`];
    case "artifact.show":
    case "artifact.get":
      return [];
    case "workspace.list":
      return result.payload === null || result.payload.omitted === 0
        ? []
        : [`omitted ${result.payload.omitted} layouts`];
    case "workspace.show":
    case "workspace.load":
    case "workspace.save":
    case "provider":
    case "run":
      return [];
    default:
      return assertNever(result, "unhandled command result");
  }
}

function quietErrorLines(errors: readonly FalrynError[]): readonly string[] {
  return errors.map((error) => `error: ${safe(error.code)}: ${safe(error.message)}`);
}
