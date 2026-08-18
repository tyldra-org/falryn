/**
 * The export package contract: what a package is, what it declares, and what a
 * reader must satisfy to open one.
 *
 * An export is the one Falryn artifact that outlives the machine that made it,
 * so it is the one place where a version number is not a formality. Eight rules
 * the types carry rather than document:
 *
 * - **A package carries its own schema version, separate from the database's.**
 *   A package opened two releases later must be able to say what it needs;
 *   asking the database version would answer a question about a machine that no
 *   longer exists.
 * - **A package names the schema families it carries.** The package version
 *   answers "what shape is this file"; the family list answers "what is inside
 *   it, written at what version". A reader that has to parse the records to
 *   learn which vocabulary they speak has already opened content it may not
 *   understand.
 * - **A manifest is a trailer, not a header.** Members are streamed, their
 *   digests are known only once they have been written, and a manifest written
 *   first would either be a lie or force the whole package through memory. A
 *   fixed-width footer makes the trailer findable by seeking from the end, so a
 *   reader still refuses an incompatible package before reading its body.
 * - **An omission is a declared fact.** Content that could not be included is
 *   named with a reason. A package that silently lacks something is a package
 *   nobody can audit.
 * - **A redaction is a declared replacement.** A secret that reached a record
 *   is rewritten before the package is written, and the manifest names the
 *   path, never the original bytes. Configuration metadata on the package is
 *   an already-redacted snapshot the writer was given; the export path never
 *   reads a config file.
 * - **Some content is never exportable, whatever the selection asks for.**
 *   Credentials are unreachable, and `restricted` artifacts are refused by the
 *   sensitivity vocabulary that declared them.
 * - **A manifest read back is untrusted input**, like every other boundary
 *   here. A rejection reports a path and an issue code and never the rejected
 *   value.
 * - **Every bound is an error, never a silent clamp.** A truncated export that
 *   looks complete is worse than an export that refused to start.
 */

import { z } from "zod";
import type { ArtifactId, ContentDigest } from "./artifact.ts";
import { artifactId, contentDigest } from "./artifact.ts";
import type { BlobError } from "./blob.ts";
import { brandedString, timestampSchema } from "./branded-schema.ts";
import type { CodecIssue } from "./codec-error.ts";
import type { SensitiveValueRedactor } from "./configuration.ts";
import type { IdentifierCodec, IdentityError, IdentityErrorCode, SessionId } from "./identity.ts";
import { RUNTIME_EVENT_SCHEMA_FAMILY } from "./limits.ts";
import type { ExportName, PackageError } from "./package.ts";
import { err, ok, type Result } from "./result.ts";
import type { SqliteStoreError } from "./sqlite.ts";
import type { Timestamp } from "./time.ts";

/** The container format this build writes and reads. */
export const EXPORT_FORMAT = "falryn-export/1";

/**
 * The package schema version, which is not the database schema version.
 *
 * A package outlives the database that produced it, so one number cannot answer
 * both "what shape are these rows" and "what shape is this file".
 */
export const EXPORT_SCHEMA_VERSION = 1;

/** The oldest reader this build's packages can be opened by. */
export const MINIMUM_COMPATIBLE_EXPORT_SCHEMA_VERSION = 1;

/**
 * The schema families a package may declare.
 *
 * Built from the family's own source owner rather than restating its name: a
 * second `"falryn.runtime-event"` literal in the export path is a copy that can
 * drift from the one `src/domain/limits.ts` owns.
 *
 * The tuple is also the list's bound — a package cannot name more families than
 * exist.
 */
export const EXPORT_SCHEMA_FAMILIES = [RUNTIME_EVENT_SCHEMA_FAMILY] as const;

export type ExportSchemaFamily = (typeof EXPORT_SCHEMA_FAMILIES)[number];

