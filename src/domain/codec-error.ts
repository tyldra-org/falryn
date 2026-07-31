/**
 * Failures produced at the untrusted event boundary.
 *
 * Every variant reports structure — a path, a code, a version, a size — and
 * never the rejected value. A malformed event may carry a credential, so the
 * error that describes it must be safe to log, export, and put in a support
 * bundle.
 */

export type CodecIssue = {
  /** Dotted path into the decoded object, `""` for the root. */
  readonly path: string;
  /** Zod issue code, such as `invalid_type`. Carries no user data. */
  readonly code: string;
};

export type CodecError =
  /** Encoded form exceeds the declared byte bound. */
  | {
      readonly kind: "oversized-event";
      readonly byteLength: number;
      readonly maximumBytes: number;
    }
  /** Bytes are not valid UTF-8. */
  | { readonly kind: "malformed-encoding" }
  /** Text is not valid JSON. */
  | { readonly kind: "malformed-json" }
  /** JSON is valid but is not an object. */
  | { readonly kind: "not-an-object" }
  /**
   * The `kind` is not a member of this build's closed union. The observed
   * value is preserved for quarantine and never mapped onto a known kind.
   */
  | { readonly kind: "unknown-event-kind"; readonly observedKind: string }
  /** The event requires a reader newer than this build. */
  | {
      readonly kind: "unsupported-schema-version";
      readonly observedSchemaVersion: number;
      readonly minimumCompatibleVersion: number;
      readonly readerSchemaVersion: number;
    }
  /** The event predates the oldest version this build interprets. */
  | {
      readonly kind: "retired-schema-version";
      readonly observedSchemaVersion: number;
      readonly minimumSupportedVersion: number;
    }
  /** Structure or identity validation failed. */
  | { readonly kind: "invalid-envelope"; readonly issues: readonly CodecIssue[] };
