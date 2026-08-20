import { describe, expect, test } from "bun:test";

import {
  type CodecError,
  type ConfigurationIssue,
  type CorrelationIds,
  configurationKeyPath,
  ERROR_CATEGORIES,
  type EventStoreError,
  type ExportError,
  type FalrynError,
  flattenErrors,
  isSafeToRetryWithoutInspection,
  localPath,
  MAX_RELATED_ERRORS,
  NO_CORRELATION,
  type ParticipantReport,
  RUNTIME_EMITTED_CATEGORIES,
  recoveryForEffect,
  type SequenceError,
  type SourceOutcome,
  type SourceReport,
  type SqliteStoreError,
  scopeId,
  sessionId,
  streamId,
  traceId,
} from "../domain/index.ts";
import {
  adoptForeignError,
  aggregate,
  fromCodecError,
  fromConfigurationIssue,
  fromConfigurationIssues,
  fromCredentialFailure,
  fromEventStoreError,
  fromExportError,
  fromIdentityError,
  fromParticipantReports,
  fromSequenceError,
  fromSqliteStoreError,
  fromTimestampError,
  fromUnknown,
  fromUnreadConfigurationSource,
  fromUnreadConfigurationSources,
  withContext,
} from "./error-translation.ts";

const SECRET = "sk-live-DEADBEEFDEADBEEF";

const CORRELATION: CorrelationIds = {
  ...NO_CORRELATION,
  sessionId: sessionId.from("session-1"),
  traceId: traceId.from("trace-1"),
  scopeId: scopeId.from("scope-1"),
};

function everyErrorText(error: FalrynError): string {
  return JSON.stringify(flattenErrors(error));
}

describe("boundary translation", () => {
  test("a codec rejection becomes a data error with no user data", () => {
    const codec: CodecError = {
      kind: "invalid-envelope",
      issues: [{ path: "payload.apiKey", code: "invalid_type" }],
    };
    const error = fromCodecError(codec);

    expect(error.category).toBe("data");
    expect(error.effect).toBe("none");
    expect(error.retryable).toBe(false);
    expect(error.cause?.source).toBe("codec");
    expect(error.cause?.detail).toBe("payload.apiKey:invalid_type");
  });

  test("an unknown event kind is preserved in the cause", () => {
    const error = fromCodecError({ kind: "unknown-event-kind", observedKind: "session.resumed" });
    expect(error.cause?.detail).toBe("session.resumed");
    expect(error.code).toBe("data.codec.unknown-event-kind");
  });

  test("an identity rejection reports which identity, never the value", () => {
    const error = fromIdentityError({
      kind: "identity",
      code: "identifier-illegal-character",
      identity: "sessionId",
    });
    expect(error.category).toBe("data");
    expect(error.cause?.detail).toBe("sessionId");
  });

  test("a timestamp rejection carries no detail at all", () => {
    const error = fromTimestampError({ kind: "timestamp", code: "timestamp-not-canonical-utc" });
    expect(error.cause?.detail).toBeNull();
  });

  test("an oversize export names the bound, never the records", () => {
    const error = fromExportError({
      kind: "export",
      code: "oversize",
      bound: "package-bytes",
      requested: 99,
      maximum: 10,
    } satisfies ExportError);
    expect(error.code).toBe("data.export.oversize");
    expect(error.message).toContain("package-bytes");
    expect(error.cause?.detail).toBe("package-bytes:99:10");
  });

  test("a cancelled export is a cancellation", () => {
    const error = fromExportError({ kind: "export", code: "cancelled" });
    expect(error.category).toBe("cancellation");
    expect(error.exitCategory).toBe("cancelled");
    expect(error.retryable).toBe(true);
  });

  test.each<[SequenceError["code"], boolean]>([
    ["sequence-gap", true],
    ["sequence-out-of-order", true],
    ["idempotency-conflict", false],
    ["event-id-conflict", false],
    ["ledger-capacity-exceeded", false],
  ])("a %s sequence rejection is retryable=%s", (code, retryable) => {
    const stream = streamId.from("stream-1");
    const error = fromSequenceError({ code, streamId: stream } as SequenceError);
    expect(error.retryable).toBe(retryable);
    expect(error.category).toBe("data");
  });

  test("an event-store cancellation is a cancellation, not a data failure", () => {
    const error = fromEventStoreError({ code: "cancelled" });
    expect(error.category).toBe("cancellation");
    expect(error.exitCategory).toBe("cancelled");
    expect(error.effect).toBe("none");
    expect(error.retryable).toBe(true);
  });

  test("an event-store error delegates to the union it wraps", () => {
    const wrapped: EventStoreError = {
      code: "codec",
      error: { kind: "malformed-json" },
    };
    expect(fromEventStoreError(wrapped).code).toBe("data.codec.malformed-json");
  });

  test("an invalid read limit reports the bound, not the caller's data", () => {
    const error = fromEventStoreError({
      code: "invalid-read-limit",
      requestedLimit: 5_000,
      maximumLimit: 1_000,
    });
    expect(error.cause?.detail).toBe("requested=5000 maximum=1000");
  });

  test("an unknown throw is internal and uncertain", () => {
    const error = fromUnknown(new Error("something went wrong"));
    expect(error.category).toBe("internal");
    expect(error.effect).toBe("uncertain");
    expect(error.exitCategory).toBe("internal");
    expect(error.recovery).toEqual(["inspect-state"]);
  });

  test("an unknown throw discards the stack", () => {
    const thrown = new Error("boom");
    const error = fromUnknown(thrown);
    expect(JSON.stringify(error)).not.toContain("at ");
    expect(error.cause?.detail).toBe("boom");
  });

  test("a non-error throw is still described safely", () => {
    expect(fromUnknown(42).cause?.detail).toBeNull();
  });
});