/**
 * One family a package carries, and the version it was written at.
 *
 * Two fields and no more: the name answers "what is in here" and the version
 * answers "written at what". A bare list of names would leave a reader unable
 * to tell a v1 record stream from a v2 one, which is the point of naming the
 * family at all.
 */
export type ExportSchemaFamilyDeclaration = {
  readonly family: ExportSchemaFamily;
  readonly schemaVersion: number;
};

/** The generated member holding every record the selection reached. */
export const RECORDS_MEMBER = "records.jsonl";

/** Where an artifact's bytes sit inside a package. */
export function artifactMemberName(digest: ContentDigest): string {
  return `artifacts/${digest.slice(digest.indexOf(":") + 1)}`;
}

/**
 * The fixed-width footer, so a reader can find the trailer by seeking.
 *
 * Twenty decimal digits and a newline: enough for any manifest this build's
 * bounds permit, and fixed so the seek is arithmetic rather than a search.
 */
export const EXPORT_FOOTER_DIGITS = 20;
export const EXPORT_FOOTER_BYTES = EXPORT_FOOTER_DIGITS + 1;

/** Longest manifest a reader will load. It is read whole, so it is bounded. */
export const MAX_MANIFEST_BYTES = 4 * 1_024 * 1_024;

/** Sessions one selection may name. */
export const MAX_EXPORTED_SESSIONS = 1_000;

/** Artifacts one package may carry. */
export const MAX_EXPORTED_ARTIFACTS = 10_000;

/**
 * Events one package may carry, across every session it names.
 *
 * A bound rather than a page size: a stream longer than this is refused, not
 * exported as its first pages. Silently carrying a prefix would be the one
 * thing this module's omission rule exists to prevent — an absence nobody
 * declared.
 */
export const MAX_EXPORTED_EVENTS = 250_000;

/** Members one package may carry: the records member plus its artifacts. */
export const MAX_EXPORT_MEMBERS = MAX_EXPORTED_ARTIFACTS + 1;

/** The hard ceiling on a package, above which no configured limit may reach. */
export const MAX_PACKAGE_BYTES = 8 * 1_024 * 1_024 * 1_024;

/** The declared default for the configured package ceiling. */
export const DEFAULT_PACKAGE_MAX_BYTES = 2 * 1_024 * 1_024 * 1_024;

/** Smallest package ceiling a machine may configure. */
export const MIN_PACKAGE_MAX_BYTES = 1_024 * 1_024;

/** Longest export name accepted. It becomes a file name. */
export const MAX_EXPORT_NAME_LENGTH = 128;

/** Alphanumeric first, then alphanumerics, dot, underscore, and hyphen. */
const LEGAL_EXPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function identityError(code: IdentityErrorCode, identity: string): IdentityError {
  return { kind: "identity", code, identity };
}

/**
 * An export name, validated the way an artifact identity is.
 *
 * Narrow for the same reason: it names a file, so a separator, a leading dot,
 * or `..` is refused at the parser rather than at a path component.
 */
export const exportName: IdentifierCodec<ExportName> = {
  identity: "exportName",
  parse(value: unknown): Result<ExportName, IdentityError> {
    if (typeof value !== "string") {
      return err(identityError("identifier-not-a-string", "exportName"));
    }
    if (value.length === 0) {
      return err(identityError("identifier-empty", "exportName"));
    }
    if (value.length > MAX_EXPORT_NAME_LENGTH) {
      return err(identityError("identifier-too-long", "exportName"));
    }
    if (!LEGAL_EXPORT_NAME.test(value)) {
      return err(identityError("identifier-illegal-character", "exportName"));
    }
    return ok(value as ExportName);
  },
  from(value: string): ExportName {
    const parsed = exportName.parse(value);
    if (!parsed.ok) {
      throw new Error(`invalid exportName: ${parsed.error.code}`);
    }
    return parsed.value;
  },
};

