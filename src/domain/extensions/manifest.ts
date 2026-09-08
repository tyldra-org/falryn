/** Static declarations are upper bounds and never executable admission. */
import { z } from "zod";
import { isDeclarationSchema } from "./declaration-schema.ts";
import { dependencySchema, versionRangeSchema } from "./dependencies.ts";
import {
  BEHAVIOR_FAMILIES,
  digestSchema,
  EXTENSION_SCOPES,
  identityText,
  NATIVE_CONTRIBUTION_KINDS,
  relativePathSchema,
} from "./identity.ts";

export const PORTABLE_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const PORTABLE_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
export const FALRYN_EXTENSION_NAMESPACE = "org.tyldra.falryn";
export const portableNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);
export const portableManifestSchema = z
  .object({
    $schema: z.literal(PORTABLE_PLUGIN_SCHEMA),
    name: portableNameSchema,
    version: z.string().optional(),
    description: z.string().optional(),
    author: z
      .strictObject({
        name: z.string().optional(),
        email: z.string().optional(),
        url: z.string().optional(),
      })
      .optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    extensions: z.unknown().optional(),
  })
  .catchall(z.unknown());
const names = z.array(identityText).max(256);
const contributionName = identityText.refine((value) => !/[\\/]/u.test(value));
const schemaObject = z.record(z.string(), z.unknown()).refine(isDeclarationSchema);
const effects = z.array(z.enum(["observation", "mutation", "external", "interactive"])).max(4);
export const integrityFileSchema = z.strictObject({
  path: relativePathSchema,
  digest: digestSchema,
});
const compatibility = z.strictObject({
  falryn: versionRangeSchema.optional(),
  bun: versionRangeSchema.optional(),
  os: z
    .array(z.enum(["darwin", "linux", "win32"]))
    .max(3)
    .default([]),
  arch: z
    .array(z.enum(["arm64", "x64"]))
    .max(2)
    .default([]),
});
const resources = z.strictObject({
  startupMs: z.int().positive().max(30_000),
  requestMs: z.int().positive().max(1_800_000),
  shutdownMs: z.int().positive().max(30_000),
  maxOutputBytes: z.int().positive().max(16_777_216),
  maxConcurrent: z.int().positive().max(64),
});
const execution = z.strictObject({
  mode: z.enum(["governed", "full-user"]),
  executable: relativePathSchema,
  helpers: z.array(integrityFileSchema).max(256).default([]),
  argv: z.array(z.string().max(4_096)).max(256).default([]),
  cwd: relativePathSchema.optional(),
  loader: z.enum(["native", "bun", "node", "python", "protocol"]),
  protocolVersion: identityText,
  expectedChildren: names.default([]),
  hostIntegrations: names.default([]),
  compatibility,
  resources,
});
const authority = z.strictObject({
  effects,
  permissions: names,
  roots: names,
  destinations: names,
  secretReferences: names,
  localData: names,
});
const batch = z.strictObject({
  version: z.literal(1),
  nativeBatch: z.boolean(),
  concurrencyScope: z.enum(["serial", "process", "workspace", "session", "independent"]),
  background: z.boolean(),
});
const moduleOperation = z.strictObject({
  id: identityText,
  family: z.enum(BEHAVIOR_FAMILIES),
  inputSchema: schemaObject,
  outputSchema: schemaObject,
  effects,
  permissions: names,
});
const moduleDeclaration = z.strictObject({
  version: z.literal(1),
  moduleVersion: identityText,
  operations: z.array(moduleOperation).min(1).max(64),
  actions: names,
  instanceSchema: schemaObject,
  statusSchema: schemaObject,
  hostServices: z
    .array(
      z.enum([
        "model",
        "tool",
        "task",
        "join",
        "cancel",
        "configuration",
        "state",
        "artifact",
        "schedule",
        "mailbox",
        "identity",
        "clock",
        "diagnostics",
        "progress",
        "presentation",
      ]),
    )
    .max(32),
  resources,
  presentationSlots: names,
});
export const contributionDeclarationSchema = z
  .strictObject({
    kind: z.enum(NATIVE_CONTRIBUTION_KINDS),
    namespace: contributionName,
    id: contributionName,
    description: z.string().max(4_096),
    path: relativePathSchema.optional(),
    resources: z.array(relativePathSchema).max(256).default([]),
    aliases: names.default([]),
    dependencies: names.default([]),
    family: z.enum(BEHAVIOR_FAMILIES).optional(),
    purpose: z.enum(["operation", "lifecycle"]).default("operation"),
    inputSchema: schemaObject.optional(),
    outputSchema: schemaObject.optional(),
    authority,
    compatibility: compatibility.optional(),
    execution: execution.optional(),
    configuration: names.default([]),
    state: names.default([]),
    presentationSlots: names.default([]),
    module: moduleDeclaration.optional(),
    batching: batch.optional(),
  })
  .superRefine((value, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: "custom", message });
    const inert = [
      "skill",
      "instruction",
      "rule",
      "template",
      "asset",
      "prompt",
      "mcp-resource",
      "mcp-prompt",
      "keymap",
      "settings",
      "help",
    ];
    if (
      inert.includes(value.kind) &&
      (value.execution !== undefined || value.family !== undefined || value.batching !== undefined)
    )
      reject("declarative-execution");
    if (value.family === "capability" && value.purpose !== "lifecycle")
      reject("invalid-capability-family");
    if (
      ["agent", "subagent", "workflow", "automation"].includes(value.kind) &&
      value.family !== undefined &&
      value.family !== "delegate"
    )
      reject("invalid-delegate-family");
    if (value.execution !== undefined && value.authority.effects.length === 0)
      reject("missing-effect-declaration");
    if (
      value.kind === "capability-module" &&
      (value.module === undefined || value.execution === undefined)
    )
      reject("missing-module-contract");
    if (value.kind !== "capability-module" && value.module !== undefined)
      reject("cross-kind-module");
    if (
      value.module !== undefined &&
      new Set(value.module.operations.map((operation) => operation.id)).size !==
        value.module.operations.length
    )
      reject("duplicate-module-operation");
    if (value.batching?.background && value.execution === undefined)
      reject("background-without-execution");
    if (
      value.family !== undefined &&
      (value.inputSchema === undefined || value.outputSchema === undefined)
    )
      reject("missing-model-contract");
    if (value.family === "edit" && !value.authority.effects.includes("mutation"))
      reject("dishonest-edit-effect");
    if (value.module !== undefined) {
      const operations = new Set(value.module.operations.map((operation) => operation.id));
      if (value.module.actions.some((action) => !operations.has(action)))
        reject("unknown-module-action");
      if (
        value.module.operations.some(
          (operation) =>
            operation.effects.some((effect) => !value.authority.effects.includes(effect)) ||
            operation.permissions.some(
              (permission) => !value.authority.permissions.includes(permission),
            ),
        )
      )
        reject("module-authority-exceeds-declaration");
      if (
        value.module.operations.some(
          (operation) => operation.family === "capability" && value.purpose !== "lifecycle",
        )
      )
        reject("invalid-module-capability-family");
      if (value.module.presentationSlots.some((slot) => !value.presentationSlots.includes(slot)))
        reject("module-slot-exceeds-declaration");
      const executionResources = value.execution?.resources;
      if (
        executionResources !== undefined &&
        Object.entries(value.module.resources).some(
          ([key, limit]) => limit > executionResources[key as keyof typeof value.module.resources],
        )
      )
        reject("module-resource-exceeds-declaration");
    }
  });
