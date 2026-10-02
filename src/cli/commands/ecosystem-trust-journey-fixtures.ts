/** One product home driving the ecosystem trust journey (#1279) through real CLI dispatch. */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  curatedVerification,
  curatorReport,
  type fixtureSigner,
} from "../../application/extensions/evaluation-fixtures.ts";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { preparePackage } from "../../application/extensions/prepare-package.ts";
import { CONFIGURATION_FILE_NAME } from "../../config/index.ts";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { curatedDocument, curatedEntry } from "../../domain/extensions/curated-catalog-fixtures.ts";
import type { PackageIdentityV1 } from "../../domain/extensions/identity.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { readPackageArchive } from "../../domain/extensions/package-archive.ts";
import {
  type ArchiveEntry,
  archiveBytes,
} from "../../domain/extensions/package-archive-fixtures.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import type { TrustObservation } from "../../domain/security/ecosystem-trust.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { hookTestCertificate } from "../../integrations/extensions/hook-http-fixtures.ts";
import { dispatch } from "../dispatch.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { createServiceProvider } from "../runtime/services.ts";
import { FALRYN_VERSION } from "../version.ts";

export const journeyCertificate = hookTestCertificate("registry.test");
const HOST = { falryn: FALRYN_VERSION, bun: Bun.version, os: process.platform, arch: process.arch };
const envelope = z.object({
  payload: z.unknown(),
  errors: z.array(z.object({ code: z.string() }).passthrough()).optional(),
});

/** A package's archive contents: its manifest extension and files under `package/`. */
export type JourneyPackage = {
  readonly id: string;
  readonly version?: string;
  readonly extension: Record<string, unknown>;
  readonly files?: Readonly<Record<string, Uint8Array>>;
  /** Declare the files' digests in the manifest, as packages with executables must. */
  readonly declareFiles?: boolean;
};

