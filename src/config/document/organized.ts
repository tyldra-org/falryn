/** Version-two document paths normalize to the existing setting owners. */
import type {
  ConfigurationIssue,
  ConfigurationKeyDescriptor,
  ConfigurationScope,
} from "../../domain/configuration/index.ts";
import { isLegalProfileName } from "../resolution/sources.ts";
import { assignConfigurationValue } from "./document.ts";

export function documentSettingPath(key: string, scope: ConfigurationScope): string | null {
  if (key.startsWith("data.roots.")) return null;
  if (key.startsWith("data.")) return `storage.${key.slice(5)}`;
  if (key === "providers.connections") return "connections.providers";
  if (key === "tools.languageServices") return "connections.languageServices";
  if (key === "tools.sandbox") return "policy.sandbox";
  const prefix = scope === "profile" ? "overrides" : "defaults";
  if (key.startsWith("diagnostics.")) return `${prefix}.privacy.${key}`;
  if (key.startsWith("agents.")) return `${prefix}.capabilities.${key}`;
  if (key.startsWith("packages.")) return `${prefix}.capabilities.${key}`;
  if (
    ["models.", "interface.", "context.", "execution.", "capabilities.", "privacy."].some((group) =>
      key.startsWith(group),
    )
  )
    return `${prefix}.${key}`;
  return null;
}

export function configurationObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function organizedIssue(path: string): ConfigurationIssue {
  return { kind: "invalid-value", severity: "error", path: path.slice(0, 256), allowed: [] };
}

/** Metadata is inert. No selection or extension body can acquire execution authority. */
export function normalizeOrganizedDocument(
  document: Record<string, unknown>,
  scope: ConfigurationScope,
  descriptors: readonly ConfigurationKeyDescriptor[],
): { readonly document: Record<string, unknown>; readonly issues: readonly ConfigurationIssue[] } {
  const issues: ConfigurationIssue[] = [];
  let normalized: Record<string, unknown> = {
    schemaVersion: document.schemaVersion,
    minimumReaderSchemaVersion: document.minimumReaderSchemaVersion,
  };
  if (document.minimumReaderSchemaVersion !== 2 && document.schemaVersion === 2)
    issues.push(organizedIssue("minimumReaderSchemaVersion"));
  const paths = new Map<string, ConfigurationKeyDescriptor>();
  for (const descriptor of descriptors) {
    const path = documentSettingPath(descriptor.path, scope);
    if (path !== null) paths.set(path, descriptor);
  }
  const prefixes = new Set<string>();
  for (const path of paths.keys()) {
    const segments = path.split(".");
    for (let i = 1; i < segments.length; i++) prefixes.add(segments.slice(0, i).join("."));
  }
  // Empty supported categories are harmless; undeclared leaves remain invalid.
  const root = scope === "profile" ? "overrides" : "defaults";
  for (const group of ["models", "capabilities", "execution", "context", "interface", "privacy"])
    prefixes.add(`${root}.${group}`);
  prefixes.add(root);
  if (scope === "user")
    for (const group of ["connections", "storage", "updates", "policy"]) prefixes.add(group);
  const walk = (node: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (prefix === "" && ["schemaVersion", "minimumReaderSchemaVersion"].includes(key)) continue;
      if (prefix === "" && key === "$schema") {
        if (typeof value !== "string" || value.length > 2048) issues.push(organizedIssue(path));
        continue;
      }
      if (prefix === "" && scope === "profile" && ["description", "extends"].includes(key)) {
        if (
          typeof value !== "string" ||
          (key === "extends" ? !isLegalProfileName(value) : value.length > 1024)
        )
          issues.push(organizedIssue(path));
        continue;
      }
      if (prefix === "" && scope === "user" && key === "profiles") {
        if (!configurationObject(value)) issues.push(organizedIssue(path));
        else
          for (const [name, selected] of Object.entries(value)) {
            if (name !== "default" || typeof selected !== "string" || !isLegalProfileName(selected))
              issues.push(organizedIssue(`profiles.${name}`));
          }
        continue;
      }
      const descriptor = paths.get(path);
      if (descriptor !== undefined) {
        if (
          scope === "profile" &&
          (path.startsWith("connections.") ||
            path.startsWith("storage.") ||
            path.startsWith("policy."))
        ) {
          issues.push(organizedIssue(path));
        } else {
          normalized = assignConfigurationValue(
            normalized,
            descriptor.path,
            value as import("../../domain/configuration/index.ts").ConfigurationValue,
          );
        }
      } else if (prefixes.has(path) && configurationObject(value) && depth < 12) {
        walk(value, path, depth + 1);
      } else if (
        path.startsWith(`${root}.capabilities.packages.p`) &&
        /^p[a-f0-9]{32}$/.test(key) &&
        configurationObject(value)
      ) {
        issues.push({ kind: "package-unavailable", severity: "warning", path, retained: false });
      } else {
        issues.push(
          Number(document.schemaVersion) > 2
            ? {
                kind: "ignored-forward-key",
                severity: "warning",
                path: path.slice(0, 256),
                observedSchemaVersion: Number(document.schemaVersion),
                readerSchemaVersion: 2,
              }
            : { kind: "unknown-key", severity: "error", path: path.slice(0, 256) },
        );
      }
    }
  };
  prefixes.add(`${root}.capabilities.packages`);
  walk(document, "", 0);
  return { document: normalized, issues };
}
