/**
 * Product process tools (#712, #796): shell, process capture, and recoverable output.
 *
 * Adapts {@link ProcessCapturePort} and {@link createHushIntegrator} so model
 * tool calls return capture reports plus Hush projections without bypassing the
 * pipeline. Interactive PTY start remains unavailable from tool dispatch alone.
 * Git/LSP/DAP stay #713–#714.
 */

import { z } from "zod";

import type { ArtifactStorePort } from "../domain/artifact.ts";
import type {
  ConfigurationGeneration,
  ProcessCapturePort,
  ProcessCaptureRequest,
  ToolCatalog,
  ToolInvocationOutcome,
  ToolRegistry,
  ToolRegistryEntry,
} from "../domain/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  duration,
  MAX_COMMAND_OUTPUT_BYTES,
  type ToolManifestDocument,
} from "../domain/index.ts";
import {
  createHushIntegrator,
  HUSH_ORIGINS,
  type HushObservationError,
  type HushOrigin,
} from "./hush.ts";
import type { LoomPort } from "./loom.ts";
import {
  MAX_PRODUCT_PROCESS_HUSH_BYTES,
  MAX_PRODUCT_PROCESS_MODEL_BYTES,
  MAX_PRODUCT_PROCESS_RAW_INLINE_BYTES,
  PRODUCT_PROCESS_OUTPUT_MODES,
  type ProductProcessObservation,
  type ProductProcessOutputMode,
  projectProductProcessOutput,
} from "./product-process-output.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "./tool-call-loop.ts";

export const PRODUCT_PROCESS_TOOLS_OWNER = "#712";

const openObject = z.record(z.string(), z.unknown()) as z.ZodType<
  Readonly<Record<string, unknown>>
>;