export async function trustJourney(root: string) {
  if (journeyCertificate === null) throw new Error("no test certificate");
  const tls = journeyCertificate;
  const config = join(root, "config");
  await mkdir(config, { recursive: true });
  await writeFile(
    join(config, CONFIGURATION_FILE_NAME),
    JSON.stringify({
      schemaVersion: 1,
      tools: { sandbox: { version: 1, mode: "strict", readRoots: [], writeRoots: [] } },
    }),
  );
  const environment = {
    PATH: process.env.PATH ?? "",
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? "",
    HOME: root,
    NO_COLOR: "1",
    FALRYN_CONFIG_DIR: config,
    FALRYN_STATE_DIR: join(root, "state"),
    FALRYN_CACHE_DIR: join(root, "cache"),
    FALRYN_LOG_DIR: join(root, "logs"),
    FALRYN_TEMP_DIR: join(root, "temporary"),
    FALRYN_ARTIFACT_DIR: join(root, "artifacts"),
    FALRYN_EXPORT_DIR: join(root, "exports"),
  };
  const egress = {
    resolve: async () => [{ address: "127.0.0.1", family: 4 as const }],
    ca: tls.cert,
    reachable: ["127.0.0.1"],
  };

  /** One command, dispatched in this process over the journey's roots; every call reloads state. */
  async function cli(argv: readonly string[], input?: unknown, format = "json") {
    const args = [...argv];
    if (input !== undefined) {
      const file = join(root, `request-${randomUUID()}.json`);
      await writeFile(file, JSON.stringify(input));
      args.push("--input", file);
    }
    const streams = createRecordingCliStreams();
    const code = await dispatch({
      argv: [...args, "--format", format],
      streams,
      services: (globals) =>
        createServiceProvider(globals, {
          home: localPath(root),
          currentDirectory: localPath(root),
          environment: createStaticEnvironment(environment),
          egress,
        }),
    });
    const stdout = streams.resultWrites().join("");
    if (format !== "json")
      return { code, text: stdout, payload: null as unknown, errors: [] as string[] };
    const last = stdout.trim().split("\n").at(-1) ?? "";
    const parsed = last === "" ? null : envelope.safeParse(JSON.parse(last));
    if (parsed === null || !parsed.success)
      throw new Error(
        `${argv.join(" ")}: no result (exit ${code}): ${streams.diagnosticWrites().join("").slice(0, 1_500)}`,
      );
    return {
      code,
      text: stdout,
      payload: parsed.data.payload,
      errors: (parsed.data.errors ?? []).map((error) => error.code),
    };
  }

  /** Preview, then confirm with the returned token. */
  async function confirmed<T>(
    argv: readonly string[],
    input: Record<string, unknown>,
    token: (preview: unknown) => string | null | undefined,
  ) {
    const preview = await cli(argv, input);
    const confirmation = token(preview.payload);
    if (typeof confirmation !== "string")
      throw new Error(
        `${argv.join(" ")} preview: ${JSON.stringify(preview.payload).slice(0, 1_500)}`,
      );
    return (await cli(argv, { ...input, confirmation })).payload as T;
  }

  const archives = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const bytes = archives.get(path);
      return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
    },
  });
  const registry = `https://registry.test:${server.port}/`;

  /** Serve one package version and return the identity a listing install records for it. */
  async function serve(pkg: JourneyPackage, coordinate = pkg.id): Promise<PackageIdentityV1> {
    const version = pkg.version ?? "1.0.0";
    const entries: ArchiveEntry[] = [
      { path: "package/", type: "5" },
      {
        path: "package/plugin.json",
        text: JSON.stringify(
          pluginManifest(
            {
              ...pkg.extension,
              ...(pkg.declareFiles
                ? {
                    files: Object.entries(pkg.files ?? {}).map(([path, bytes]) => ({
                      path,
                      digest: bytesDigest(bytes),
                    })),
                  }
                : {}),
            },
            { name: pkg.id, version },
          ),
        ),
      },
      ...Object.entries(pkg.files ?? {}).map(([path, bytes]) => ({
        path: `package/${path}`,
        bytes,
      })),
    ];
    const archive = archiveBytes(entries);
    archives.set(`/${coordinate}/${version}/package.tgz`, archive);
    const files = readPackageArchive(archive);
    if (!files.ok) throw new Error(files.error);
    const prepared = await preparePackage(
      {
        read: async () => ({
          sourceId: "fixture",
          sourceCoordinate: { kind: "registry", registry, coordinate, packageVersion: version },
          files: files.value,
          diagnostics: [],
          omittedDiagnostics: 0,
        }),
      },
      HOST,
    );
    if (!prepared.ok) throw new Error(prepared.code);
    return prepared.package.identity;
  }

  let sequence = 0;
  /** Import one catalog for a source; each call replaces that source's previous catalog. */
  async function publish(
    source: string,
    listings: readonly { readonly listingId: string; readonly identity: PackageIdentityV1 }[],
  ) {
    const file = join(root, `catalog-${source}-${++sequence}.json`);
    await writeFile(
      file,
      JSON.stringify(
        curatedDocument(
          listings.map(({ listingId, identity }) => ({
            ...curatedEntry(listingId, { packageId: identity.packageId }),
            versions: [{ identity, publishedAt: 1_000 }],
          })),
          { source, sequence },
        ),
      ),
    );
    const imported = await cli(["extension", "listing"], { operation: "import", file });
    expect(imported.payload).toMatchObject({ status: "imported" });
  }

  const revisions = new Map<string, number>();
  /** Install or update the exact listed version; returns the completed receipt. */
  async function acquire(
    action: "install" | "update",
    packageId: string,
    listing: { sourceId: string; listingId: string; packageVersion: string },
  ) {
    const receipt = packageReceiptSchema.parse(
      await confirmed(
        ["package", action],
        {
          packageId,
          operationId: randomUUID(),
          expectedRevision: revisions.get(packageId) ?? 0,
          listing,
        },
        (preview) => packageReceiptSchema.safeParse(preview).data?.confirmation,
      ),
    );
    expect(receipt).toMatchObject({ status: "completed" });
    revisions.set(packageId, receipt.revision);
    return receipt;
  }

  const inspection = z.object({
    contributions: z.array(
      z.object({ id: z.string(), identityDigest: z.string(), mode: z.string() }),
    ),
    trust: z
      .object({
        status: z.string(),
        confirmation: z.string().nullable().optional(),
        trust: z.object({
          state: z.string(),
          eligible: z.boolean(),
          subject: z.object({ identity: z.unknown() }),
          evidence: z.object({ curation: z.string(), advisory: z.string() }),
        }),
        provenance: z.object({ curationStatus: z.string().optional() }).nullable().optional(),
      })
      .nullable(),
  });
  /** `extension trust --installed`: one confirmed trust request against the installed identity. */
  async function trust(packageId: string, request: Record<string, unknown>) {
    return inspection.parse(
      await confirmed(
        ["extension", "trust", "--installed", packageId],
        request,
        (preview) => inspection.safeParse(preview).data?.trust?.confirmation,
      ),
    );
  }
  async function inspect(packageId: string) {
    return inspection.parse(
      (await cli(["extension", "inspect", "--installed", packageId])).payload,
    );
  }
  /** Signed publisher and advisory evidence, plus curation unless `curation: false`. */
  async function refresh(
    packageId: string,
    signer: ReturnType<typeof fixtureSigner>,
    options: {
      readonly advisory?: {
        readonly sequence: number;
        readonly status: "clear" | "quarantined" | "revoked";
      };
      readonly curation?: false;
    } = {},
  ) {
    const now = Date.now();
    const identity = (await inspect(packageId)).trust?.trust.subject.identity as PackageIdentityV1;
    const observation = { subject: { identity }, now } as unknown as TrustObservation;
    return trust(packageId, {
      action: "refresh",
      expiresAt: null,
      verification: curatedVerification(observation, {
        signer,
        ...(options.advisory === undefined ? {} : { advisory: options.advisory }),
        ...(options.curation === false
          ? { curation: false as const }
          : { statement: { report: curatorReport(identity, {}, now - 1) } }),
      }),
    });
  }
  async function approve(packageId: string) {
    return trust(packageId, { action: "approve", expiresAt: Date.now() + 600_000 });
  }

  const standingSchema = z.object({
    standing: z.object({
      state: z.string(),
      reason: z.string().nullable(),
      identityDigest: z.string().nullable(),
      recovery: z.array(z.object({ choice: z.string() })),
      versions: z.array(
        z.object({ identityDigest: z.string(), current: z.boolean(), state: z.string() }),
      ),
    }),
  });
  async function standing(packageId: string) {
    const read = packageReceiptSchema.parse(
      (
        await cli(["package", "standing"], {
          packageId,
          operationId: randomUUID(),
          expectedRevision: revisions.get(packageId) ?? 0,
        })
      ).payload,
    );
    return standingSchema.parse(read.data).standing;
  }

  const catalogSchema = z.object({
    page: z.object({
      entries: z.array(
        z.object({
          contribution: z.object({ localId: z.string() }).passthrough(),
          enabled: z.boolean(),
          availability: z.string(),
          reason: z.string(),
          binding: z.object({ actionId: z.string() }).nullable(),
        }),
      ),
    }),
  });
  async function catalog() {
    return catalogSchema.parse((await cli(["extension", "catalog"], { action: "catalog" })).payload)
      .page.entries;
  }

  return {
    root,
    environment,
    cli,
    confirmed,
    requests,
    serve,
    publish,
    acquire,
    revisions,
    trust,
    inspect,
    refresh,
    approve,
    standing,
    catalog,
    stop: () => server.stop(true),
  };
}