describe("effect certainty and recovery", () => {
  test.each([
    ["none", ["retry"]],
    ["completed", ["inspect-state"]],
    ["partial", ["inspect-state", "re-read-stale-evidence"]],
    ["uncertain", ["inspect-state"]],
  ] as const)("%s carries its documented normal recovery", (effect, expected) => {
    expect([...recoveryForEffect(effect)]).toEqual([...expected]);
  });

  test("only an observed effect may be retried without inspection", () => {
    const base = fromEventStoreError({ code: "cancelled" });
    expect(isSafeToRetryWithoutInspection(base)).toBe(true);
    expect(isSafeToRetryWithoutInspection({ ...base, effect: "partial" })).toBe(false);
    expect(isSafeToRetryWithoutInspection({ ...base, effect: "uncertain" })).toBe(false);
    expect(isSafeToRetryWithoutInspection({ ...base, retryable: false })).toBe(false);
  });
});

describe("aggregation", () => {
  test("a cleanup failure is attached, not dropped", () => {
    const primary = fromUnknown(new Error("operation failed"));
    const cleanup = fromUnknown(new Error("cleanup failed"));
    const combined = aggregate(primary, [cleanup]);

    expect(combined.code).toBe(primary.code);
    expect(combined.related).toHaveLength(1);
    expect(combined.related[0]?.cause?.detail).toBe("cleanup failed");
    expect(flattenErrors(combined)).toHaveLength(2);
  });

  test("related errors keep the order they occurred in", () => {
    const primary = fromUnknown(new Error("first"));
    const combined = aggregate(primary, [
      fromUnknown(new Error("second")),
      fromUnknown(new Error("third")),
    ]);
    expect(combined.related.map((related) => related.cause?.detail)).toEqual(["second", "third"]);
  });

  test("the related list is bounded and reports what it dropped", () => {
    const primary = fromUnknown(new Error("primary"));
    const many = Array.from({ length: MAX_RELATED_ERRORS + 5 }, (_value, index) =>
      fromUnknown(new Error(`related-${index}`)),
    );
    const combined = aggregate(primary, many);

    expect(combined.related).toHaveLength(MAX_RELATED_ERRORS);
    expect(combined.relatedDropped).toBe(5);
  });
});

describe("adopting shutdown participant failures", () => {
  const reports: readonly ParticipantReport[] = [
    { name: "drain", status: "completed", failure: null },
    { name: "persist", status: "failed", failure: "disk full" },
    { name: "restore", status: "timed-out", failure: null },
  ];

  test("only non-completed participants become errors", () => {
    const adopted = fromParticipantReports(reports);
    expect(adopted).toHaveLength(2);
  });

  test("failed and unfinished stay different facts", () => {
    const [failed, unfinished] = fromParticipantReports(reports);

    expect(failed?.category).toBe("internal");
    expect(failed?.effect).toBe("partial");
    expect(failed?.cause?.detail).toBe("persist: disk full");

    expect(unfinished?.category).toBe("cancellation");
    expect(unfinished?.effect).toBe("uncertain");
    expect(unfinished?.cause?.code).toBe("timed-out");
  });

  test("they compose into primary-plus-related without changing shutdown", () => {
    const primary = fromUnknown(new Error("shutdown reported an uncertain outcome"));
    const combined = aggregate(primary, fromParticipantReports(reports));
    expect(combined.related).toHaveLength(2);
    // The source reports are untouched.
    expect(reports[1]?.failure).toBe("disk full");
  });
});

