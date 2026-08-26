/** Complete projections for Prisma operations. */

import { buildLines, compactDuration } from "../build/shared.ts";

export function formatPrismaOperation(
  text: string,
  commandTokens: readonly string[],
): string | null {
  const action = commandTokens[1] ?? "";
  if (action === "generate") return formatGenerate(text);
  if (action === "migrate") return formatMigrate(text, commandTokens[2] ?? "");
  if (action === "db" && commandTokens[2] === "push") return formatDbPush(text);
  if (action === "validate") return formatValidate(text);
  return null;
}

function formatGenerate(text: string): string | null {
  let schema: string | undefined;
  let client: string | undefined;
  let version: string | undefined;
  let output: string | undefined;
  let duration: string | undefined;
  for (const line of buildLines(text)) {
    const loaded = /^Prisma schema loaded from (.+)$/u.exec(line);
    if (loaded !== null) {
      schema = loaded[1];
      continue;
    }
    const generated = /^✔ Generated (.+?) \(v([^)]+)\) to (.+) in (.+)$/u.exec(line);
    if (generated !== null) {
      client = generated[1];
      version = generated[2];
      output = generated[3];
      duration = generated[4];
      continue;
    }
    if (/^Environment variables loaded from/u.test(line) || /^Start by importing/u.test(line)) {
      continue;
    }
    return null;
  }
  if (
    schema === undefined ||
    client === undefined ||
    version === undefined ||
    output === undefined ||
    duration === undefined
  ) {
    return null;
  }
  return `ok prisma generate ${client}@${version} ${compactDuration(duration)} ${schema} -> ${output}`;
}

function formatMigrate(text: string, action: string): string | null {
  let schema: string | undefined;
  let datasource: string | undefined;
  let migration: string | undefined;
  let count: string | undefined;
  let current = false;
  for (const line of buildLines(text)) {
    if (/^Environment variables loaded from/u.test(line)) continue;
    const loaded = /^Prisma schema loaded from (.+)$/u.exec(line);
    if (loaded !== null) {
      schema = loaded[1];
      continue;
    }
    const source = /^Datasource "[^"]+":\s+(.+)$/u.exec(line);
    if (source !== null) {
      datasource = source[1];
      continue;
    }
    const applying = /^Applying migration `([^`]+)`$/u.exec(line);
    if (applying !== null) {
      migration = applying[1];
      continue;
    }
    const migrations = /^(\d+) migrations? found in prisma\/migrations$/u.exec(line);
    if (migrations !== null) {
      count = migrations[1];
      continue;
    }
    if (
      line === "Your database is now in sync with your schema." ||
      line === "Database schema is up to date!"
    ) {
      current = true;
      continue;
    }
    if (/^(?:The following migration\(s\) have been applied:|migrations\/|\s*└─)/u.test(line)) {
      continue;
    }
    return null;
  }
  if (schema === undefined || datasource === undefined || !current) return null;
  if (action === "status") {
    return count === undefined
      ? null
      : `ok prisma migrate status ${count} migrations; ${schema}; ${datasource}`;
  }
  return migration === undefined
    ? null
    : `ok prisma migrate ${action} ${migration}; ${schema}; ${datasource}`;
}

function formatDbPush(text: string): string | null {
  let schema: string | undefined;
  let datasource: string | undefined;
  let duration: string | undefined;
  for (const line of buildLines(text)) {
    if (/^Environment variables loaded from/u.test(line)) continue;
    const loaded = /^Prisma schema loaded from (.+)$/u.exec(line);
    if (loaded !== null) {
      schema = loaded[1];
      continue;
    }
    const source = /^Datasource "[^"]+":\s+(.+)$/u.exec(line);
    if (source !== null) {
      datasource = source[1];
      continue;
    }
    const synced = /^🚀 Your database is now in sync with your Prisma schema\. Done in (.+)$/u.exec(
      line,
    );
    if (synced !== null) {
      duration = synced[1];
      continue;
    }
    return null;
  }
  return schema === undefined || datasource === undefined || duration === undefined
    ? null
    : `ok prisma db push ${compactDuration(duration)}; ${schema}; ${datasource}`;
}

function formatValidate(text: string): string | null {
  let schema: string | undefined;
  let valid = false;
  for (const line of buildLines(text)) {
    if (/^Environment variables loaded from/u.test(line)) continue;
    const loaded = /^Prisma schema loaded from (.+)$/u.exec(line);
    if (loaded !== null) {
      schema = loaded[1];
      continue;
    }
    if (/^The schema at .+ is valid 🚀$/u.test(line)) {
      valid = true;
      continue;
    }
    return null;
  }
  return valid && schema !== undefined ? `ok prisma validate ${schema}` : null;
}