/** Why an artifact the selection reached is not in the package. */
export const EXPORT_OMISSION_REASONS = [
  /** The sensitivity vocabulary says these bytes never leave the machine. */
  "restricted-sensitivity",
  /** Sensitive content the selection did not ask for. */
  "sensitive-not-selected",
  /** The record describes bytes that are not present. */
  "bytes-missing",
  /** The bytes failed verification and are being kept for inspection. */
  "bytes-quarantined",
] as const;

export type ExportOmissionReason = (typeof EXPORT_OMISSION_REASONS)[number];

/**
 * One declared absence.
 *
 * It names the artifact and the reason and never the digest or the bytes: a
 * manifest travels, and an omission's whole job is to be readable by whoever
 * receives it.
 */
export type ExportOmission = {
  readonly artifactId: ArtifactId;
  readonly reason: ExportOmissionReason;
};

/**
 * How a carried field was rewritten.
 *
 * Names a path, never the original bytes: a manifest that repeated a secret
 * as "what we removed" would still be a leak.
 */
export const EXPORT_REDACTION_KINDS = ["replaced"] as const;
export type ExportRedactionKind = (typeof EXPORT_REDACTION_KINDS)[number];

export type ExportRedaction = {
  readonly path: string;
  readonly kind: ExportRedactionKind;
};

/** Longest redaction list a manifest may declare. */
export const MAX_EXPORT_REDACTIONS = 10_000;

/** Deepest JSON walk redaction will enter. */
export const MAX_EXPORT_REDACTION_DEPTH = 16;

/** Longest configuration snapshot a package may carry. */
export const MAX_EXPORT_CONFIGURATION_ENTRIES = 256;

/** Longest configuration key stored on a package. */
export const MAX_EXPORT_CONFIGURATION_KEY = 128;

/** Longest already-redacted configuration value stored on a package. */
export const MAX_EXPORT_CONFIGURATION_VALUE = 256;

/** Longest JSON path a redaction record may name. */
export const MAX_EXPORT_REDACTION_PATH = 256;

/**
 * One effective configuration fact, already redacted.
 *
 * The export path never reads a config file. The caller supplies this
 * snapshot so a package can say which non-secret settings produced it.
 */
export type ExportConfigurationEntry = {
  readonly key: string;
  readonly source: string;
  readonly value: string;
};

export const EXPORT_MEMBER_KINDS = ["records", "artifact"] as const;

export type ExportMemberKind = (typeof EXPORT_MEMBER_KINDS)[number];

/**
 * One member, as the manifest declares it.
 *
 * Byte length and digest are what make a package checkable without importing
 * it: a reader can prove every member is the member the manifest names.
 */
export type ExportMember = {
  readonly name: string;
  readonly kind: ExportMemberKind;
  readonly byteLength: number;
  readonly digest: ContentDigest;
};

export type ExportCounts = {
  readonly sessions: number;
  readonly turns: number;
  readonly modelAttempts: number;
  readonly invocations: number;
  readonly events: number;
  readonly artifacts: number;
};

export const EMPTY_COUNTS: ExportCounts = {
  sessions: 0,
  turns: 0,
  modelAttempts: 0,
  invocations: 0,
  events: 0,
  artifacts: 0,
};

/** What a package says it was made from. A summary; the records carry the rest. */
export type ExportSelectionSummary = {
  readonly kind: ExportSelectionKind;
  readonly sessions: number;
  readonly includesSensitive: boolean;
};

export const EXPORT_SELECTION_KINDS = ["sessions", "range"] as const;

export type ExportSelectionKind = (typeof EXPORT_SELECTION_KINDS)[number];

/**
 * What to export.
 *
 * `includeSensitive` is opt-in and names only `sensitive` content. It can never
 * reach `restricted`, which is refused by the vocabulary rather than by a flag.
 */