describe("context is added once, not wrapped repeatedly", () => {
  test("adds correlation and operation without changing the decision fields", () => {
    const original = fromCodecError({ kind: "malformed-json" });
    const contextual = withContext(original, {
      correlation: CORRELATION,
      operation: "replay session events",
    });

    expect(contextual.code).toBe(original.code);
    expect(contextual.category).toBe(original.category);
    expect(contextual.effect).toBe(original.effect);
    expect(contextual.retryable).toBe(original.retryable);
    expect(contextual.correlation.sessionId).toBe(sessionId.from("session-1"));
    expect(contextual.cause?.detail).toBe("replay session events");
  });

  test("a second layer of context does not nest a second error", () => {
    const original = fromCodecError({ kind: "malformed-json" });
    const once = withContext(original, { operation: "read" });
    const twice = withContext(once, { operation: "resume" });

    expect(twice.related).toEqual([]);
    expect(twice.cause?.source).toBe("codec");
    expect(flattenErrors(twice)).toHaveLength(1);
  });
});

describe("unknown and future codes", () => {
  test("a recognized foreign category is kept", () => {
    const adopted = adoptForeignError({ code: "provider.rate-limited", category: "provider" });
    expect(adopted.category).toBe("provider");
    expect(adopted.recognized).toBe(true);
    expect(adopted.code).toBe("provider.rate-limited");
  });

  test("an unrecognized category is preserved, not mapped onto a known one", () => {
    const adopted = adoptForeignError({ code: "quantum.entangled", category: "quantum" });

    expect(adopted.recognized).toBe(false);
    expect(adopted.category).toBe("internal");
    // The observed category survives instead of being reinterpreted.
    expect(adopted.cause?.detail).toBe("quantum");
    expect(adopted.code).toBe("quantum.entangled");
    expect(ERROR_CATEGORIES).not.toContain("quantum");
  });

  test("an unrecognized error is uncertain rather than assumed harmless", () => {
    expect(adoptForeignError({ code: "x", category: "y" }).effect).toBe("uncertain");
  });
});

describe("negative controls", () => {
  test("a credential in a foreign message never reaches the error", () => {
    const error = fromUnknown(new Error(`request failed: api_key=${SECRET}`));
    expect(everyErrorText(error)).not.toContain(SECRET);
  });

  test("a credential-bearing URL is stripped of its credential", () => {
    const error = fromUnknown(new Error("connect postgres://admin:hunter2@db.internal/app failed"));
    const text = everyErrorText(error);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("db.internal");
  });

  test("a secret in an operation description does not survive withContext", () => {
    const error = withContext(fromCodecError({ kind: "malformed-json" }), {
      operation: `authorization: Bearer ${SECRET}`,
    });
    expect(everyErrorText(error)).not.toContain(SECRET);
  });

  test("a secret in a shutdown participant failure is redacted on adoption", () => {
    const adopted = fromParticipantReports([
      { name: "persist", status: "failed", failure: `token=${SECRET}` },
    ]);
    expect(JSON.stringify(adopted)).not.toContain(SECRET);
  });

  test("a secret inside an aggregate's related error is redacted too", () => {
    const combined = aggregate(fromUnknown(new Error("primary")), [
      fromUnknown(new Error(`password: ${SECRET}`)),
    ]);
    expect(everyErrorText(combined)).not.toContain(SECRET);
  });

  test("every runtime error carries a correlation object", () => {
    const error = fromCodecError({ kind: "malformed-json" });
    expect(Object.keys(error.correlation).sort()).toEqual(Object.keys(NO_CORRELATION).sort());
  });
});

