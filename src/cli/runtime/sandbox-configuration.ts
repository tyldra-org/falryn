import { z } from "zod";
import { type ConfigurationKeyDeclaration, objectKey } from "../../config/index.ts";
import {
  type ConfigurationGenerationRecord,
  type ConfigurationValues,
  isUnreadSource,
} from "../../domain/configuration/index.ts";
import {
  OFFLINE_SANDBOX_NETWORK,
  SANDBOX_MODES,
  SINGLE_PROCESS_SANDBOX,
  sandboxExpansionSchema,
} from "../../domain/security/sandbox.ts";
import { createHostSandbox, type HostSandbox } from "../../integrations/security/host-sandbox.ts";

export const SANDBOX_CONFIGURATION_KEY = "tools.sandbox";
export const sandboxConfigurationSchema = sandboxExpansionSchema.extend({
  version: z.literal(1),
  mode: z.enum(SANDBOX_MODES),
});
export const DEFAULT_SANDBOX_CONFIGURATION = {
  version: 1,
  mode: "off",
  readRoots: [],
  writeRoots: [],
} as const;
export const SANDBOX_CONFIGURATION_KEYS: readonly ConfigurationKeyDeclaration[] = [
  objectKey({
    path: SANDBOX_CONFIGURATION_KEY,
    summary:
      "OS sandbox policy. The off compatibility default provides no OS isolation; strict fails closed when unavailable.",
    objectSchema: sandboxConfigurationSchema,
    defaultValue: { version: 1, mode: "off", readRoots: [], writeRoots: [] },
    scopes: ["user"],
    applicationClass: "next-operation",
    sensitivity: "public",
  }),
];

export function createProductSandbox(input: {
  readonly values: () => ConfigurationValues;
  readonly configuration?: () => ConfigurationGenerationRecord | null;
  readonly now: () => number;
  readonly generation: () => number;
  readonly workspaceRoot: string | null;
}): HostSandbox {
  return createHostSandbox({
    now: input.now,
    policy() {
      if (input.configuration !== undefined) {
        const record = input.configuration();
        if (record === null || record.sources.some(isUnreadSource))
          throw new Error("sandbox-configuration-unavailable");
      }
      const configured = sandboxConfigurationSchema.parse(
        input.values()[SANDBOX_CONFIGURATION_KEY] ?? DEFAULT_SANDBOX_CONFIGURATION,
      );
      return {
        generation: input.generation(),
        mode: configured.mode,
        authority: configured.mode === "off" ? "installation-compatibility" : "user",
        boundary: {
          readRoots: configured.readRoots,
          writeRoots: [
            ...(input.workspaceRoot === null ? [] : [input.workspaceRoot]),
            ...configured.writeRoots,
          ],
          network: OFFLINE_SANDBOX_NETWORK,
          processes: SINGLE_PROCESS_SANDBOX,
          lifecyclePaths: [],
        },
      };
    },
  });
}

/** Read-only diagnosis uses the normal user-file loader and performs no launch. */
export async function inspectProductSandbox(graph: import("./services.ts").Services) {
  await graph.loader.load({
    configurationRoot: graph.configurationRoot,
    legacyConfigurationRoot: graph.legacyConfigurationRoot,
    workspaceRoot: null,
    profile: null,
    overrides: {},
  });
  const record = graph.loader.current();
  const parsed =
    record === null || record.sources.some(isUnreadSource)
      ? null
      : sandboxConfigurationSchema.safeParse(record.values[SANDBOX_CONFIGURATION_KEY]);
  const mode = parsed?.success ? parsed.data.mode : null;
  const sandbox = createProductSandbox({
    values: () => record?.values ?? {},
    configuration: () => record,
    generation: () => Number(record?.generation ?? 0),
    now: () => Number(graph.clock.now()),
    workspaceRoot: graph.workspaceRoot,
  });
  return {
    requestedMode: mode,
    probe: sandbox.probe(),
    description:
      mode === null
        ? "Sandbox policy unavailable; executable workspace operations are refused."
        : mode === "off"
          ? "Sandbox off: no OS filesystem, network or process isolation."
          : mode === "degraded"
            ? "Sandbox unavailable: no weaker boundary is qualified."
            : "Strict requires the qualified offline, single-process boundary; unsupported launches are refused.",
    trustedHostAuthentication:
      "off: operating-system vault and provider-login helpers run under trusted host policy, outside workspace isolation.",
  };
}