export type ExportSelection =
  | {
      readonly kind: "sessions";
      readonly sessionIds: readonly SessionId[];
      readonly includeSensitive: boolean;
    }
  | {
      readonly kind: "range";
      readonly startedAfter: Timestamp | null;
      readonly startedBefore: Timestamp | null;
      readonly includeSensitive: boolean;
    };

/** One artifact the package will carry. */
export type ExportArtifactEntry = {
  readonly artifactId: ArtifactId;
  readonly digest: ContentDigest;
  readonly byteLength: number;
};

/**
 * What a selection resolves to, computed before a byte is written.
 *
 * Bounded first and written second, so a selection too large to export is an
 * error rather than a package that stops in the middle.
 */
export type ExportInventory = {
  readonly counts: ExportCounts;
  readonly sessionIds: readonly SessionId[];
  readonly artifacts: readonly ExportArtifactEntry[];
  readonly omissions: readonly ExportOmission[];
  /** Artifact bytes only. The records member's size is known once written. */
  readonly artifactBytes: number;
};

export type ExportManifest = {
  readonly format: string;
  readonly schemaVersion: number;
  /** The oldest reader that can open this package. */
  readonly minimumCompatibleSchemaVersion: number;
  /** Every family the package carries. Never empty; a package always carries records. */
  readonly schemaFamilies: readonly ExportSchemaFamilyDeclaration[];
  readonly createdAt: Timestamp;
  /** The build that wrote it. Identity, never a path or a machine name. */
  readonly createdBy: string;
  readonly selection: ExportSelectionSummary;
  readonly counts: ExportCounts;
  readonly members: readonly ExportMember[];
  readonly omissions: readonly ExportOmission[];
  readonly redactions: readonly ExportRedaction[];
  readonly configuration: readonly ExportConfigurationEntry[];
};

/** Which bound a request exceeded. */
export const EXPORT_BOUNDS = [
  "sessions",
  "events",
  "artifacts",
  "members",
  "package-bytes",
  "manifest-bytes",
  "redactions",
  "configuration-entries",
] as const;

export type ExportBound = (typeof EXPORT_BOUNDS)[number];

export type ExportError =
  | { readonly kind: "export"; readonly code: "storage"; readonly error: SqliteStoreError }
  | { readonly kind: "export"; readonly code: "package"; readonly error: PackageError }
  | { readonly kind: "export"; readonly code: "bytes"; readonly error: BlobError }
  | { readonly kind: "export"; readonly code: "not-found"; readonly sessionId: SessionId }
  /** Nothing to export. Distinct from an export that wrote an empty package. */
  | { readonly kind: "export"; readonly code: "empty-selection" }
  | {
      readonly kind: "export";
      readonly code: "oversize";
      readonly bound: ExportBound;
      readonly requested: number;
      readonly maximum: number;
    }
  /** Bytes moved between inventory and write. Reported, never written around. */
  | { readonly kind: "export"; readonly code: "digest-mismatch"; readonly artifactId: ArtifactId }
  | {
      readonly kind: "export";
      readonly code: "insufficient-space";
      readonly requiredBytes: number;
      readonly availableBytes: number;
    }
  | {
      readonly kind: "export";
      readonly code: "malformed-manifest";
      readonly issues: readonly CodecIssue[];
    }
  | {
      readonly kind: "export";
      readonly code: "incompatible-version";
      readonly packageSchemaVersion: number;
      readonly packageRequiresAtLeast: number;
      readonly readerSchemaVersion: number;
    }
  | {
      readonly kind: "export";
      readonly code: "truncated-package";
      readonly expectedBytes: number;
      readonly observedBytes: number;
    }
  | { readonly kind: "export"; readonly code: "cancelled" };

/**
 * What writing a package produced.
 *
 * `cancelledAfterFinalize` mirrors the store's contract: a cancellation that
 * arrived after the atomic publish did not unpublish it.
 */
export type ExportResult = {
  readonly name: ExportName;
  readonly manifest: ExportManifest;
  readonly byteLength: number;
  readonly cancelledAfterFinalize: boolean;
};

