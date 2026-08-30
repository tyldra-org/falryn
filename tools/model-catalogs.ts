/** Generate and verify Falryn's committed built-in model catalog resources. */

import { createHash } from "node:crypto";
import { join } from "node:path";

import { parseModelCatalogDocument } from "../src/providers/catalog/schema.ts";
import { createCommandCodeCatalog } from "./model-catalogs/command-code.ts";

const ROOT = join(import.meta.dir, "..");
const BUILTIN_DIRECTORY = join(ROOT, "src/providers/catalog/builtin");
const COMMAND_CODE_PATH = join(BUILTIN_DIRECTORY, "commandcode.json");
const STATIC_CATALOG_PATHS = [
  join(BUILTIN_DIRECTORY, "openai.json"),
  join(BUILTIN_DIRECTORY, "anthropic.json"),
  join(BUILTIN_DIRECTORY, "google.json"),
] as const;

export function serializeModelCatalog(value: unknown): string {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  const formatted = Bun.spawnSync({
    cmd: [process.execPath, "x", "biome", "format", "--stdin-file-path", COMMAND_CODE_PATH],
    stdin: new TextEncoder().encode(source),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (formatted.exitCode !== 0) {
    throw new Error("Unable to format the generated Command Code model catalog.");
  }
  return formatted.stdout.toString();
}

export function commandCodeCatalogSource(): string {
  return serializeModelCatalog(createCommandCodeCatalog());
}

export function modelCatalogDigest(source: string): string {
  return `sha-256:${createHash("sha256").update(source).digest("hex")}`;
}

async function validateCatalogFile(path: string): Promise<void> {
  const source = await Bun.file(path).text();
  const parsed = parseModelCatalogDocument(JSON.parse(source));
  if (!parsed.ok) {
    throw new Error(`Invalid built-in model catalog: ${path}`);
  }
}

export async function checkModelCatalogs(): Promise<void> {
  await Promise.all(STATIC_CATALOG_PATHS.map(validateCatalogFile));
  const expected = commandCodeCatalogSource();
  const actual = await Bun.file(COMMAND_CODE_PATH).text();
  if (actual !== expected) {
    throw new Error(
      "Command Code's built-in model catalog is stale. Run `bun run generate:model-catalogs`.",
    );
  }
  await validateCatalogFile(COMMAND_CODE_PATH);
}

export async function generateModelCatalogs(): Promise<void> {
  await Bun.write(COMMAND_CODE_PATH, commandCodeCatalogSource());
  await checkModelCatalogs();
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  if (checkOnly) {
    await checkModelCatalogs();
    process.stdout.write("Built-in model catalogs are valid and synchronized.\n");
    return;
  }
  await generateModelCatalogs();
  const source = await Bun.file(COMMAND_CODE_PATH).text();
  process.stdout.write(`Generated Command Code model catalog (${modelCatalogDigest(source)}).\n`);
}

if (import.meta.main) {
  await main();
}