describe("configuration rejections", () => {
  const unknownKey: ConfigurationIssue = {
    kind: "unknown-key",
    severity: "error",
    path: "data.rootz",
  };

  test("carry the configuration category and exit as a user error", () => {
    const error = fromConfigurationIssue(unknownKey);
    expect(error.category).toBe("configuration");
    expect(error.exitCategory).toBe("user-error");
    expect(error.code).toBe("configuration.unknown-key");
    expect(error.cause).toEqual({
      source: "configuration",
      code: "unknown-key",
      detail: "path=data.rootz",
    });
  });

  test("are not retryable, because a file does not change itself", () => {
    const error = fromConfigurationIssue(unknownKey);
    expect(error.retryable).toBe(false);
    expect(error.effect).toBe("none");
    expect(error.recovery).toEqual(["inspect-state"]);
  });

  test("carry the declared constraint, so the fix is readable", () => {
    const error = fromConfigurationIssue({
      kind: "out-of-range",
      severity: "error",
      path: "diagnostics.retention.maxEvents",
      unit: "items",
      minimum: 1,
      maximum: 2_000,
    });
    expect(error.cause?.detail).toBe(
      "path=diagnostics.retention.maxEvents minimum=1 maximum=2000 unit=items",
    );
  });

  test("report the minimum compatible version on version skew", () => {
    const error = fromConfigurationIssue({
      kind: "unsupported-schema-version",
      severity: "error",
      path: "minimumReaderSchemaVersion",
      observedSchemaVersion: 4,
      minimumCompatibleVersion: 3,
      readerSchemaVersion: 1,
    });
    expect(error.cause?.detail).toContain("minimumCompatible=3");
    expect(error.cause?.detail).toContain("reader=1");
  });

  test("collapse a batch into one primary with the rest attached", () => {
    const combined = fromConfigurationIssues([
      unknownKey,
      { kind: "invalid-type", severity: "error", path: "data.roots.cache", expected: "string" },
    ]);
    expect(combined).not.toBeNull();
    expect(flattenErrors(combined as FalrynError).map((error) => error.code)).toEqual([
      "configuration.unknown-key",
      "configuration.invalid-type",
    ]);
  });

  test("do not promote a warning into a failure", () => {
    const aliasResolved: ConfigurationIssue = {
      kind: "alias-resolved",
      severity: "warning",
      path: "fixture.legacyMode",
      canonical: configurationKeyPath("fixture.mode"),
    };
    expect(fromConfigurationIssues([aliasResolved])).toBeNull();
  });

  test("configuration is now a category the runtime emits", () => {
    expect(RUNTIME_EMITTED_CATEGORIES).toContain("configuration");
    for (const category of RUNTIME_EMITTED_CATEGORIES) {
      expect(ERROR_CATEGORIES).toContain(category);
    }
  });

  test("authentication is now a category the runtime emits", () => {
    // A category is listed here because something produces it. The credential
    // resolver does, through `fromCredentialFailure`.
    expect(RUNTIME_EMITTED_CATEGORIES).toContain("authentication");
    expect(
      fromCredentialFailure({
        status: "missing",
        code: "not-in-store",
        retryable: false,
        storeKind: "operating-system-keychain",
        consumer: "example-provider",
        health: { state: "absent", storeKind: "operating-system-keychain", observedAt: null },
      }).category,
    ).toBe("authentication");
  });
});

describe("a configuration source that was not read", () => {
  const unread = (outcome: SourceOutcome): SourceReport => ({
    source: { kind: "user-file", file: localPath("/home/x/falryn.jsonc"), profile: null },
    outcome,
    issues: [],
    declaredKeys: [],
    position: null,
  });

  test("is a configuration failure, so it reaches the configuration exit code", () => {
    const error = fromUnreadConfigurationSource(unread("unreadable"));

    expect(error.category).toBe("configuration");
    expect(error.exitCategory).toBe("user-error");
    expect(error.code).toBe("configuration.source-unreadable");
    // Re-reading changes nothing: a permission has to change first.
    expect(error.retryable).toBe(false);
    expect(error.effect).toBe("none");
  });

  test("keeps the three outcomes distinguishable", () => {
    expect(fromUnreadConfigurationSource(unread("oversized")).code).toBe(
      "configuration.source-oversized",
    );
    expect(fromUnreadConfigurationSource(unread("malformed-encoding")).code).toBe(
      "configuration.source-malformed-encoding",
    );
  });

  test("reports nothing for a source that is absent, empty, or refused", () => {
    // The first two are silent by design; the last two already refuse the load
    // and carry their own issues.
    for (const outcome of ["absent", "empty", "malformed-syntax", "rejected", "loaded"] as const) {
      expect(fromUnreadConfigurationSources([unread(outcome)])).toBeNull();
    }
  });

  test("collapses several unread sources into one primary with the rest attached", () => {
    const combined = fromUnreadConfigurationSources([
      unread("unreadable"),
      unread("absent"),
      unread("oversized"),
    ]);

    expect(combined).not.toBeNull();
    expect(flattenErrors(combined as FalrynError).map((error) => error.code)).toEqual([
      "configuration.source-unreadable",
      "configuration.source-oversized",
    ]);
  });
});