export const MEMBER_CHECK_STATUSES = [
  "verified",
  "digest-mismatch",
  "wrong-length",
  "missing",
] as const;

export type MemberCheckStatus = (typeof MEMBER_CHECK_STATUSES)[number];

export type ExportMemberCheck = {
  readonly name: string;
  readonly status: MemberCheckStatus;
};

/**
 * What reading a finished package proved, without importing it.
 *
 * This is what makes an export claim checkable in a release where nothing can
 * import one: the package is opened, its manifest parsed, and every member
 * re-hashed against what the manifest declared.
 */
export type ExportVerification = {
  readonly manifest: ExportManifest;
  readonly members: readonly ExportMemberCheck[];
  readonly verified: boolean;
};

const countsSchema = z.object({
  sessions: z.int().min(0),
  turns: z.int().min(0),
  modelAttempts: z.int().min(0),
  invocations: z.int().min(0),
  events: z.int().min(0),
  artifacts: z.int().min(0),
});

/**
 * The declared family list.
 *
 * Bounded by the vocabulary rather than by a separate number, non-empty because
 * a package always carries records, and unique because two versions for one
 * family is a manifest that contradicts itself.
 */
const schemaFamiliesSchema = z
  .array(
    z.object({
      family: z.literal(EXPORT_SCHEMA_FAMILIES),
      schemaVersion: z.int().min(1),
    }),
  )
  .min(1)
  .max(EXPORT_SCHEMA_FAMILIES.length)
  .refine((declared) => new Set(declared.map((entry) => entry.family)).size === declared.length, {
    error: "a schema family is declared more than once",
  });

const manifestSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  schemaVersion: z.int().min(1),
  minimumCompatibleSchemaVersion: z.int().min(1),
  schemaFamilies: schemaFamiliesSchema,
  createdAt: timestampSchema,
  createdBy: z.string().min(1).max(128),
  selection: z.object({
    kind: z.literal(EXPORT_SELECTION_KINDS),
    sessions: z.int().min(0),
    includesSensitive: z.boolean(),
  }),
  counts: countsSchema,
  members: z
    .array(
      z.object({
        name: z.string().min(1).max(256),
        kind: z.literal(EXPORT_MEMBER_KINDS),
        byteLength: z.int().min(0).max(MAX_PACKAGE_BYTES),
        digest: brandedString(contentDigest),
      }),
    )
    .max(MAX_EXPORT_MEMBERS),
  omissions: z
    .array(
      z.object({
        artifactId: brandedString(artifactId),
        reason: z.literal(EXPORT_OMISSION_REASONS),
      }),
    )
    .max(MAX_EXPORTED_ARTIFACTS),
  redactions: z
    .array(
      z.object({
        path: z.string().min(1).max(MAX_EXPORT_REDACTION_PATH),
        kind: z.literal(EXPORT_REDACTION_KINDS),
      }),
    )
    .max(MAX_EXPORT_REDACTIONS)
    .default([]),
  configuration: z
    .array(
      z.object({
        key: z.string().min(1).max(MAX_EXPORT_CONFIGURATION_KEY),
        source: z.string().min(1).max(MAX_EXPORT_CONFIGURATION_KEY),
        value: z.string().max(MAX_EXPORT_CONFIGURATION_VALUE),
      }),
    )
    .max(MAX_EXPORT_CONFIGURATION_ENTRIES)
    .default([]),
});

/**
 * Parses a manifest read back out of a package.
 *
 * The format literal is checked here rather than by the reader, so a file that
 * is not a Falryn export is refused by the same parser that refuses a malformed
 * one, and neither answer carries the rejected bytes.
 */
export function parseExportManifest(value: unknown): Result<ExportManifest, readonly CodecIssue[]> {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    return err(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join("."),
        code: issue.code,
      })),
    );
  }
  return ok(parsed.data);
}