const stateFamily = z.strictObject({
  id: identityText,
  schema: schemaObject,
  scope: z.enum(EXTENSION_SCOPES),
  sensitivity: z.enum(["public", "sensitive", "restricted"]),
  application: z.enum(["next-invocation", "new-generation", "restart"]),
  maxBytes: z.int().nonnegative().max(67_108_864),
  compatibility: versionRangeSchema,
  retention: z.enum(["session", "until-uninstall", "preserve"]),
  cleanup: z.enum(["remove", "preserve", "confirm"]),
});
export const falrynManifestSchema = z.strictObject({
  version: z.literal(1),
  packageId: identityText.optional(),
  contributions: z.array(contributionDeclarationSchema).max(1_024).default([]),
  dependencies: z.array(dependencySchema).max(256).default([]),
  compatibility: compatibility.optional(),
  scopes: z.array(z.enum(EXTENSION_SCOPES)).max(5).default([]),
  files: z.array(integrityFileSchema).max(4_096).default([]),
  configuration: z.array(stateFamily).max(128).default([]),
  state: z.array(stateFamily).max(128).default([]),
});
export type ContributionDeclaration = z.infer<typeof contributionDeclarationSchema>;
export type FalrynManifest = z.infer<typeof falrynManifestSchema>;
export type PortableManifest = z.infer<typeof portableManifestSchema>;

export const portableMcpServerSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("stdio"),
    command: z.string().min(1).max(1_024),
    args: z.array(z.string()).max(256).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("streamable-http"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.strictObject({
    type: z.literal("sse"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);
