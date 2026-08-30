/** Generate and verify Falryn's committed built-in model catalog resources. */

import { createHash } from "node:crypto";
import { join, relative } from "node:path";

import { parseModelCatalogDocument } from "../src/providers/catalog/schema.ts";
import { createCommandCodeCatalog } from "./model-catalogs/command-code.ts";

const ROOT = join(import.meta.dir, "..");
const BUILTIN_DIRECTORY = join(ROOT, "src/providers/catalog/builtin");
const RESOURCES = [
  { path: join(BUILTIN_DIRECTORY, "openai.json"), create: null },
  { path: join(BUILTIN_DIRECTORY, "anthropic.json"), create: null },
  { path: join(BUILTIN_DIRECTORY, "google.json"), create: null },
  { path: join(BUILTIN_DIRECTORY, "commandcode.json"), create: createCommandCodeCatalog },
] as const;

const COMMAND_CODE_PATH = RESOURCES[3].path;

export type ModelCatalogResourceReport = {
  readonly catalogId: string;
  readonly path: string;
  readonly modelCount: number;
  readonly digest: string;
  readonly generated: boolean;
};

export function serializeModelCatalog(value: unknown, path = COMMAND_CODE_PATH): string {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  const formatted = Bun.spawnSync({
    cmd: [process.execPath, "x", "biome", "format", "--stdin-file-path", path],
    stdin: new TextEncoder().encode(source),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (formatted.exitCode !== 0) {
    throw new Error(`Unable to format model catalog ${relative(ROOT, path)}.`);
  }
  return formatted.stdout.toString();
}

export function commandCodeCatalogSource(): string {
  return serializeModelCatalog(createCommandCodeCatalog());
}

export function modelCatalogDigest(source: string): string {
  return `sha-256:${createHash("sha256").update(source).digest("hex")}`;
}

async function inspectCatalogFile(
  resource: (typeof RESOURCES)[number],
): Promise<ModelCatalogResourceReport> {
  const { path, create } = resource;
  const source = await Bun.file(path).text();
  const parsed = parseModelCatalogDocument(JSON.parse(source));
  if (!parsed.ok) {
    throw new Error(`Invalid built-in model catalog: ${path}`);
  }
  const expected = serializeModelCatalog(create === null ? parsed.value : create(), path);
  if (source !== expected) {
    const action = create === null ? "quality:fix" : "generate:model-catalogs";
    throw new Error(`${parsed.value.displayName} is stale. Run \`bun run ${action}\`.`);
  }
  return {
    catalogId: parsed.value.catalogId,
    path: relative(ROOT, path),
    modelCount: parsed.value.models.length,
    digest: modelCatalogDigest(source),
    generated: create !== null,
  };
}

export async function checkModelCatalogs(): Promise<readonly ModelCatalogResourceReport[]> {
  return Promise.all(RESOURCES.map(inspectCatalogFile));
}

export async function generateModelCatalogs(): Promise<void> {
  await Bun.write(COMMAND_CODE_PATH, commandCodeCatalogSource());
  await checkModelCatalogs();
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  if (checkOnly) {
    const reports = await checkModelCatalogs();
    for (const report of reports) {
      process.stdout.write(
        `${report.catalogId}: ${report.modelCount} models, ${report.digest} (${report.path})\n`,
      );
    }
    return;
  }
  await generateModelCatalogs();
  const reports = await checkModelCatalogs();
  for (const report of reports) {
    process.stdout.write(
      `${report.generated ? "Generated" : "Validated"} ${report.catalogId}: ${report.modelCount} models, ${report.digest}.\n`,
    );
  }
}

if (import.meta.main) {
  await main();
}