describe("local-database failures", () => {
  const busy: SqliteStoreError = {
    kind: "sqlite-store",
    code: "busy",
    operation: "transaction",
    effect: "none",
    cause: {
      kind: "sqlite",
      code: "busy",
      operation: "transaction",
      driverCode: "SQLITE_BUSY",
      detail: "database is locked",
    },
  };

  test("are the data category, with the driver code kept on the cause", () => {
    const error = fromSqliteStoreError(busy);

    expect(error.category).toBe("data");
    expect(error.code).toBe("data.sqlite.busy");
    expect(error.retryable).toBe(true);
    expect(error.effect).toBe("none");
    expect(error.cause?.source).toBe("sqlite");
    expect(error.cause?.detail).toContain("SQLITE_BUSY");
  });

  test("redact the driver message, which is the one piece of foreign text", () => {
    const error = fromSqliteStoreError({
      ...busy,
      cause: {
        ...busy.cause,
        detail: "cannot open /Users/someone/.config token=sk-live-abcdefghij",
      },
    });

    expect(error.cause?.detail).not.toContain("sk-live-abcdefghij");
    // The user-facing message never carries it at all.
    expect(error.message).toBe("Another process is using the local database.");
  });

  test("keep an unobserved commit uncertain rather than retryable", () => {
    const error = fromSqliteStoreError({
      kind: "sqlite-store",
      code: "unavailable",
      operation: "transaction",
      effect: "uncertain",
      cause: {
        kind: "sqlite",
        code: "io-failure",
        operation: "transaction",
        driverCode: "SQLITE_IOERR",
        detail: null,
      },
    });

    expect(error.effect).toBe("uncertain");
    expect(error.retryable).toBe(false);
    expect(isSafeToRetryWithoutInspection(error)).toBe(false);
  });

  test("send a refusal to inspection rather than to a retry that repeats it", () => {
    for (const error of [
      fromSqliteStoreError({
        kind: "sqlite-store",
        code: "schema-too-new",
        effect: "none",
        recordedVersion: 7,
        applicationVersion: 3,
      }),
      fromSqliteStoreError({
        kind: "sqlite-store",
        code: "invalid-migration-set",
        effect: "none",
        issues: [{ kind: "migration-set", code: "version-gap", version: 3, name: "later" }],
      }),
    ]) {
      expect(error.retryable).toBe(false);
      expect(error.recovery).toEqual(["inspect-state"]);
    }
  });

  test("report both versions when a database is newer than this build", () => {
    const error = fromSqliteStoreError({
      kind: "sqlite-store",
      code: "schema-too-new",
      effect: "none",
      recordedVersion: 7,
      applicationVersion: 3,
    });

    expect(error.cause?.detail).toBe("recorded=7 application=3");
  });

  test("name the recorded version, the applied set, and whether a backup exists", () => {
    const error = fromSqliteStoreError({
      kind: "sqlite-store",
      code: "migration-interrupted",
      effect: "partial",
      recordedVersion: 2,
      appliedVersions: [1, 2],
      backupPath: localPath("/state/falryn-backup-v1.sqlite"),
    });

    expect(error.effect).toBe("partial");
    expect(error.cause?.detail).toBe("recorded=2 applied=1|2 backup=taken");
    // The backup's path is a fact for the report, not for the error text.
    expect(error.cause?.detail).not.toContain("/state/");
  });

  test("treat cancellation as control flow rather than as a data failure", () => {
    const error = fromSqliteStoreError({
      kind: "sqlite-store",
      code: "cancelled",
      operation: "transaction",
      effect: "none",
    });

    expect(error.category).toBe("cancellation");
    expect(error.exitCategory).toBe("cancelled");
    expect(error.effect).toBe("none");
  });

  test("distinguish a rejected statement from a database that cannot be used", () => {
    const error = fromSqliteStoreError({
      kind: "sqlite-store",
      code: "statement-rejected",
      operation: "transaction",
      effect: "none",
      cause: {
        kind: "sqlite",
        code: "constraint",
        operation: "transaction",
        driverCode: "SQLITE_CONSTRAINT_NOTNULL",
        detail: "NOT NULL constraint failed",
      },
    });

    expect(error.code).toBe("data.sqlite.statement-rejected");
    expect(error.message).toBe("The local database rejected a statement.");
  });
});
