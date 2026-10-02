import { basename, resolve } from "node:path";
import { adoptForeignError } from "../../application/diagnostics/index.ts";
import { preparePackage } from "../../application/extensions/index.ts";
import {
  type PackageInspectionReport,
  packageInspectionReport,
  type SkillInspectionFindings,
} from "../../application/extensions/inspection-report.ts";
import type { TrustRequest } from "../../application/extensions/package-trust.ts";
import { inspectSkillBundle } from "../../application/extensions/skill-findings.ts";
import { ExtensionInputError } from "../../domain/extensions/canonical.ts";
import type { PackageSnapshot } from "../../domain/extensions/package-source.ts";
import { recoveryForEffect } from "../../domain/foundation/index.ts";
import {
  createHostPackageSource,
  readHostSkillEntrypoint,
} from "../../integrations/extensions/host-package-inspection.ts";
import type { CommandResultOf } from "../output/result.ts";
import { mcpConfiguration } from "../runtime/mcp-configuration.ts";
import { loadProductConfiguration } from "../runtime/product-configuration.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { FALRYN_VERSION } from "../version.ts";
import { runPackageTrust } from "./extension-trust.ts";
import { type ExtensionTarget, readInstalledPackage } from "./installed-package.ts";
import { resultFor } from "./shared.ts";
import { DEFAULT_SKILL_FINDINGS_LOAD } from "./skill-findings.ts";

const PACKAGE_SKILL = /^skills\/([^/]+)\/SKILL\.md$/u;

