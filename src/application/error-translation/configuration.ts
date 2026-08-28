/** Configuration, unread-source, and credential translations. */

import {
  assertNever,
  blockingIssues,
  type ConfigurationIssue,
  type CredentialFailure,
  type CredentialUnresolvedStatus,
  type FalrynError,
  isUnreadSource,
  type SourceOutcome,
  type SourceReport,
} from "../../domain/index.ts";
import { aggregate, build, type ErrorContext } from "./shared.ts";

export function fromConfigurationIssue(
  issue: ConfigurationIssue,
  context: ErrorContext = {},
): FalrynError {
  return build({
    code: `configuration.${issue.kind}`,
    category: "configuration",
    message: configurationMessage(issue),
    // A file does not become valid on a second read; someone has to change it.
    retryable: false,
    effect: "none",
    recovery: ["inspect-state"],
    cause: { source: "configuration", code: issue.kind, detail: configurationDetail(issue) },
    ...context,
  });
}

/**
 * Every blocking issue as one error.
 *
 * Warnings are dropped rather than promoted: a resolved alias and a deprecated
 * key are accepted facts, and turning them into failures would make a working
 * configuration look broken. Returns `null` when nothing blocked.
 */
export function fromConfigurationIssues(
  issues: readonly ConfigurationIssue[],
  context: ErrorContext = {},
): FalrynError | null {
  const blocking = blockingIssues(issues);
  const [primary, ...rest] = blocking;
  if (primary === undefined) {
    return null;
  }
  return aggregate(
    fromConfigurationIssue(primary, context),
    rest.map((issue) => fromConfigurationIssue(issue, context)),
  );
}

function configurationMessage(issue: ConfigurationIssue): string {
  switch (issue.kind) {
    case "configuration-home-conflict":
      return "Both the current and legacy configuration homes contain data.";
    case "configuration-home-unavailable":
      return "A configuration home could not be inspected safely.";
    case "unknown-key":
      return "A configuration key is not recognized.";
    case "invalid-type":
      return `A configuration value is not a ${issue.expected}.`;
    case "out-of-range":
      return "A configuration value is outside its allowed range.";
    case "invalid-value":
      return "A configuration value is not one of the allowed values.";
    case "plaintext-credential":
      return "A configuration key expects a credential reference, not a secret value.";
    case "scope-unavailable":
      return `A configuration key cannot be set from ${issue.scope} configuration.`;
    case "duplicate-identity":
      return "A configuration list repeats an identity.";
    case "cross-field-conflict":
      return "Two configuration values cannot both be in effect.";
    case "invalid-schema-version":
      return "A configuration document does not declare a usable schema version.";
    case "unsupported-schema-version":
      return "A configuration document requires a newer build.";
    case "retired-schema-version":
      return "A configuration document predates the oldest version this build reads.";
    case "alias-resolved":
      return "A configuration key was written using a deprecated name.";
    case "deprecated-key":
      return "A configuration key is deprecated.";
    case "ignored-forward-key":
      return "A configuration key from a newer schema version was ignored.";
  }
}

function configurationDetail(issue: ConfigurationIssue): string {
  const facts: string[] = [`path=${issue.path || "<root>"}`];
  switch (issue.kind) {
    case "configuration-home-conflict":
      facts.push(`legacyPath=${issue.legacyPath}`);
      break;
    case "configuration-home-unavailable":
      facts.push(`code=${issue.code}`);
      break;
    case "invalid-type":
      facts.push(`expected=${issue.expected}`);
      break;
    case "out-of-range":
      facts.push(`minimum=${issue.minimum ?? "none"}`, `maximum=${issue.maximum ?? "none"}`);
      if (issue.unit !== null) {
        facts.push(`unit=${issue.unit}`);
      }
      break;
    case "invalid-value":
      facts.push(`allowed=${issue.allowed.join("|")}`);
      break;
    case "plaintext-credential":
      facts.push(`expectedStoreKinds=${issue.expectedStoreKinds.join("|")}`);
      break;
    case "scope-unavailable":
      facts.push(`scope=${issue.scope}`, `available=${issue.availableScopes.join("|")}`);
      break;
    case "duplicate-identity":
      facts.push(`identityField=${issue.identityField}`);
      break;
    case "cross-field-conflict":
      facts.push(`rule=${issue.rule}`, `related=${issue.relatedPaths.join("|")}`);
      break;
    case "unsupported-schema-version":
      facts.push(
        `observed=${issue.observedSchemaVersion}`,
        `minimumCompatible=${issue.minimumCompatibleVersion}`,
        `reader=${issue.readerSchemaVersion}`,
      );
      break;
    case "retired-schema-version":
      facts.push(
        `observed=${issue.observedSchemaVersion}`,
        `minimumSupported=${issue.minimumSupportedVersion}`,
      );
      break;
    case "alias-resolved":
      facts.push(`canonical=${issue.canonical}`);
      break;
    case "deprecated-key":
      facts.push(
        `replacement=${issue.replacement ?? "none"}`,
        `removedIn=${issue.removedInSchemaVersion ?? "none"}`,
      );
      break;
    case "ignored-forward-key":
      facts.push(`observed=${issue.observedSchemaVersion}`, `reader=${issue.readerSchemaVersion}`);
      break;
    case "unknown-key":
    case "invalid-schema-version":
      break;
    default:
      assertNever(issue, "unhandled configuration issue");
  }
  return facts.join(" ");
}

