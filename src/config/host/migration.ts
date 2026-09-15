/** Explicit single-document format migration; recovery bytes precede atomic publication. */
import type { ConfigurationRegistryPort } from "../../domain/configuration/index.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { type FileSystemPort, localPath } from "../../domain/workspace/index.ts";
import { parseConfigurationDocument } from "../document/document.ts";
import { type ConfigurationDocumentEdit, planConfigurationEdits } from "../document/edits.ts";
import { MAX_CONFIGURATION_FILE_BYTES } from "../document/jsonc.ts";
import { configurationObject, documentSettingPath } from "../document/organized.ts";
import {
  type ConfigurationWriteRequest,
  resolveConfigurationFilePath,
  writeConfigurationEdits,
} from "./writer.ts";

export type ConfigurationMigrationRequest = Pick<
  ConfigurationWriteRequest,
  | "configurationRoot"
  | "workspaceRoot"
  | "profile"
  | "scope"
  | "validateCandidate"
  | "onMutationStart"
>;

async function planConfigurationMigration(
  registry: ConfigurationRegistryPort,
  fs: FileSystemPort,
  request: ConfigurationMigrationRequest,
  signal?: AbortSignal,
) {
  const resolved = resolveConfigurationFilePath(request);
  if (!resolved.ok) return { kind: "refused" as const, code: resolved.error.kind };
  const path = resolved.value;
  const scope = request.scope === "private-project" ? "project" : request.scope;
  const before = await fs.stat(path, signal);
  const text = await fs.readText(path, MAX_CONFIGURATION_FILE_BYTES, signal);
  const after = await fs.stat(path, signal);
  if (
    !before.ok ||
    before.value === null ||
    !text.ok ||
    !after.ok ||
    before.value.revision !== after.value?.revision
  )
    return { kind: "refused" as const, code: "migration-source-unavailable-or-changed" };
  const source = parseConfigurationDocument(text.value);
  if (source === null || source.schemaVersion !== 1)
    return { kind: "refused" as const, code: "migration-requires-version-one" };
  const edits: ConfigurationDocumentEdit[] = [];
  const mapping: { from: string; to: string }[] = [];
  const collisions: string[] = [];
  const validated = registry.validateLayer(source, {
    scope,
    sourceKind:
      request.scope === "user"
        ? "user-file"
        : request.scope === "profile"
          ? "profile"
          : "project-file",
  });
  if (!validated.ok)
    collisions.push(
      ...validated.issues.filter((issue) => issue.severity === "error").map((issue) => issue.path),
    );
  for (const descriptor of registry.keys()) {
    let value: unknown = source;
    for (const segment of descriptor.path.split("."))
      value = configurationObject(value) ? value[segment] : undefined;
    if (value === undefined) continue;
    const target = documentSettingPath(descriptor.path, scope);
    if (target === null || (request.scope === "profile" && !target.startsWith("overrides."))) {
      collisions.push(descriptor.path);
      continue;
    }
    mapping.push({ from: descriptor.path, to: target });
    edits.push({ kind: "move", from: descriptor.path.split("."), path: target.split(".") });
  }
  for (const key of Object.keys(source))
    if (!["schemaVersion", "minimumReaderSchemaVersion", "$schema"].includes(key))
      edits.push({ kind: "remove", path: [key] });
  edits.push(
    { kind: "set", path: ["schemaVersion"], value: 2 },
    { kind: "set", path: ["minimumReaderSchemaVersion"], value: 2 },
  );
  const plan = planConfigurationEdits(text.value, edits);
  if (plan.kind === "rejected") collisions.push(plan.code);
  else {
    const valid = registry.validateComplete(plan.document, {
      scope,
      sourceKind:
        request.scope === "user"
          ? "user-file"
          : request.scope === "profile"
            ? "profile"
            : "project-file",
    });
    if (!valid.ok)
      collisions.push(
        ...valid.issues.filter((issue) => issue.severity === "error").map((issue) => issue.path),
      );
  }
  const revision = before.value.revision;
  const id = canonicalDigest({ path, revision, source: text.value, edits });
  const backup = localPath(`${path}.v1-${id.slice(7, 23)}.original`);
  return {
    kind: "preview" as const,
    id,
    path,
    sourceRevision: revision,
    destinationRevision: revision,
    fromVersion: 1 as const,
    toVersion: 2 as const,
    mapping,
    collisions: [...new Set(collisions)],
    recovery: backup,
    retainedUnknownBytes:
      collisions.length > 0
        ? ("source-left-authoritative" as const)
        : ("exact-recovery-original" as const),
    // Kept inside this owner. Public inspection carries metadata, never source bytes.
    source: text.value,
    edits,
  };
}

export async function applyConfigurationMigration(
  registry: ConfigurationRegistryPort,
  fs: FileSystemPort,
  request: ConfigurationMigrationRequest,
  expected: { readonly id: string; readonly revision: string },
  signal?: AbortSignal,
) {
  const preview = await planConfigurationMigration(registry, fs, request, signal);
  if (preview.kind !== "preview") return preview;
  if (preview.id !== expected.id || preview.sourceRevision !== expected.revision)
    return { kind: "refused" as const, code: "stale-migration-preview" };
  if (preview.collisions.length > 0)
    return { kind: "refused" as const, code: "migration-collisions" };
  const plan = planConfigurationEdits(preview.source, preview.edits);
  if (plan.kind !== "planned") return { kind: "refused" as const, code: plan.code };
  try {
    const issues = await request.validateCandidate?.(preview.path, plan.text, signal);
    if (issues?.some((issue) => issue.severity === "error"))
      return { kind: "refused" as const, code: "migration-candidate-invalid" };
  } catch {
    return { kind: "refused" as const, code: "migration-validation-unavailable" };
  }
  if (signal?.aborted) return { kind: "refused" as const, code: "cancelled" };
  const backup = await fs.stat(preview.recovery, signal);
  if (!backup.ok) return { kind: "refused" as const, code: "migration-recovery-unavailable" };
  if (backup.value !== null) {
    const original = await fs.readText(preview.recovery, MAX_CONFIGURATION_FILE_BYTES, signal);
    if (!original.ok || original.value !== preview.source)
      return { kind: "refused" as const, code: "migration-recovery-conflict" };
  } else {
    request.onMutationStart?.();
    const written = await fs.writeBytes(
      preview.recovery,
      new TextEncoder().encode(preview.source),
      signal,
      { expectedRevision: null },
    );
    if (!written.ok)
      return {
        kind: "refused" as const,
        code: "migration-recovery-write-failed",
        effect:
          written.error.code === "publication-uncertain"
            ? ("uncertain" as const)
            : ("none" as const),
      };
  }
  const saved = await writeConfigurationEdits(
    registry,
    fs,
    { ...request, edits: preview.edits, expectedRevision: preview.sourceRevision },
    signal,
  );
  return { kind: "applied" as const, recovery: preview.recovery, saved };
}

/** Redacted public preview; source bytes stay inside the migration owner. */
export async function previewConfigurationMigration(
  registry: ConfigurationRegistryPort,
  fs: FileSystemPort,
  request: ConfigurationMigrationRequest,
  signal?: AbortSignal,
) {
  const preview = await planConfigurationMigration(registry, fs, request, signal);
  if (preview.kind !== "preview") return preview;
  const { source: _source, edits: _edits, ...metadata } = preview;
  return metadata;
}