/** Configured MCP server IDs, read without starting anything; null when unavailable. */
async function configuredMcpServers(
  services: ServiceProvider | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadonlySet<string> | null> {
  if (services === undefined) return null;
  try {
    const graph = services();
    const loaded = await loadProductConfiguration(graph, DEFAULT_SKILL_FINDINGS_LOAD, signal);
    if (loaded.outcome.kind !== "published" && loaded.outcome.kind !== "unchanged") return null;
    const record = graph.loader.current();
    const configured = mcpConfiguration(
      record?.values ?? {},
      Number(record?.generation ?? 0),
      record,
    );
    return new Set(
      configured.servers.filter((server) => server.enabled).map((server) => server.id),
    );
  } catch {
    return null;
  }
}

/** Findings for every `skills/*\/SKILL.md` a prepared package's own snapshot holds. */
function packageSkills(
  snapshot: PackageSnapshot,
  source: string,
  mcpServers: ReadonlySet<string> | null,
): SkillInspectionFindings {
  const entries = snapshot.files.flatMap((file) => {
    const bundle = PACKAGE_SKILL.exec(file.path)?.[1];
    if (bundle === undefined) return [];
    const prefix = `skills/${bundle}/`;
    const files = new Set(
      snapshot.files
        .filter((other) => other.path.startsWith(prefix) && other.path !== file.path)
        .map((other) => other.path.slice(prefix.length)),
    );
    return [
      inspectSkillBundle({
        bundle,
        path: file.path,
        source,
        origin: "inspected-package",
        entrypoint: { ok: true, bytes: file.bytes },
        files,
        mcpServers,
      }),
    ];
  });
  return {
    complete: mcpServers !== null,
    omissions: mcpServers === null ? ["mcp-configuration-unavailable"] : [],
    entries,
  };
}

/**
 * The deep check of one standalone skill directory (#1124). Its SKILL.md is read first,
 * so metadata findings survive a walk that is cancelled or runs out of time; that walk
 * lists the directory within the package inspection limits to check links.
 */
export async function inspectStandaloneSkill(
  path: string,
  bytes: Awaited<ReturnType<typeof readHostSkillEntrypoint>>,
  services: ServiceProvider | undefined,
  signal: AbortSignal | undefined,
  deadlineMs: number | undefined,
): Promise<PackageInspectionReport> {
  const bundle = basename(resolve(path));
  const omissions: string[] = [];
  let files: Set<string> | null = null;
  let source = `directory:${bundle}`;
  try {
    const listed = await createHostPackageSource(
      path,
      deadlineMs === undefined ? {} : { deadlineMs },
    ).read(signal);
    source = listed.sourceId;
    files = new Set(listed.files.map((file) => file.path).filter((file) => file !== "SKILL.md"));
  } catch (error) {
    omissions.push(
      error instanceof ExtensionInputError ? error.code : "skill-directory-unreadable",
    );
  }
  const mcpServers = signal?.aborted === true ? null : await configuredMcpServers(services, signal);
  if (mcpServers === null && !omissions.includes("cancelled"))
    omissions.push("mcp-configuration-unavailable");
  return {
    status: "skill-inspected",
    state: "declared",
    bundle,
    skills: {
      complete: omissions.length === 0,
      omissions,
      entries: [
        inspectSkillBundle({
          bundle,
          path: "SKILL.md",
          source,
          origin: "inspected-directory",
          entrypoint:
            bytes.kind === "read" && bytes.ok
              ? { ok: true, bytes: bytes.bytes }
              : {
                  ok: false,
                  problem: bytes.kind === "read" && !bytes.ok ? bytes.problem : "unreadable",
                },
          files,
          mcpServers,
        }),
      ],
    },
  };
}

export async function runExtensionInspect(
  target: ExtensionTarget,
  signal?: AbortSignal,
  services?: ServiceProvider,
  request?: TrustRequest,
  /** The deep check's walk deadline; tests shorten it to prove the timeout path. */
  deep: { readonly deadlineMs?: number } = {},
): Promise<CommandResultOf<"extension.inspect" | "extension.trust", PackageInspectionReport>> {
  let snapshot: PackageSnapshot | null = null;
  const host = {
    falryn: FALRYN_VERSION,
    bun: Bun.version,
    os: process.platform,
    arch: process.arch,
  };
  const installed =
    typeof target === "string"
      ? null
      : services === undefined
        ? ({ ok: false, code: "package-store-unavailable" } as const)
        : await readInstalledPackage(services, target.installed, signal);
  const prepared =
    installed === null
      ? await preparePackage(
          {
            // Keep the bytes preparation reads, so skill findings need no second read.
            async read(readSignal) {
              snapshot = await createHostPackageSource(target as string).read(readSignal);
              return snapshot;
            },
          },
          host,
          signal === undefined ? {} : { signal },
        )
      : installed.ok
        ? await preparePackage({ read: async () => installed.snapshot }, host, {
            candidates: installed.dependencies,
            ...(signal === undefined ? {} : { signal }),
          })
        : ({ ok: false, code: installed.code } as const);
  if (installed?.ok) snapshot = installed.snapshot;
  const path = typeof target === "string" ? target : null;
  if (
    path !== null &&
    !prepared.ok &&
    prepared.code === "missing-plugin-manifest" &&
    request === undefined
  ) {
    const entrypoint = await readHostSkillEntrypoint(path, signal).catch(() => ({
      kind: "absent" as const,
    }));
    if (entrypoint.kind === "read") {
      const payload = await inspectStandaloneSkill(
        path,
        entrypoint,
        services,
        signal,
        deep.deadlineMs,
      );
      return resultFor(
        "extension.inspect",
        payload,
        [],
        signal?.aborted ? { kind: "cancelled", effect: "none" } : undefined,
        {
          intent: "none",
          observed: "none",
        },
      );
    }
  }
  const skills =
    prepared.ok && snapshot !== null
      ? packageSkills(
          snapshot,
          prepared.package.identityDigest,
          await configuredMcpServers(services, signal),
        )
      : undefined;
  const trust =
    prepared.ok && services !== undefined
      ? await runPackageTrust(prepared.package, services, request, signal)
      : undefined;
  const payload = packageInspectionReport(prepared, trust, skills);
  const effect =
    trust?.status === "applied"
      ? "completed"
      : trust?.status === "failed" && trust.code === "uncertain"
        ? "uncertain"
        : "none";
  const errors =
    payload.status === "failed" || trust?.status === "failed"
      ? [
          adoptForeignError(
            {
              code:
                payload.status === "failed"
                  ? payload.code
                  : trust?.status === "failed"
                    ? trust.code
                    : "trust-unavailable",
              category: "configuration",
              message:
                "Extension inspection or trust decision failed. Inspect the result and retry with fresh evidence.",
            },
            { operation: "extension inspection" },
          ),
        ]
      : [];
  return resultFor(
    request === undefined ? "extension.inspect" : "extension.trust",
    payload,
    errors.map((error) => ({ ...error, effect, recovery: recoveryForEffect(effect) })),
    trust?.status === "failed" && trust.code === "uncertain"
      ? { kind: "uncertain", effect: "uncertain" }
      : signal?.aborted
        ? { kind: "cancelled", effect: trust?.status === "applied" ? "completed" : "none" }
        : undefined,
    {
      intent: request === undefined ? "none" : "mutate",
      observed: effect,
    },
  );
}