/**
 * A configuration document that exists and was not read.
 *
 * The loader fails open on an unavailable source: it skips the file, records
 * why, and composes the remaining layers. That keeps a machine working, and it
 * also means the configuration in effect is not the one its author wrote — so a
 * surface whose whole purpose is to answer "is my configuration right" has to
 * be able to say so, and to say it in the exit status.
 *
 * Nothing here carries the document. The read produced no bytes in the
 * `unreadable` and `oversized` cases, and the `malformed-encoding` case is
 * precisely the one whose bytes must not be echoed. The path is left to the
 * payload and the rendered finding, which bound it; the cause names the layer
 * and the outcome, both of which come from declarations.
 */
export function fromUnreadConfigurationSource(
  report: SourceReport,
  context: ErrorContext = {},
): FalrynError {
  return build({
    code: `configuration.source-${report.outcome}`,
    category: "configuration",
    message: unreadSourceMessage(report.outcome),
    // Re-reading changes nothing: a permission, a size, or an encoding has to
    // change first, and each of those is a person's decision.
    retryable: false,
    effect: "none",
    recovery: ["inspect-state"],
    cause: {
      source: "configuration",
      code: `source-${report.outcome}`,
      detail: `kind=${report.source.kind}`,
    },
    ...context,
  });
}

/**
 * Every unread source as one error, or `null` when every source was read.
 *
 * Aggregated the way `fromConfigurationIssues` aggregates issues, so a run with
 * an unreadable user file and an oversized project file reports both rather
 * than whichever came first.
 */
export function fromUnreadConfigurationSources(
  reports: readonly SourceReport[],
  context: ErrorContext = {},
): FalrynError | null {
  const [primary, ...rest] = reports.filter(isUnreadSource);
  if (primary === undefined) {
    return null;
  }
  return aggregate(
    fromUnreadConfigurationSource(primary, context),
    rest.map((report) => fromUnreadConfigurationSource(report, context)),
  );
}

function unreadSourceMessage(outcome: SourceOutcome): string {
  switch (outcome) {
    case "oversized":
      return "A configuration file is larger than the limit this build reads, and was skipped.";
    case "malformed-encoding":
      return "A configuration file is not valid UTF-8 text, and was skipped.";
    default:
      return "A configuration file exists and could not be read, and was skipped.";
  }
}

/**
 * A credential that could not be resolved.
 *
 * This is the first producer of the `authentication` category. Nothing here is
 * redacted, for the same reason a configuration issue is not: a credential
 * failure is built from a status, a Falryn code, a store kind, and a consumer
 * name, all of which come from declarations rather than from the store. The
 * locator is deliberately absent — it is withheld from every rendering, and an
 * error is a rendering.
 *
 * `effect` is always `none`. Reading a credential changes nothing, so a caller
 * never has to inspect state before trying again; what stops an automatic retry
 * is `retryable`, which the store sets from whether the state that caused the
 * failure can change at all.
 */
export function fromCredentialFailure(
  failure: CredentialFailure,
  context: ErrorContext = {},
): FalrynError {
  return build({
    code: `authentication.${failure.status}`,
    category: "authentication",
    message: credentialMessage(failure.status),
    retryable: failure.retryable,
    effect: "none",
    recovery: ["inspect-state"],
    cause: {
      source: "credentials",
      code: failure.code,
      detail: `store=${failure.storeKind} consumer=${failure.consumer} health=${failure.health.state}`,
    },
    ...context,
  });
}

function credentialMessage(status: CredentialUnresolvedStatus): string {
  switch (status) {
    case "missing":
      return "No credential is stored for this reference.";
    case "empty":
      return "The stored credential is empty.";
    case "locked":
      return "The credential store is locked and cannot be opened without interaction.";
    case "denied":
      return "The credential store refused this request.";
    case "unavailable":
      return "The credential store could not be reached.";
    case "unsupported":
      return "This build does not support this credential store on this platform.";
    case "timed-out":
      return "The credential store did not answer before the deadline.";
    case "cancelled":
      return "The credential lookup was cancelled before it completed.";
    case "malformed":
      return "The credential reference does not name something this store can look for.";
  }
}

/**
 * A local-database failure.
 *
 * Every member is `data` except cancellation, which is control flow and belongs
 * to `cancellation` wherever it appears. Retryability comes from whether the
 * condition can change on its own: a busy lock clears, a defective migration
 * set does not.
 *
 * The driver's own message is the one piece of foreign text here, and it is the
 * reason this translation redacts at all. A SQLite message routinely embeds the
 * absolute path of the database and, for a constraint failure, the column and
 * value that violated it. It reaches the developer cause through the runtime's
 * single redactor and never reaches `message`.
 */
