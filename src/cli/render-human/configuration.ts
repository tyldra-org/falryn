/** Human projections and findings for configuration and diagnostics. */

import { sourceLabel } from "../../config/index.ts";
import {
  assertNever,
  type ConfigurationIssue,
  type InspectedValue,
  isUnreadSource,
  type SourceReport,
} from "../../domain/index.ts";
import type { DoctorPayload, RunCommandResult } from "../commands.ts";
import type { RenderedPayload } from "./payload.ts";
import {
  bound,
  droppedNotice,
  fit,
  hanging,
  NORMAL_BOUNDS,
  paint,
  plural,
  type Session,
  sentence,
} from "./session.ts";
import { displayValue, safe } from "./text.ts";

export function renderConfigShow(
  session: Session,
  payload: Extract<RunCommandResult, { command: "config.show" }>["payload"],
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No configuration to show."], diagnostics: [] };
  }

  const diagnostics: string[] = [
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
  const room = session.columns - prefix.length - (value.source.kind.length + 4);
  if (room < 8) {
    return `${prefix}${fit(session, displayValue(value.value), Math.max(4, session.columns - prefix.length))}`;
  }
  return `${prefix}${fit(session, displayValue(value.value), room)}${suffix}`;
}

export function renderConfigPath(
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

export function renderConfigSet(
  _session: Session,
  payload: Extract<RunCommandResult, { command: "config.set" }>["payload"],
): RenderedPayload {
  if (payload === null) {
    return { lines: ["Configuration was not written."], diagnostics: [] };
  }
  return {
    lines: [
      `Wrote ${safe(payload.keyPath)} to ${safe(payload.path)} (${payload.byteLength} bytes, revision ${safe(payload.revision)}).`,
    ],
    diagnostics: [],
  };
}

export function renderConfigValidate(
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
      ? [
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

export function unreadSourceFindings(sources: readonly SourceReport[]): readonly string[] {
  const unread = sources.filter(isUnreadSource);
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

export function issueSentence(issue: ConfigurationIssue): string {
  switch (issue.kind) {
    case "configuration-home-conflict":
      return `also has data at the legacy location ${safe(issue.legacyPath)}; move or remove one configuration home before continuing.`;
    case "configuration-home-unavailable":
      return `could not be inspected safely (${safe(issue.code)}).`;
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

function configurationHomeSentence(home: DoctorPayload["configurationHome"]): string {
  switch (home.kind) {
    case "current":
      return `${safe(home.root)} [current]`;
    case "legacy":
      return `${safe(home.root)} [legacy; current ${safe(home.currentRoot)}]`;
    case "empty":
      return `${safe(home.root)} [empty]`;
    case "conflict":
      return `${safe(home.currentRoot)} and ${safe(home.legacyRoot)} [conflict]`;
    case "unavailable":
      return `${safe(home.path)} [unavailable: ${safe(home.code)}]`;
    case "cancelled":
      return "inspection cancelled";
    default:
      return assertNever(home, "unhandled configuration home diagnosis");
  }
}

export function renderDoctor(
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
    `  Config     ${fit(session, configurationHomeSentence(payload.configurationHome), session.columns - 13)}`,
    "  Data roots",
    ...payload.roots.map((entry) => {
      const prefix = `    ${entry.root.padEnd(rootWidth)}  `;
      const where = entry.path === null ? "unresolved" : safe(entry.path);
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

export function doctorFindings(payload: DoctorPayload): readonly string[] {
  const findings: string[] = [];
  switch (payload.configurationHome.kind) {
    case "conflict":
      findings.push(
        `The current configuration home ${safe(payload.configurationHome.currentRoot)} and legacy home ${safe(payload.configurationHome.legacyRoot)} both contain data.`,
      );
      break;
    case "unavailable":
      findings.push(
        `The configuration home ${safe(payload.configurationHome.path)} could not be inspected safely (${safe(payload.configurationHome.code)}).`,
      );
      break;
    case "cancelled":
      findings.push("Configuration-home inspection was cancelled.");
      break;
    case "current":
    case "legacy":
    case "empty":
      break;
    default:
      assertNever(payload.configurationHome, "unhandled configuration home finding");
  }
  for (const entry of payload.roots) {
    if (!entry.resolved) {
      findings.push(`The ${entry.root} data root did not resolve to a path.`);
      continue;
    }
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
