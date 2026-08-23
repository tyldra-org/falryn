/** Shared export pipeline options and bounded error helpers. */

import type {
  BlobStorePort,
  ClockPort,
  ContentHasherPort,
  EventStorePort,
  ExportBound,
  ExportConfigurationEntry,
  ExportError,
  PackageWriterPort,
  RecordRepositories,
  SensitiveValueRedactor,
  SqliteStoreError,
  SqliteStorePort,
  SqliteValue,
} from "../../domain/index.ts";

export type ExportOptions = {
  readonly store: SqliteStorePort;
  readonly repositories: RecordRepositories;
  readonly events: EventStorePort;
  readonly blobs: BlobStorePort;
  readonly packages: PackageWriterPort;
  readonly hasher: ContentHasherPort;
  readonly clock: ClockPort;
  /** The build that writes the manifest's `createdBy`. */
  readonly buildIdentity: string;
  /**
   * Required so a package cannot be written without walking secrets.
   *
   * The runtime redactor lives in the application layer; this path depends
   * on the domain port only.
   */
  readonly redactor: SensitiveValueRedactor;
  /** Already-redacted configuration facts to declare on the package. */
  readonly configuration?: readonly ExportConfigurationEntry[];
  readonly maxPackageBytes?: number;
};

export function storageError(error: SqliteStoreError): ExportError {
  return { kind: "export", code: "storage", error };
}

export function oversize(bound: ExportBound, requested: number, maximum: number): ExportError {
  return { kind: "export", code: "oversize", bound, requested, maximum };
}

export function textOf(value: SqliteValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export function integerOf(value: SqliteValue | undefined): number | null {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : null;
}

export function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export const cancelled: ExportError = { kind: "export", code: "cancelled" };