const runProcessInput = z
  .object({
    executable: z.string().min(1),
    argv: z.array(z.string()).default([]),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    origin: z.enum(["shell", "git", "test", "search", "process"]).optional(),
    environment: z.record(z.string(), z.string()).optional(),
    outputMode: z.enum(PRODUCT_PROCESS_OUTPUT_MODES).default("hush"),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

const runShellInput = z
  .object({
    command: z.string().min(1),
    bashExecutable: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    environment: z.record(z.string(), z.string()).optional(),
    outputMode: z.enum(PRODUCT_PROCESS_OUTPUT_MODES).default("hush"),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

const processRecovery = z
  .object({
    owner: z.literal("#719"),
    manifestId: z.string().min(1),
    artifactId: z.string().min(1),
    digest: z.string().min(1),
    byteLength: z.int().min(0),
    via: z.literal("loom-manifest"),
    claimsExactSource: z.literal(false),
    origin: z.string().nullable(),
    projections: z.tuple([
      z.literal("range"),
      z.literal("head-tail"),
      z.literal("search-hits"),
      z.literal("exact"),
    ]),
    lineage: z
      .object({
        invocationId: z.string().min(1),
        captureId: z.string().min(1),
        stream: z.enum(["stdout", "stderr"]),
        encoding: z.enum(["utf-8", "binary"]),
        availability: z.literal("available"),
      })
      .strict(),
  })
  .strict();

const processStreamOutput = z
  .object({
    byteCount: z.int().min(0),
    encoding: z.enum(["utf-8", "binary"]),
    completeInline: z.boolean(),
    omittedBytes: z.int().min(0),
    text: z.string().nullable(),
    recovery: processRecovery.nullable(),
  })
  .strict();

const processOutput = z
  .object({
    owner: z.literal("#796"),
    invocationId: z.string().min(1),
    captureId: z.string().min(1),
    outputMode: z.enum(PRODUCT_PROCESS_OUTPUT_MODES),
    origin: z.enum(["shell", "git", "test", "search", "process"]),
    process: z
      .object({
        stop: z.enum([
          "exited",
          "timed-out",
          "cancelled",
          "capture-exceeded:total",
          "capture-exceeded:artifact",
          "capture-exceeded:queue",
          "capture-exceeded:line",
          "capture-exceeded:inline",
          "capture-exceeded:encoding",
          "uncertain:artifact-ingest-failed",
          "uncertain:unconfirmed-exit",
        ]),
        exitCode: z.int().nullable(),
        signal: z.string().nullable(),
        durationMs: z.number().min(0),
        killStage: z.enum(["none", "terminate", "kill", "unconfirmed"]),
      })
      .strict(),
    stdout: processStreamOutput,
    stderr: processStreamOutput,
    projection: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("raw"),
          ordering: z.literal("per-stream"),
          complete: z.boolean(),
          fidelity: z.enum(["exact", "artifact-backed", "unavailable"]),
        })
        .strict(),
      z
        .object({
          kind: z.literal("hush"),
          text: z.string(),
          fidelity: z.enum(["exact", "deterministic-reduction", "raw-fallback"]),
          reduced: z.boolean(),
          reducer: z
            .object({
              id: z.string().min(1),
              version: z.string().min(1),
              strategy: z.enum(["specialized", "generic", "passthrough"]),
            })
            .strict(),
          omissions: z.array(
            z
              .object({
                kind: z.enum(["capped-bytes", "binary-stream", "reducer-failure"]),
                stream: z.enum(["stdout", "stderr", "both"]),
                count: z.int().min(0),
                detail: z.string().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
    ]),
    workspaceIndex: z.json().optional(),
    languageDiagnostics: z.json().optional(),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

function document(
  name: string,
  title: string,
  description: string,
  effect: ToolManifestDocument["effect"],
): ToolManifestDocument {
  return {
    namespace: "workspace",
    name,
    version: 1,
    source: "builtin",
    title,
    description,
    effect,
    capabilityKind: "process",
    platforms: [],
    limits: defaultToolLimits({ defaultTimeoutMs: 30_000 }),
    concurrency: defaultConcurrencyContract({ maxPerWorkspace: 4 }),
    resultProjection: defaultProjectionContract({ modelMaxBytes: MAX_PRODUCT_PROCESS_MODEL_BYTES }),
  };
}

function mustEntry(result: ReturnType<typeof createToolRegistryEntry>): ToolRegistryEntry {
  if (!result.ok) {
    throw new Error(`product process tool registration failed: ${result.error.code}`);
  }
  return result.value;
}

function failed(code: string): ToolInvocationOutcome {
  return { status: "failed", reason: code, effect: "none" };
}

function errorCode(error: { readonly code?: string; readonly kind?: string }): string {
  if (typeof error.code === "string") {
    return error.code;
  }
  if (typeof error.kind === "string") {
    return error.kind;
  }
  return "failed";
}

function parseOutputMode(value: unknown): ProductProcessOutputMode | null {
  if (value === undefined) {
    return "hush";
  }
  return value === "hush" || value === "raw" ? value : null;
}

function parseOrigin(value: unknown): HushOrigin | null {
  if (value === undefined) {
    return "process";
  }
  return typeof value === "string" && HUSH_ORIGINS.some((origin) => origin === value)
    ? (value as HushOrigin)
    : null;
}

function asStringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      return null;
    }
    record[key] = entry;
  }
  return record;
}

export type ProductProcessToolPorts = {
  readonly generation: ConfigurationGeneration;
  readonly capture: ProcessCapturePort;
  readonly workspaceCwd?: string;
  readonly artifacts?: ArtifactStorePort;
  readonly loom?: LoomPort;
  readonly workspaceId?: string;
  readonly sessionId?: string;
};

export type ProductProcessTools = {
  readonly owner: typeof PRODUCT_PROCESS_TOOLS_OWNER;
  readonly registry: ToolRegistry;
  readonly catalog: ToolCatalog;
  readonly runner: ToolRunnerPort;
  readonly toolNames: readonly string[];
};

/**
 * Compose builtin process/shell tools with Hush-ready capture results.
 */
export function composeProductProcessTools(ports: ProductProcessToolPorts): ProductProcessTools {
  const hush = createHushIntegrator({ capture: ports.capture });
  const defaultCwd = ports.workspaceCwd;

  const observeCommand = async (
    origin: HushOrigin,
    command: ProcessCaptureRequest,
    outputMode: ProductProcessOutputMode,
  ): Promise<
    | { readonly ok: true; readonly value: ProductProcessObservation }
    | { readonly ok: false; readonly error: HushObservationError }
  > => {
    if (outputMode === "hush") {
      return hush.observe({
        origin,
        command,
        strategy: "specialized",
        maxReducedBytes: MAX_PRODUCT_PROCESS_HUSH_BYTES,
      });
    }
    const captured = await ports.capture.run(command);
    if (!captured.ok) {
      return captured;
    }
    return {
      ok: true,
      value: { origin, capture: captured.value, hush: null, projection: null },
    };
  };

  const entries: ToolRegistryEntry[] = [
    mustEntry(
      createToolRegistryEntry(
        document(
          "run_process",
          "Run process",
          "Run an argv process. outputMode hush is the default; raw bypasses only reduction while capture, safety, redaction, bounds, and targeted Read recovery remain active",
          "mutation",
        ),
        { inputSchema: runProcessInput, outputSchema: processOutput },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "run_shell",
          "Run shell",
          "Run a Bash command. outputMode hush is the default; raw bypasses only reduction while capture, safety, redaction, bounds, and targeted Read recovery remain active",
          "mutation",
        ),
        { inputSchema: runShellInput, outputSchema: processOutput },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "open_pty",
          "Open PTY",
          "Interactive PTY sessions require a session-owned host; not opened from tool dispatch alone",
          "mutation",
        ),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
  ];

  const registryResult = createToolRegistry(ports.generation, entries);
  if (!registryResult.ok) {
    throw new Error(`product process tool registry failed: ${registryResult.error.code}`);
  }
  const registry = registryResult.value;

  const runner: ToolRunnerPort = {
    async execute(request: ToolRunnerRequest): Promise<ToolInvocationOutcome> {
      if (request.signal.aborted) {
        return { status: "cancelled", effect: "none" };
      }
      switch (request.toolName) {
        case "run_process": {
          const executable = request.input.executable;
          const argv = request.input.argv;
          if (typeof executable !== "string") {
            return failed("malformed-input");
          }
          if (!Array.isArray(argv) || !argv.every((item) => typeof item === "string")) {
            return failed("malformed-input");
          }
          const environment = asStringRecord(request.input.environment);
          if (environment === null) {
            return failed("malformed-input");
          }
          const cwd =
            typeof request.input.cwd === "string"
              ? request.input.cwd
              : defaultCwd === undefined
                ? undefined
                : defaultCwd;
          const timeoutMs =
            typeof request.input.timeoutMs === "number" ? request.input.timeoutMs : 30_000;
          const origin = parseOrigin(request.input.origin);
          const outputMode = parseOutputMode(request.input.outputMode);
          if (origin === null || outputMode === null) {
            return failed("malformed-input");
          }
          const observed = await observeCommand(
            origin,
            {
              mode: "argv",
              executable,
              argv: argv as readonly string[],
              environment,
              ...(cwd === undefined ? {} : { cwd }),
              timeoutMs: duration(timeoutMs),
              maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
              invocationId: request.invocationId,
              ...(outputMode === "raw"
                ? { maxInlineBytes: MAX_PRODUCT_PROCESS_RAW_INLINE_BYTES }
                : {}),
              signal: request.signal,
            },
            outputMode,
          );
          if (!observed.ok) {
            return failed(errorCode(observed.error));
          }
          return projectProductProcessOutput({
            observation: observed.value,
            invocationId: request.invocationId,
            outputMode,
            ports: {
              generation: Number(ports.generation),
              ...(ports.artifacts === undefined ? {} : { artifacts: ports.artifacts }),
              ...(ports.loom === undefined ? {} : { loom: ports.loom }),
              ...(ports.workspaceId === undefined ? {} : { workspaceId: ports.workspaceId }),
              ...(ports.sessionId === undefined ? {} : { sessionId: ports.sessionId }),
            },
            signal: request.signal,
          });
        }
        case "run_shell": {
          const command = request.input.command;
          if (typeof command !== "string") {
            return failed("malformed-input");
          }
          const environment = asStringRecord(request.input.environment);
          if (environment === null) {
            return failed("malformed-input");
          }
          const bashExecutable =
            typeof request.input.bashExecutable === "string"
              ? request.input.bashExecutable
              : "/bin/bash";
          const cwd =
            typeof request.input.cwd === "string"
              ? request.input.cwd
              : defaultCwd === undefined
                ? undefined
                : defaultCwd;
          const timeoutMs =
            typeof request.input.timeoutMs === "number" ? request.input.timeoutMs : 30_000;
          const outputMode = parseOutputMode(request.input.outputMode);
          if (outputMode === null) {
            return failed("malformed-input");
          }
          const observed = await observeCommand(
            "shell",
            {
              mode: "bash",
              executable: bashExecutable,
              command,
              environment,
              ...(cwd === undefined ? {} : { cwd }),
              timeoutMs: duration(timeoutMs),
              maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
              invocationId: request.invocationId,
              ...(outputMode === "raw"
                ? { maxInlineBytes: MAX_PRODUCT_PROCESS_RAW_INLINE_BYTES }
                : {}),
              signal: request.signal,
            },
            outputMode,
          );
          if (!observed.ok) {
            return failed(errorCode(observed.error));
          }
          return projectProductProcessOutput({
            observation: observed.value,
            invocationId: request.invocationId,
            outputMode,
            ports: {
              generation: Number(ports.generation),
              ...(ports.artifacts === undefined ? {} : { artifacts: ports.artifacts }),
              ...(ports.loom === undefined ? {} : { loom: ports.loom }),
              ...(ports.workspaceId === undefined ? {} : { workspaceId: ports.workspaceId }),
              ...(ports.sessionId === undefined ? {} : { sessionId: ports.sessionId }),
            },
            signal: request.signal,
          });
        }
        case "open_pty":
          return {
            status: "unavailable",
            reason:
              "interactive PTY sessions are not opened from tool dispatch alone; attach a session-owned PTY host (#712)",
            effect: "none",
          };
        default:
          return {
            status: "unavailable",
            reason: `unknown product process tool: ${request.toolName}`,
            effect: "none",
          };
      }
    },
  };

  return {
    owner: PRODUCT_PROCESS_TOOLS_OWNER,
    registry,
    catalog: registry.catalog,
    runner,
    toolNames: entries.map((entry) => entry.descriptor.name),
  };
}