/**
 * Whether this build can open a package.
 *
 * Two numbers, because they answer different questions: a package newer than
 * this reader may still be readable if it says so, and a package older than
 * this reader always is.
 */
export function isCompatible(manifest: ExportManifest, readerVersion: number): boolean {
  return manifest.minimumCompatibleSchemaVersion <= readerVersion;
}

/** The sessions a selection names, or an empty list for a range. */
export function selectedSessions(selection: ExportSelection): readonly SessionId[] {
  return selection.kind === "sessions" ? selection.sessionIds : [];
}

export function summarize(selection: ExportSelection, sessions: number): ExportSelectionSummary {
  return { kind: selection.kind, sessions, includesSensitive: selection.includeSensitive };
}

function childPath(path: string, segment: string): string {
  const next = path === "$" ? `$.${segment}` : `${path}.${segment}`;
  return next.length <= MAX_EXPORT_REDACTION_PATH ? next : next.slice(0, MAX_EXPORT_REDACTION_PATH);
}

function recordRedaction(redactions: ExportRedaction[], path: string): Result<null, ExportError> {
  if (redactions.length >= MAX_EXPORT_REDACTIONS) {
    return err({
      kind: "export",
      code: "oversize",
      bound: "redactions",
      requested: redactions.length + 1,
      maximum: MAX_EXPORT_REDACTIONS,
    });
  }
  redactions.push({ path, kind: "replaced" });
  return ok(null);
}

function walkExportValue(
  value: unknown,
  path: string,
  depth: number,
  redactor: SensitiveValueRedactor,
  redactions: ExportRedaction[],
): Result<unknown, ExportError> {
  if (typeof value === "string") {
    const rewritten = redactor.redactText(value);
    if (rewritten === value) {
      return ok(value);
    }
    const recorded = recordRedaction(redactions, path);
    return recorded.ok ? ok(rewritten) : recorded;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return ok(value);
  }
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (depth >= MAX_EXPORT_REDACTION_DEPTH) {
        if (typeof item === "string") {
          const walked = walkExportValue(
            item,
            childPath(path, String(index)),
            depth,
            redactor,
            redactions,
          );
          if (!walked.ok) {
            return walked;
          }
          next.push(walked.value);
        } else {
          next.push(item);
        }
        continue;
      }
      const walked = walkExportValue(
        item,
        childPath(path, String(index)),
        depth + 1,
        redactor,
        redactions,
      );
      if (!walked.ok) {
        return walked;
      }
      next.push(walked.value);
    }
    return ok(next);
  }
  if (typeof value !== "object") {
    return ok(value);
  }
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = childPath(path, key);
    if (redactor.isSecretName(key)) {
      const recorded = recordRedaction(redactions, nestedPath);
      if (!recorded.ok) {
        return recorded;
      }
      next[key] = redactor.placeholder;
      continue;
    }
    if (depth >= MAX_EXPORT_REDACTION_DEPTH) {
      if (typeof nested === "string") {
        const walked = walkExportValue(nested, nestedPath, depth, redactor, redactions);
        if (!walked.ok) {
          return walked;
        }
        next[key] = walked.value;
      } else {
        next[key] = nested;
      }
      continue;
    }
    const walked = walkExportValue(nested, nestedPath, depth + 1, redactor, redactions);
    if (!walked.ok) {
      return walked;
    }
    next[key] = walked.value;
  }
  return ok(next);
}

/**
 * Rewrites secrets in a record that is about to be written into a package.
 *
 * The original value is never mutated. Each replacement is recorded as a path
 * and a kind; the original bytes do not appear on the redaction list.
 */
export function redactExportValue(
  value: unknown,
  redactor: SensitiveValueRedactor,
  redactions: ExportRedaction[],
  path = "$",
): Result<unknown, ExportError> {
  return walkExportValue(value, path, 0, redactor, redactions);
}
