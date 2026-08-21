/**
 * Product process tools (#712): shell, process capture, Hush-ready results.
 *
 * Adapts {@link ProcessCapturePort} and {@link createHushIntegrator} so model
 * tool calls return capture reports plus Hush projections without bypassing the
 * pipeline. Interactive PTY start remains unavailable from tool dispatch alone.
 * Git/LSP/DAP stay #713–#714.
 */

import { z } from "zod";

import type {
  ConfigurationGeneration,
  ProcessCapturePort,
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
import { createHushIntegrator } from "./hush.ts";
import { projectHushForHarness } from "./product-hush-projection.ts";
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
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

const runShellInput = z
  .object({
    command: z.string().min(1),
    bashExecutable: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    environment: z.record(z.string(), z.string()).optional(),
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
    resultProjection: defaultProjectionContract(),
  };
}

function mustEntry(result: ReturnType<typeof createToolRegistryEntry>): ToolRegistryEntry {
  if (!result.ok) {
    throw new Error(`product process tool registration failed: ${result.error.code}`);
  }
  return result.value;
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    return { ok: false, reason: "unserializable" };
  }
  const parsed: unknown = JSON.parse(encoded);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: parsed as unknown };
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function failed(code: string): ToolInvocationOutcome {
  return { status: "failed", reason: code, effect: "none" };
}

function completed(value: unknown): ToolInvocationOutcome {
  return { status: "completed", output: jsonRecord(value), effect: "completed" };
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

  const entries: ToolRegistryEntry[] = [
    mustEntry(
      createToolRegistryEntry(
        document(
          "run_process",
          "Run process",
          "Run an argv process with capture and a Hush-ready projection",
          "mutation",
        ),
        { inputSchema: runProcessInput, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "run_shell",
          "Run shell",
          "Run a Bash command with capture and a Hush-ready projection",
          "mutation",
        ),
        { inputSchema: runShellInput, outputSchema: openObject },
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
          const origin =
            typeof request.input.origin === "string" ? request.input.origin : "process";
          const observed = await hush.observe({
            origin,
            command: {
              mode: "argv",
              executable,
              argv: argv as readonly string[],
              environment,
              ...(cwd === undefined ? {} : { cwd }),
              timeoutMs: duration(timeoutMs),
              maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
              signal: request.signal,
            },
          });
          if (!observed.ok) {
            return failed(errorCode(observed.error));
          }
          return completed({
            origin: observed.value.origin,
            projection: observed.value.projection,
            harness: projectHushForHarness(observed.value),
            hush: observed.value.hush,
            capture: {
              stop: observed.value.capture.stop,
              exit: observed.value.capture.exit,
              stdout: {
                byteCount: observed.value.capture.stdout.byteCount,
                truncated: observed.value.capture.stdout.truncated,
                inlineText: observed.value.capture.stdout.inlineText,
              },
              stderr: {
                byteCount: observed.value.capture.stderr.byteCount,
                truncated: observed.value.capture.stderr.truncated,
                inlineText: observed.value.capture.stderr.inlineText,
              },
            },
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
          const observed = await hush.observe({
            origin: "shell",
            command: {
              mode: "bash",
              executable: bashExecutable,
              command,
              environment,
              ...(cwd === undefined ? {} : { cwd }),
              timeoutMs: duration(timeoutMs),
              maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
              signal: request.signal,
            },
          });
          if (!observed.ok) {
            return failed(errorCode(observed.error));
          }
          return completed({
            origin: observed.value.origin,
            projection: observed.value.projection,
            harness: projectHushForHarness(observed.value),
            hush: observed.value.hush,
            capture: {
              stop: observed.value.capture.stop,
              exit: observed.value.capture.exit,
              stdout: {
                byteCount: observed.value.capture.stdout.byteCount,
                truncated: observed.value.capture.stdout.truncated,
                inlineText: observed.value.capture.stdout.inlineText,
              },
              stderr: {
                byteCount: observed.value.capture.stderr.byteCount,
                truncated: observed.value.capture.stderr.truncated,
                inlineText: observed.value.capture.stderr.inlineText,
              },
            },
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
